/**
 * Orchestration for the provider API.
 *
 * Sits between controllers and the moving parts — registry, token manager, sync
 * engine, repositories — so the controllers stay HTTP-shaped and this module
 * holds the sequencing.
 *
 * Everything here is provider-independent. The only reference to Microsoft in
 * this file is the *default* provider type used when a caller does not name one.
 */

import { config } from '../../../config/index.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { OutlookAccount } from '../../../models/outlookAccount.model.js'
import { ProviderToken } from '../../../models/providerToken.model.js'
import { SyncHistory } from '../../../models/syncHistory.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { CONNECTION_STATUS, PROVIDER_TYPES } from '../constants/providerTypes.js'
import { SYNCABLE_FOLDERS } from '../constants/folderTypes.js'
import { SYNC_MODE, SYNC_TRIGGER } from '../constants/syncStatus.js'
import { ProviderError } from '../constants/providerErrors.js'
import * as mailboxRepo from '../repositories/mailbox.repository.js'
import * as syncRepo from '../repositories/syncState.repository.js'
import { providerRegistry } from './providerRegistry.js'
import { syncEngine } from './syncEngine.js'
import { tokenManager } from './tokenManager.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('provider-service')

/**
 * Loads a mailbox and the adapter that serves it.
 *
 * The single entry point for "give me something I can call provider methods on",
 * so mock fallback is applied consistently and cannot be forgotten at one call
 * site. Every mail-dependent operation in the application — compose, campaigns,
 * the morning introduction, reply sync, the template test send — reaches Graph
 * through here, which is why teaching *this* function about multiple mailboxes
 * was enough to make the whole application multi-mailbox.
 *
 * ## Which mailbox
 *
 * `mailboxId` when the caller names one, otherwise the workspace default. The
 * named case is always scoped by `user` inside the repository, so an id from
 * another workspace resolves to nothing rather than to a mailbox — the
 * cross-workspace check is the lookup itself, not a separate step a call site
 * could forget.
 *
 * @param {object} params
 * @param {object} params.auth `req.auth`
 * @param {?string} [params.mailboxId] Send from this mailbox specifically.
 * @param {boolean} [params.createIfMissing] Materialise a mailbox from the
 *   Phase 2 `OutlookAccount` when none exists yet.
 * @returns {Promise<{ mailbox: ?object, provider: object, type: string, isMock: boolean, fallbackReason: ?string }>}
 */
export async function resolveContext({ auth, mailboxId = null, createIfMissing = false }) {
  const user = auth?.user

  if (!user) {
    throw ApiError.unauthorized('You must sign in to use provider features.')
  }

  let mailbox = await mailboxRepo.findMailbox({ user: user._id, mailboxId })

  /**
   * A named mailbox that does not resolve is an error, never a silent fallback.
   *
   * Falling through to the default here would mean a user who picked
   * `sales@…` in the Send From box could have their message go out from
   * `enquiry@…` because the id was stale — the message would be sent, reported
   * as successful, and be wrong in the one way the recipient can see. It is
   * also what would turn a cross-workspace id into an accidental send rather
   * than a refusal.
   */
  if (mailboxId && !mailbox) {
    throw ApiError.notFound('That mailbox does not exist, or is not yours to send from.')
  }

  /**
   * Adopt the existing Phase 2 connection.
   *
   * A user who signed in during Phase 2 has an `OutlookAccount` but no
   * `Mailbox`. Materialising one from it means Phase 5 works immediately for
   * existing users rather than requiring them to reconnect — which would be a
   * breaking change dressed up as a new feature.
   */
  if (!mailbox && createIfMissing) {
    const account = auth.outlookAccount ?? (await OutlookAccount.findOne({ user: user._id }))

    /**
     * A grant that already has a mailbox is not missing one.
     *
     * The upsert below keys on `(user, provider, providerAccountId)` using
     * MSAL's `homeAccountId`. Rows written by the pre-13.2 connect path carry
     * the Graph `/me` id instead — a different string for the same mailbox — so
     * the upsert found no match and inserted a *second* row for a mailbox that
     * was already registered. Every status request that omitted a mailbox id
     * did it again, so the registry grew on read.
     *
     * `sourceAccount` is the reliable identity: it points at the OAuth grant,
     * and one grant is one mailbox regardless of which key the row was written
     * with. Checking it first makes adoption idempotent for both key styles,
     * without having to rewrite historical rows for correctness — the repair
     * script canonicalises them for tidiness, not to make this work.
     */
    if (account) {
      const linked = await Mailbox.findOne({ user: user._id, sourceAccount: account._id })

      if (linked) {
        mailbox = linked
      } else {
        mailbox = await mailboxRepo.upsertMailbox({
          user: user._id,
          provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
          providerAccountId: account.homeAccountId,
          emailAddress: account.email,
          displayName: user.displayName,
          sourceAccount: account._id,
        })

        /**
         * A workspace that has exactly one mailbox has a default, always.
         *
         * Without this, adopting a Phase 2 connection would leave `isDefault`
         * false and every unattended send would depend on the "newest
         * connected" fallback instead of a recorded decision. Idempotent, so
         * running it on every adoption costs one indexed read.
         */
        await mailboxRepo.ensureDefaultMailbox({ user: user._id })

        log.info('Adopted an existing Microsoft connection as a mailbox', {
          mailboxId: mailbox._id.toString(),
        })
      }
    }
  }

  const resolved = providerRegistry.resolve({ mailbox })

  return { mailbox, ...resolved }
}

