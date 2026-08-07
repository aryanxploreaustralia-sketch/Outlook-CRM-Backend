/**
 * Credential lifecycle for every provider.
 *
 * ## The governing rule: delegate, never duplicate
 *
 * For Microsoft, MSAL owns the tokens. This manager does not read them, copy
 * them or decide when they expire — it asks MSAL, and MSAL decides. Entra ID
 * rotates refresh tokens on every redemption, so a second copy anywhere would be
 * stale from the moment MSAL refreshed, and would fail intermittently with
 * `invalid_grant`. The `ProviderToken` record is therefore metadata: what
 * happened, when, and whether it worked.
 *
 * That is also why `refreshToken()` here does not implement a refresh. It asks
 * the adapter to perform one and records the result. The adapter — which owns
 * the SDK — knows how.
 *
 * ## Expiry is advisory, not authoritative
 *
 * `expiresAt` is used to decide whether a *pre-emptive* refresh is worth
 * attempting. It is never used to conclude a token is unusable: clock skew
 * between this server and the identity provider is real, and refusing to try a
 * token because a local clock says it expired would break sending for a mailbox
 * that is working perfectly.
 */

import { ProviderToken } from '../../../models/providerToken.model.js'
import {
  CONNECTION_STATUS,
  PROVIDER_TYPES,
} from '../constants/providerTypes.js'
import { PROVIDER_ERROR_CODES, ProviderError } from '../constants/providerErrors.js'
import { withRetry } from '../utils/retry.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('token-manager')

/**
 * Refresh this long before expiry.
 *
 * Five minutes comfortably exceeds any plausible clock skew and any request
 * duration, so a token handed out is still valid when it arrives.
 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000

/**
 * Consecutive failures after which refreshing stops being attempted.
 *
 * Without a ceiling, a permanently revoked grant would be retried on every sync
 * forever — burning quota and filling the log with an error whose only fix is
 * the user signing in again.
 */
export const MAX_REFRESH_FAILURES = 5

export class TokenManager {
  /**
   * @param {object} [dependencies] Injected so tests can substitute the model
   *   without a database.
   */
  constructor({ tokenModel = ProviderToken } = {}) {
    this.tokenModel = tokenModel
  }

  /**
   * Finds or creates the credential record for a mailbox.
   *
   * @param {object} params
   * @param {object} params.mailbox
   * @param {string} params.provider
   * @returns {Promise<object>}
   */
  async ensureRecord({ mailbox, provider }) {
    const existing = await this.tokenModel.findOne({ mailbox: mailbox._id, provider })
    if (existing) return existing

    return this.tokenModel.create({
      user: mailbox.user,
      mailbox: mailbox._id,
      provider,
      // Microsoft credentials stay in MSAL's cache; this points at it.
      msalAccountRef:
        provider === PROVIDER_TYPES.MICROSOFT_GRAPH ? (mailbox.sourceAccount ?? null) : null,
      status: CONNECTION_STATUS.DISCONNECTED,
    })
  }

  /**
   * Reports whether a refresh is worth attempting now.
   *
   * @param {object} record
   * @returns {{ shouldRefresh: boolean, reason: string }}
   */
  evaluate(record) {
    if (!record) {
      return { shouldRefresh: false, reason: 'no_record' }
    }

    if (record.refreshFailureCount >= MAX_REFRESH_FAILURES) {
      return { shouldRefresh: false, reason: 'failure_ceiling_reached' }
    }

    if (record.status === CONNECTION_STATUS.DISCONNECTED) {
      return { shouldRefresh: false, reason: 'not_connected' }
    }

    if (!record.expiresAt) {
      // No expiry recorded yet — the adapter is the only thing that can tell us,
      // so let it try rather than assuming either way.
      return { shouldRefresh: true, reason: 'expiry_unknown' }
    }

    if (record.isExpired(REFRESH_SKEW_MS)) {
      return { shouldRefresh: true, reason: 'expiring_within_skew' }
    }

    return { shouldRefresh: false, reason: 'still_valid' }
  }

