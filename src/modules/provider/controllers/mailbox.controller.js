/**
 * Connected mailbox management.
 *
 * Two response styles, for the same reason the auth controllers use two:
 * `/connect` and `/callback` are reached by top-level browser navigation and so
 * respond with redirects, while the rest are called by fetch and respond with
 * the standard JSON envelope.
 *
 * ## The ownership rule
 *
 * Every handler here resolves its mailbox through `mailboxRepo`, which takes
 * `user` as part of the query rather than as a separate check. A mailbox id
 * belonging to another workspace therefore does not resolve at all, and the
 * handler answers 404 — the same answer it gives for an id that never existed,
 * which is deliberate: distinguishing the two would confirm the existence of
 * another workspace's mailbox to somebody guessing ids.
 */

import { config } from '../../../config/index.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { OutlookAccount } from '../../../models/outlookAccount.model.js'
import { purgeCachedAccount } from '../../../services/msal.service.js'
import { ApiError } from '../../../utils/ApiError.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { createContextLogger } from '../../../utils/logger.js'
import { CONNECTION_STATUS } from '../constants/providerTypes.js'
import * as mailboxRepo from '../repositories/mailbox.repository.js'
import { isDefaultForUser } from '../../../constants/mailboxAccess.js'
import * as syncRepo from '../repositories/syncState.repository.js'
import {
  beginMailboxConnect,
  completeMailboxConnect,
  CONNECT_ERROR,
} from '../services/mailboxConnect.service.js'
import { tokenManager } from '../services/tokenManager.js'

const log = createContextLogger('mailbox-controller')