/**
 * Every mailbox a background reader should visit, each with its own adapter.
 *
 * The multi-mailbox counterpart to `resolveContext`, and deliberately a
 * separate function rather than an option on it. The two answer different
 * questions: `resolveContext` asks *which one mailbox does this operation act
 * on* — a send has exactly one sender — whereas this asks *which mailboxes
 * should be read*, and the answer is legitimately all of them.
 *
 * Adapters are resolved per mailbox, so a workspace can hold a real Microsoft
 * mailbox and a mock one and each is driven by the right code.
 *
 * @param {object} params
 * @param {object} params.auth `req.auth`, or `{ user }` from a worker.
 * @returns {Promise<Array<{ mailbox: object, provider: object, type: string, isMock: boolean }>>}
 */
export async function listSyncableMailboxes({ auth }) {
  const user = auth?.user

  if (!user) {
    throw ApiError.unauthorized('You must sign in to use provider features.')
  }

  // `createIfMissing` adopts a Phase 2 connection that has no `Mailbox` yet, so
  // an installation that has never called the provider API still syncs.
  await resolveContext({ auth, createIfMissing: true })

  const mailboxes = await mailboxRepo.listMailboxes({ user: user._id, connectedOnly: true })

  return mailboxes
    // `syncEnabled` lets an operator keep a mailbox for sending without the CRM
    // ingesting its inbox. Defaults true, so nothing that predates it changes.
    .filter((mailbox) => mailbox.syncEnabled !== false)
    .map((mailbox) => ({ mailbox, ...providerRegistry.resolve({ mailbox }) }))
}

/**
 * `GET /provider/status`.
 *
 * Never throws for an unconfigured deployment — reporting "not connected, mock
 * mode" is a successful answer the UI needs on first load.
 */