  /**
   * Refreshes credentials through the adapter and records the outcome.
   *
   * Retries only transient failures — `withRetry` consults `ProviderError`'s own
   * classification, so a revoked consent fails immediately rather than three
   * times.
   *
   * @param {object} params
   * @param {import('../interfaces/EmailProvider.js').EmailProvider} params.provider
   * @param {object} params.mailbox
   * @param {boolean} [params.force] Refresh even when the token looks valid.
   * @returns {Promise<{ refreshed: boolean, reason: string, expiresAt: ?Date }>}
   */
  async refresh({ provider, mailbox, force = false }) {
    const record = await this.ensureRecord({ mailbox, provider: provider.type })
    const evaluation = this.evaluate(record)

    if (!force && !evaluation.shouldRefresh) {
      return { refreshed: false, reason: evaluation.reason, expiresAt: record.expiresAt }
    }

    if (record.refreshFailureCount >= MAX_REFRESH_FAILURES) {
      throw new ProviderError(
        PROVIDER_ERROR_CODES.TOKEN_REFRESH_FAILED,
        'This mailbox has failed to refresh too many times and needs to be reconnected.',
        { provider: provider.type },
      )
    }

    try {
      const result = await withRetry(() => provider.refreshToken({ mailbox }), {
        label: `${provider.type} refreshToken`,
        maxAttempts: 3,
      })

      record.expiresAt = result.expiresAt ?? null
      record.scope = result.scope ?? record.scope
      record.status = CONNECTION_STATUS.CONNECTED
      record.lastRefresh = new Date()
      record.refreshFailureCount = 0
      record.lastError = { code: null, message: null, occurredAt: null }
      await record.save()

      log.info('Credentials refreshed', {
        provider: provider.type,
        mailboxId: mailbox._id.toString(),
        expiresAt: record.expiresAt,
      })

      return { refreshed: true, reason: evaluation.reason, expiresAt: record.expiresAt }
    } catch (error) {
      record.refreshFailureCount += 1
      record.lastError = {
        code: error?.code ?? PROVIDER_ERROR_CODES.UNKNOWN,
        message: error?.message ?? String(error),
        occurredAt: new Date(),
      }

      // A fatal error means re-authentication is required; a transient one means
      // the credentials may still be fine and the next run should try again.
      record.status =
        error instanceof ProviderError && error.isFatal
          ? CONNECTION_STATUS.EXPIRED
          : CONNECTION_STATUS.DEGRADED

      await record.save()

      log.warn('Credential refresh failed', {
        provider: provider.type,
        mailboxId: mailbox._id.toString(),
        code: record.lastError.code,
        failureCount: record.refreshFailureCount,
      })

      throw error
    }
  }

  /**
   * Guarantees usable credentials before an operation runs.
   *
   * Called by the sync engine at the start of a run so a mid-run expiry cannot
   * fail half the folders.
   *
   * @param {object} params
   * @returns {Promise<object>} The credential record.
   */
  async ensureValid({ provider, mailbox }) {
    const record = await this.ensureRecord({ mailbox, provider: provider.type })
    const evaluation = this.evaluate(record)

    if (evaluation.shouldRefresh) {
      await this.refresh({ provider, mailbox })
      return this.tokenModel.findById(record._id)
    }

    return record
  }

  /**
   * Records the outcome of a connection attempt.
   *
   * @param {object} params
   * @returns {Promise<object>}
   */
  async recordConnection({ mailbox, provider, status, scope = [], expiresAt = null }) {
    const record = await this.ensureRecord({ mailbox, provider })

    record.status = status
    record.scope = scope.length > 0 ? scope : record.scope
    record.expiresAt = expiresAt
    record.lastRefresh = new Date()

    if (status === CONNECTION_STATUS.CONNECTED) {
      record.refreshFailureCount = 0
      record.lastError = { code: null, message: null, occurredAt: null }
    }

    await record.save()
    return record
  }

  /**
   * Marks credentials unusable on disconnect.
   *
   * The record is kept rather than deleted so the history of a connection —
   * when it was last valid, why it stopped — survives for support purposes.
   */
  async revoke({ mailbox, provider, reason = 'disconnected' }) {
    const record = await this.tokenModel.findOne({ mailbox: mailbox._id, provider })
    if (!record) return null

    record.status = CONNECTION_STATUS.DISCONNECTED
    record.accessToken = null
    record.refreshToken = null
    record.expiresAt = null
    record.lastError = { code: reason, message: null, occurredAt: new Date() }
    await record.save()

    log.info('Credentials revoked', { provider, mailboxId: mailbox._id.toString(), reason })

    return record
  }
}

/** Shared instance. Stateless, so one is sufficient. */
export const tokenManager = new TokenManager()

export default tokenManager