/** Builds an absolute URL into the web client. */
function clientUrl(pathname, params = {}) {
  const url = new URL(pathname, config.client.url)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** Where the browser lands after a connect attempt, successful or not. */
const ACCOUNT_PATH = '/account'

/**
 * GET /api/v1/mailboxes
 *
 * Never 404s for a workspace with no mailboxes: an empty list is the correct
 * answer and the Account page needs it to render its empty state.
 */
export const list = asyncHandler(async (req, res) => {
  const viewer = req.auth.user._id
  const mailboxes = await mailboxRepo.listMailboxes({ user: viewer })

  /**
   * `isDefault` is rewritten to mean "default **for the caller**".
   *
   * `toPublicJSON()` reports the connector's flag, which is the right answer for
   * whoever connected the mailbox and the wrong one for everybody it was
   * assigned to. Compose pre-selects on this field, so leaving it as-is would
   * have an assignee silently sending from whichever mailbox sorted first.
   *
   * Rewritten here rather than in the model because the model has no viewer -
   * one document is a different answer for two different people.
   */
  const items = mailboxes.map((mailbox) => ({
    ...mailbox.toPublicJSON(),
    isDefault: isDefaultForUser(mailbox, viewer),
    /** Distinguishes "they connected it" from "it was assigned to them". */
    accessVia: String(mailbox.user) === String(viewer) ? 'connector' : 'assigned',
  }))

  return sendSuccess(res, {
    message: items.length === 0 ? 'No mailboxes are connected.' : 'Mailboxes retrieved.',
    data: {
      items,
      /** Convenience for the UI, so it does not re-derive the rule. */
      defaultMailboxId: items.find((item) => item.isDefault)?.id ?? null,
      canSendMail: items.some((item) => item.canSend),
      /** Whether connecting a new mailbox is even possible on this deployment. */
      connectAvailable: config.microsoft.enabled,
    },
  })
})

/**
 * GET /api/v1/mailboxes/connect
 *
 * Starts the Microsoft OAuth flow for the signed-in CRM user.
 *
 * A GET reached by navigation rather than a POST, because the browser must be
 * sent to Microsoft as a top-level document. It is safe as a GET only because
 * it writes nothing but a single-use flow record and grants nothing on its own
 * — the callback is where anything is actually connected, and that requires a
 * code Microsoft will only issue to a user who consented interactively.
 */
export const connect = asyncHandler(async (req, res) => {
  if (!config.microsoft.enabled) {
    throw ApiError.serviceUnavailable(
      'Microsoft is not configured on this server, so no mailbox can be connected. ' +
        'See docs/AZURE_SETUP.md.',
    )
  }

  const { authorizationUrl } = await beginMailboxConnect({
    req,
    user: req.auth.user,
    returnPath: typeof req.query.returnPath === 'string' ? req.query.returnPath : null,
    /**
     * Present when this is a **reconnect** of an existing registry entry.
     *
     * Taken from the query string only as a *hint*: `beginMailboxConnect`
     * re-resolves it against the caller's own mailboxes, so an id from another
     * workspace is rejected there rather than trusted here.
     */
    mailboxId: typeof req.query.mailboxId === 'string' ? req.query.mailboxId : null,
  })

  res.redirect(HTTP_STATUS.FOUND, authorizationUrl)
})

/**
 * GET /api/v1/mailboxes/callback
 *
 * The Microsoft redirect target for mailbox connection.
 *
 * Deliberately **not** behind `requireAuth`. The browser arriving here has been
 * to Microsoft and back, and on some flows will not present the session cookie
 * (a cross-site top-level POST-back, a stricter SameSite policy, a user who
 * opened the consent screen in a new profile). Requiring the cookie would fail
 * a legitimate connection at the last step.
 *
 * That costs nothing, because authority does not come from the cookie here. It
 * comes from `AuthFlow.user`, written server-side before the redirect and
 * consumed atomically — so this endpoint being open cannot connect a mailbox to
 * anybody, only complete a flow somebody already started while signed in.
 */
export const callback = asyncHandler(async (req, res) => {
  const { code, state, error: providerError } = req.query

  const fail = (reason) =>
    res.redirect(
      HTTP_STATUS.FOUND,
      clientUrl(ACCOUNT_PATH, { mailbox: 'error', reason }),
    )

  if (!config.microsoft.enabled) return fail(CONNECT_ERROR.NOT_CONFIGURED)

  // The user cancelled at the Microsoft prompt, or declined consent.
  if (providerError) {
    log.warn('Microsoft returned an error to the mailbox callback', {
      requestId: req.id,
      error: String(providerError).slice(0, 200),
    })
    return fail(String(providerError).slice(0, 64))
  }

  if (!code || !state) return fail(CONNECT_ERROR.FLOW_INVALID)

  try {
    const { mailbox, reconnected, returnPath } = await completeMailboxConnect({
      code: String(code),
      state: String(state),
    })

    /**
     * Phase 14.7. The OAuth exchange above is untouched.
     *
     * Recorded as a Microsoft authorisation because that is what happened: a
     * grant was issued for a named address. The metadata carries the address
     * and the provider and nothing else — no code, no state, no fragment of
     * the token response.
     *
     * `actor` is taken from the mailbox's owner rather than the request: this
     * is an OAuth redirect from Microsoft, so the CRM session cookie may not
     * accompany it.
     */
    await recordAudit({
      req,
      actor: { _id: mailbox.user, email: null, role: null },
      owner: mailbox.user,
      event: 'MICROSOFT_CONNECTED',
      summary: `${reconnected ? 'Reconnected' : 'Connected'} the mailbox ${mailbox.emailAddress ?? ''}`.trim(),
      target: { id: String(mailbox._id), name: mailbox.emailAddress ?? null },
      refs: { mailboxId: mailbox._id },
      metadata: { provider: mailbox.provider ?? 'microsoft', reconnected: Boolean(reconnected) },
    })

    return res.redirect(
      HTTP_STATUS.FOUND,
      clientUrl(returnPath ?? ACCOUNT_PATH, {
        mailbox: reconnected ? 'reconnected' : 'connected',
        address: mailbox?.emailAddress ?? null,
      }),
    )
  } catch (error) {
    // Full detail server-side; the browser learns only a reason code.
    log.error('Mailbox connection failed', {
      requestId: req.id,
      code: error.code,
      message: error.message,
    })

    // Skipped when the exchange failed before an owner could be resolved — see
    // the note on unattributable entries in `auditRecorder.service.js`.
    await recordAudit({
      req,
      event: 'MAILBOX_CONNECTED',
      result: 'failure',
      resultReason: error.code ?? CONNECT_ERROR.EXCHANGE_FAILED,
      summary: 'Mailbox connection failed',
      metadata: { provider: 'microsoft', code: error.code ?? null },
    })

    return fail(error.code ?? CONNECT_ERROR.EXCHANGE_FAILED)
  }
})

/**
 * PATCH /api/v1/mailboxes/:id/default
 *
 * Making an unusable mailbox the default is refused rather than allowed with a
 * warning: the default is what unattended mail resolves to, and pointing it at
 * a mailbox that cannot send would turn every overnight introduction into a
 * failure nobody is awake to see.
 */
export const setDefault = asyncHandler(async (req, res) => {
  const user = req.auth.user._id

  const target = await mailboxRepo.findMailbox({ user, mailboxId: req.params.id })

  if (!target) throw ApiError.notFound('That mailbox does not exist.')

  if (target.status !== CONNECTION_STATUS.CONNECTED) {
    throw ApiError.badRequest(
      'That mailbox needs reconnecting before it can be the default sender. ' +
        'Reconnect it, then set it as default.',
    )
  }

  const mailbox = await mailboxRepo.setDefaultMailbox({ user, mailboxId: req.params.id })

  if (!mailbox) throw ApiError.notFound('That mailbox does not exist.')

  log.info('Default mailbox changed', {
    userId: String(user),
    mailboxId: mailbox._id.toString(),
  })

  return sendSuccess(res, {
    message: `${mailbox.emailAddress ?? 'That mailbox'} is now the default sender.`,
    data: { mailbox: mailbox.toPublicJSON() },
  })
})

/**
 * DELETE /api/v1/mailboxes/:id
 *
 * Disconnects one mailbox.
 *
 * ## What is deliberately kept
 *
 * Mail history, conversations, leads, campaigns and synced messages. All of it
 * is the user's own business record, and disconnecting a mailbox is a statement
 * about future access, not a request to erase the past. The `Mailbox` row
 * itself is kept too, marked disconnected, so history that references it still
 * renders a sender address rather than a dangling id.
 *
 * ## What is actually revoked
 *
 * The credential. The MSAL cache is purged and re-encrypted so that recovering
 * the stored blob later yields nothing usable, and the `ProviderToken` record
 * is marked revoked. That is what ends access.
 */
export const disconnect = asyncHandler(async (req, res) => {
  const user = req.auth.user._id

  const mailbox = await mailboxRepo.findMailbox({ user, mailboxId: req.params.id })

  if (!mailbox) throw ApiError.notFound('That mailbox does not exist.')

  await tokenManager.revoke({
    mailbox,
    provider: mailbox.provider,
    reason: 'user_disconnected',
  })

  // A run interrupted here would otherwise hold folder locks until the TTL
  // expired, blocking the next connection's first sync.
  await syncRepo.releaseAllLocks({ mailboxId: mailbox._id })

  /**
   * Purge the MSAL cache for this mailbox's grant only.
   *
   * Scoped by `sourceAccount`, so disconnecting one mailbox cannot invalidate
   * another's credential — the requirement that makes multi-mailbox safe. A
   * failure here is logged and not raised: the mailbox is marked disconnected
   * regardless, and reporting success for a disconnect that did not happen
   * would be worse than a stale encrypted blob that nothing will read.
   */
  if (mailbox.sourceAccount) {
    try {
      const account = await OutlookAccount.findOne({
        _id: mailbox.sourceAccount,
        user,
      }).select('+tokenCache')

      if (account) {
        const purged = await purgeCachedAccount(account)
        if (purged) account.tokenCache = purged

        account.disconnectedAt = new Date()
        account.disconnectReason = 'user_disconnected'
        await account.save()
      }
    } catch (error) {
      log.warn('Could not purge the MSAL cache while disconnecting', {
        mailboxId: mailbox._id.toString(),
        message: error.message,
      })
    }
  }

  const updated = await mailboxRepo.markMailboxStatus({
    mailboxId: mailbox._id,
    status: CONNECTION_STATUS.DISCONNECTED,
    reason: 'user_disconnected',
  })

  // Clearing the flag first means `ensureDefaultMailbox` cannot re-select the
  // mailbox that was just disconnected.
  await Mailbox.updateOne({ _id: mailbox._id }, { $set: { isDefault: false } })

  const nextDefault = await mailboxRepo.ensureDefaultMailbox({ user })

  log.info('Mailbox disconnected', {
    userId: String(user),
    mailboxId: mailbox._id.toString(),
    nextDefault: nextDefault?._id?.toString() ?? null,
  })

  await recordAudit({
    req,
    event: 'MAILBOX_DISCONNECTED',
    summary: `Disconnected the mailbox ${mailbox.emailAddress ?? ''}`.trim(),
    target: { id: String(mailbox._id), name: mailbox.emailAddress ?? null },
    refs: { mailboxId: mailbox._id },
    // Which mailbox inherited the default matters: disconnecting one silently
    // moves where unattended mail is sent from, and that should be traceable.
    metadata: {
      reason: 'user_disconnected',
      nextDefaultMailboxId: nextDefault?._id?.toString() ?? null,
    },
  })

  return sendSuccess(res, {
    message: `${mailbox.emailAddress ?? 'The mailbox'} was disconnected. Your mail history is unchanged.`,
    data: {
      mailbox: updated.toPublicJSON(),
      defaultMailboxId: nextDefault?._id?.toString() ?? null,
    },
  })
})

export default { list, connect, callback, setDefault, disconnect }