export async function getStatus({ auth, mailboxId = null }) {
  const { mailbox, provider, isMock, fallbackReason } = await resolveContext({
    auth,
    mailboxId,
    /**
     * Adoption only applies when no mailbox was named.
     *
     * Materialising a Phase 2 connection is the right answer to "this workspace
     * appears to have nothing"; it is the wrong answer to "show me mailbox X",
     * where the honest reply for an id that does not resolve is a refusal, which
     * `resolveContext` already gives.
     */
    createIfMissing: !mailboxId,
  })

  /**
   * Every mailbox in the workspace, for the selector.
   *
   * Returned from `/status` rather than requiring a second request, because the
   * page cannot render its selector without it and two round trips would make
   * the list and the selected mailbox briefly disagree.
   */
  const mailboxes = (await mailboxRepo.listMailboxes({ user: auth.user._id })).map((box) =>
    box.toPublicJSON(),
  )

  if (!mailbox) {
    return {
      mailbox: null,
      mailboxes,
      token: null,
      states: [],
      lastRun: null,
      isMock: true,
      fallbackReason: fallbackReason ?? 'no_mailbox',
      capabilities: [...provider.capabilities],
      availableProviders: providerRegistry.available,
    }
  }

  const [token, states, lastRun] = await Promise.all([
    ProviderToken.findOne({ mailbox: mailbox._id, provider: mailbox.provider }),
    syncRepo.listStates({ user: auth.user._id, mailboxId: mailbox._id }),
    SyncHistory.findOne({ mailbox: mailbox._id }).sort({ startedAt: -1 }),
  ])

  return {
    mailbox,
    mailboxes,
    token,
    states,
    lastRun,
    isMock,
    fallbackReason,
    capabilities: [...provider.capabilities],
    availableProviders: providerRegistry.available,
  }
}

/**
 * `POST /provider/connect`.
 *
 * Idempotent: connecting an already-connected mailbox refreshes its details
 * rather than failing, because a user clicking "Connect" twice has done nothing
 * wrong.
 */
export async function connect({ auth, providerType = null }) {
  const user = auth.user

  const requested = providerType ?? PROVIDER_TYPES.MICROSOFT_GRAPH
  const existing = await mailboxRepo.findMailbox({ user: user._id })

  const resolved = providerRegistry.resolve({
    mailbox: existing ?? { provider: requested, sourceAccount: auth.outlookAccount?._id ?? null },
  })

  const { provider, isMock, fallbackReason } = resolved

  const account = auth.outlookAccount ?? (await OutlookAccount.findOne({ user: user._id }))

  const details = await provider.connect({
    mailbox: existing ?? { sourceAccount: account?._id ?? null, emailAddress: account?.email ?? null },
    outlookAccountId: account?._id?.toString() ?? null,
  })

  const mailbox = await mailboxRepo.upsertMailbox({
    user: user._id,
    provider: resolved.type,

    /**
     * MSAL's `homeAccountId` is the canonical key, when there is one.
     *
     * This used to be `details.mailbox.providerAccountId` unconditionally,
     * which for the Microsoft adapter is the Graph `/me` `id` — a *different*
     * identifier from the `homeAccountId` that `resolveContext` and the Phase
     * 13.2 connect flow both use. Two code paths therefore wrote two different
     * keys for the same real mailbox, and since the upsert matches on
     * `(user, provider, providerAccountId)` neither found the other's row.
     *
     * The result was visible in the database as duplicate registry entries for
     * one address — one `connected`, one `disconnected` — which is exactly what
     * makes a mailbox look like it "disappeared and came back as a new one".
     *
     * `homeAccountId` wins because it is the key MSAL looks accounts up by, so
     * it is the one that must match for a credential to resolve at all. The
     * adapter's value remains the fallback for providers with no MSAL grant.
     */
    providerAccountId: account?.homeAccountId ?? details.mailbox.providerAccountId,

    emailAddress: details.mailbox.emailAddress,
    displayName: details.mailbox.displayName,
    sourceAccount: account?._id ?? null,
    capabilities: [...provider.capabilities],
  })

  await tokenManager.recordConnection({
    mailbox,
    provider: resolved.type,
    status: CONNECTION_STATUS.CONNECTED,
    scope: config.microsoft.scopes,
  })

  // Keeps "a workspace with a usable mailbox has a default" true here too, so
  // the legacy connect path and the Phase 13.2 one cannot disagree.
  await mailboxRepo.ensureDefaultMailbox({ user: user._id })

  // Folders are enumerated immediately so the UI has something to show before
  // any message sync has run.
  try {
    const { folders } = await provider.syncFolders({ mailbox })
    await mailboxRepo.syncFolderRecords({ user: user._id, mailboxId: mailbox._id, folders })
  } catch (error) {
    log.warn('Connected, but the initial folder listing failed', {
      message: error?.message ?? String(error),
    })
  }

  return {
    mailbox: await mailboxRepo.findMailbox({ user: user._id, mailboxId: mailbox._id }),
    isMock,
    fallbackReason,
    capabilities: [...provider.capabilities],
  }
}

/**
 * `POST /provider/disconnect`.
 *
 * Marks the mailbox disconnected and revokes stored credentials. Synced messages
 * are **kept**: they are the user's data, and a disconnect is not a request to
 * delete their mail history.
 */
export async function disconnect({ auth, mailboxId = null }) {
  /**
   * Disconnects the mailbox the operator is looking at, not the default.
   *
   * Without `mailboxId` this resolved the workspace default, so pressing
   * Disconnect while viewing mailbox B disconnected mailbox A — the one action
   * on this page where acting on the wrong mailbox is least recoverable.
   */
  const { mailbox, provider } = await resolveContext({ auth, mailboxId })

  if (!mailbox) {
    throw ApiError.notFound('No mailbox is connected.')
  }

  await provider.disconnect({ mailbox })
  await tokenManager.revoke({ mailbox, provider: mailbox.provider })
  await syncRepo.releaseAllLocks({ mailboxId: mailbox._id })

  const updated = await mailboxRepo.markMailboxStatus({
    mailboxId: mailbox._id,
    status: CONNECTION_STATUS.DISCONNECTED,
    reason: 'user_disconnected',
  })

  // Cleared before re-selecting, so the mailbox just disconnected cannot be
  // chosen as its own replacement.
  await Mailbox.updateOne({ _id: mailbox._id }, { $set: { isDefault: false } })
  await mailboxRepo.ensureDefaultMailbox({ user: auth.user._id })

  log.info('Mailbox disconnected', { mailboxId: mailbox._id.toString() })

  return { mailbox: updated }
}

/** `GET /provider/folders`. */
export async function listFolders({ auth, mailboxId = null, refresh = false }) {
  const { mailbox, provider } = await resolveContext({
    auth,
    mailboxId,
    createIfMissing: !mailboxId,
  })

  if (!mailbox) {
    return { folders: [], mailbox: null }
  }

  if (refresh) {
    const { folders } = await provider.syncFolders({ mailbox })
    await mailboxRepo.syncFolderRecords({
      user: auth.user._id,
      mailboxId: mailbox._id,
      folders,
    })
  }

  const folders = await mailboxRepo.listFolders({ user: auth.user._id, mailboxId: mailbox._id })

  return { folders, mailbox }
}

/**
 * `POST /provider/sync` and the per-folder variants.
 *
 * @param {object} params
 * @param {string[]} [params.folders] Defaults to every syncable folder.
 * @returns {Promise<{ run: object, isMock: boolean }>}
 */
export async function runSync({
  auth,
  mailboxId = null,
  folders = SYNCABLE_FOLDERS,
  mode = SYNC_MODE.INCREMENTAL,
  trigger = SYNC_TRIGGER.MANUAL,
}) {
  /**
   * Synchronises the selected mailbox only.
   *
   * Everything downstream is already per-mailbox — `syncEngine` takes the
   * mailbox, `SyncState` is unique on `(mailbox, folder)` so delta tokens
   * cannot collide, and `SyncHistory` records which mailbox produced the run.
   * The isolation was never missing; the mailbox simply never arrived here.
   */
  const { mailbox, provider, isMock } = await resolveContext({
    auth,
    mailboxId,
    createIfMissing: !mailboxId,
  })

  if (!mailbox) {
    throw ApiError.badRequest(
      'No mailbox is connected. Call POST /api/v1/provider/connect first.',
    )
  }

  if (mailbox.status === CONNECTION_STATUS.DISCONNECTED) {
    throw ApiError.forbidden('This mailbox is disconnected. Reconnect it before syncing.')
  }

  const run = await syncEngine.run({
    provider,
    mailbox,
    user: auth.user,
    folders,
    mode,
    trigger,
    isMock,
  })

  return { run, isMock }
}

/** `GET /provider/history`. */
export async function getHistory({ auth, mailboxId = null, allMailboxes = false, page = 1, limit = 20 }) {
  /**
   * Scoped to one mailbox, or explicitly to all of them.
   *
   * `allMailboxes` is opt-in rather than the default: a history list mixing
   * runs from three mailboxes without saying which is which reads as one
   * mailbox behaving erratically. Each row carries its mailbox either way.
   */
  let resolvedId = null

  if (!allMailboxes) {
    const { mailbox } = await resolveContext({ auth, mailboxId })
    resolvedId = mailbox?._id ?? null
  }

  const { items, total } = await syncRepo.listHistory({
    user: auth.user._id,
    mailboxId: resolvedId,
    page,
    limit,
  })

  return {
    items,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1,
    },
  }
}

/**
 * Live connection probe.
 *
 * Distinct from `getStatus`, which reads stored state. This performs a real
 * round trip, because a stored "connected" flag is exactly what a health check
 * should distrust.
 */
export async function validate({ auth, mailboxId = null }) {
  const { mailbox, provider, isMock } = await resolveContext({
    auth,
    mailboxId,
    createIfMissing: !mailboxId,
  })

  if (!mailbox) {
    return { status: CONNECTION_STATUS.NOT_CONFIGURED, reason: 'No mailbox connected.', isMock }
  }

  /**
   * The probe authenticates as the selected mailbox.
   *
   * `provider.validateConnection({ mailbox })` reaches Graph through
   * `mailbox.sourceAccount`, so the round trip uses that mailbox's own MSAL
   * grant. The address it reports back is therefore evidence of which
   * credential was used, not a label copied from the request.
   */
  const result = await provider.validateConnection({ mailbox })

  await mailboxRepo.markMailboxStatus({
    mailboxId: mailbox._id,
    status: result.status,
    reason: result.reason,
  })

  /**
   * Both the mailbox that was asked about and the identity that answered.
   *
   * Kept as two fields rather than one, so the UI can show that they agree —
   * and, more usefully, notice when they do not. A `verifiedAs` that differs
   * from `requested` would mean a credential is attached to the wrong registry
   * row, which is the precise failure multi-mailbox support has to rule out.
   */
  return {
    ...result,
    isMock,
    requested: {
      id: mailbox._id.toString(),
      emailAddress: mailbox.emailAddress ?? null,
    },
    verifiedAs: result.mailbox?.emailAddress ?? null,
    identityMatches: result.mailbox?.emailAddress
      ? result.mailbox.emailAddress === (mailbox.emailAddress ?? '').toLowerCase()
      : null,
  }
}

/**
 * Converts a `ProviderError` into the API's `ApiError`.
 *
 * The boundary where a provider-independent failure becomes an HTTP status. The
 * mapping is deliberate: a rate limit is 429 so a client backs off, a missing
 * mailbox is 403 because re-authenticating will not help, and a network failure
 * is 503 because retrying later will.
 *
 * @param {unknown} error
 * @returns {ApiError}
 */
export function toApiError(error) {
  if (error instanceof ApiError) return error
  if (!(error instanceof ProviderError)) return ApiError.internal(error?.message ?? String(error))

  const details = error.toJSON()

  const status = {
    PROVIDER_RATE_LIMITED: 429,
    PROVIDER_TOKEN_EXPIRED: 401,
    PROVIDER_CONSENT_REQUIRED: 401,
    PROVIDER_TOKEN_REFRESH_FAILED: 401,
    PROVIDER_MAILBOX_UNAVAILABLE: 403,
    PROVIDER_INSUFFICIENT_PERMISSIONS: 403,
    PROVIDER_RESOURCE_NOT_FOUND: 404,
    PROVIDER_INVALID_REQUEST: 400,
    PROVIDER_UNSUPPORTED_OPERATION: 501,
  }[error.code] ?? 503

  return new ApiError(status, error.message, { code: error.code, details, cause: error })
}

export default {
  resolveContext,
  listSyncableMailboxes,
  getStatus,
  connect,
  disconnect,
  listFolders,
  runSync,
  getHistory,
  validate,
  toApiError,
}
