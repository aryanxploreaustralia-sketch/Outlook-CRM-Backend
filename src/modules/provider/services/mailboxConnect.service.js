/**
 * Connecting a Microsoft mailbox to an existing CRM session.
 *
 * ## What this is not
 *
 * It is not a sign-in. That distinction is the whole point of Phase 13.2, and
 * it is worth being precise about, because the two flows share a protocol, a
 * client id and a redeem step, and the temptation to reuse `completeSignIn` for
 * both is strong.
 *
 * `completeSignIn` does three things this must not do: it upserts a `User` from
 * the Microsoft claims, it makes that user the CRM identity, and it opens a
 * session. Running it here would mean that connecting a shared mailbox —
 * `enquiry@…` — silently created a CRM user called "Enquiries" and signed the
 * operator in as it. The person connecting a mailbox is already signed in with
 * Google; who they are is settled, and Microsoft is being asked a different
 * question: *may this CRM send and read mail as this address?*
 *
 * So this module redeems a code, stores the credential, and attaches it to the
 * user the flow was started by. It never touches `User` and never calls
 * `createSession`.
 *
 * ## Where the credential lives
 *
 * Nowhere new. The encrypted MSAL cache goes into `OutlookAccount` exactly as
 * it has since Phase 2, `Mailbox` is the synchronisation record layered over it
 * via `sourceAccount`, and `ProviderToken` records connection metadata. Every
 * mail path already resolves credentials through that chain, which is why
 * sending from a second mailbox needs no second Graph implementation.
 */

import { config } from '../../../config/index.js'
import {
  AUTH_FLOW_PURPOSE,
  AuthFlow,
  MAILBOX_FLOW_PURPOSES,
} from '../../../models/authFlow.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { OutlookAccount } from '../../../models/outlookAccount.model.js'
import { sanitiseReturnPath } from '../../../services/auth.service.js'
import { fetchUserProfile } from '../../../services/graph.service.js'
import { buildAuthorizationUrl, redeemAuthorizationCode } from '../../../services/msal.service.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createPkcePair, encryptSecret, generateOpaqueToken } from '../../../utils/crypto.js'
import { createContextLogger } from '../../../utils/logger.js'
import { CONNECTION_STATUS, PROVIDER_TYPES } from '../constants/providerTypes.js'
import * as mailboxRepo from '../repositories/mailbox.repository.js'
import { tokenManager } from './tokenManager.js'

const log = createContextLogger('mailbox-connect')

/**
 * Reason codes returned to the browser on the callback's query string.
 *
 * Deliberately a closed set of opaque tokens. The callback is a top-level
 * navigation, so anything put here is displayed by the client and visible in
 * history and server logs; echoing a provider's raw error text would risk
 * putting account detail somewhere it does not belong.
 */
export const CONNECT_ERROR = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  FLOW_INVALID: 'flow_invalid',
  SESSION_REQUIRED: 'session_required',
  OWNED_ELSEWHERE: 'owned_elsewhere',
  PROFILE_FAILED: 'profile_failed',
  EXCHANGE_FAILED: 'exchange_failed',
  /** Reconnect completed against a different Microsoft account than the target. */
  ACCOUNT_MISMATCH: 'account_mismatch',
  /** The mailbox being reconnected was removed while the flow was open. */
  TARGET_MISSING: 'target_missing',
})

/** How long a connect flow may stay open before the TTL index sweeps it. */
const FLOW_TTL_MS = 10 * 60 * 1000


/**
 * Begins a mailbox connection for a signed-in CRM user.
 *
 * @param {object} params
 * @param {import('express').Request} params.req
 * @param {object} params.user The authenticated CRM user.
 * @param {?string} [params.returnPath]
 * @returns {Promise<{ authorizationUrl: string }>}
 */
export async function beginMailboxConnect({ req, user, returnPath = null, mailboxId = null }) {
  if (!user?._id) {
    throw ApiError.unauthorized('Sign in before connecting a mailbox.')
  }

  /**
   * A reconnect names the mailbox it is repairing.
   *
   * Resolved here, scoped by `user`, so a mailbox id belonging to another
   * workspace never reaches the flow record — and therefore can never be
   * re-authorised by somebody who does not own it.
   */
  let target = null
  if (mailboxId) {
    target = await mailboxRepo.findMailbox({ user: user._id, mailboxId })
    if (!target) {
      throw ApiError.notFound('That mailbox does not exist, or is not yours to reconnect.')
    }
  }

  const state = generateOpaqueToken(32)
  const { codeVerifier, codeChallenge } = createPkcePair()

  /**
   * The redirect URI Microsoft will return to.
   *
   * `config.microsoft.mailboxRedirectUri` falls back to the sign-in URI, which
   * is deliberate: that is the one already registered in Entra ID, so a
   * deployment needs no portal change for mailbox connection to work. The
   * callback that receives it dispatches on this flow's `purpose`, so sharing a
   * URI does not mean sharing behaviour.
   *
   * An operator who registers a dedicated URI can set
   * `MICROSOFT_MAILBOX_REDIRECT_URI` and the flow moves to it with no other
   * change.
   */
  const redirectUri = config.microsoft.mailboxRedirectUri

  // Written before the redirect, carrying the owner, the intent and the
  // reconnect target. The callback reads all three from this record and from
  // nowhere else — never from the callback's own query string.
  await AuthFlow.create({
    state,
    codeVerifier,
    purpose: target ? AUTH_FLOW_PURPOSE.RECONNECT_MAILBOX : AUTH_FLOW_PURPOSE.CONNECT_MAILBOX,
    user: user._id,
    targetMailbox: target?._id ?? null,
    redirectUri,
    returnPath: sanitiseReturnPath(returnPath),
    expiresAt: new Date(Date.now() + FLOW_TTL_MS),
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  })

  /**
   * `prompt: 'select_account'` is what makes connecting a *second* mailbox
   * possible at all.
   *
   * Without it Microsoft silently reuses whichever account the browser is
   * already signed into, so a user asking to add `sales@…` would be handed
   * `enquiry@…` again, the upsert would match the mailbox they already had, and
   * the UI would report success while nothing had been added. `buildAuthorizationUrl`
   * already sets it for the sign-in flow; it matters more here.
   */
  const authorizationUrl = await buildAuthorizationUrl({ state, codeChallenge, redirectUri })

  log.info('Mailbox connection flow started', {
    requestId: req.id,
    userId: String(user._id),
    intent: target ? 'reconnect' : 'connect',
    targetMailbox: target?._id?.toString() ?? null,
  })

  return { authorizationUrl }
}

/**
 * Consumes a connect flow, verifying `state` and purpose.
 *
 * `findOneAndDelete` makes consumption atomic, so two concurrent callbacks
 * carrying the same state cannot both succeed — the same primitive both
 * sign-in flows rely on to prevent authorization-code replay.
 */
async function consumeConnectFlow(state) {
  const flow = await AuthFlow.findOneAndDelete({ state: String(state) })

  if (!flow) return { flow: null, reason: CONNECT_ERROR.FLOW_INVALID }

  if (flow.expiresAt.getTime() <= Date.now()) {
    return { flow: null, reason: CONNECT_ERROR.FLOW_INVALID }
  }

  /**
   * A sign-in flow may not be redeemed here, and vice versa.
   *
   * Without this check the two callbacks would accept each other's states.
   * Feeding a sign-in state to this endpoint would reach the ownership branch
   * below with `flow.user === null` — which is refused — but refusing it here
   * is the honest place, and it keeps the guarantee independent of the order of
   * later checks.
   */
  if (!MAILBOX_FLOW_PURPOSES.includes(flow.purpose)) {
    return { flow: null, reason: CONNECT_ERROR.FLOW_INVALID }
  }

  if (!flow.user) return { flow: null, reason: CONNECT_ERROR.SESSION_REQUIRED }

  return { flow, reason: null }
}

/**
 * Completes a mailbox connection.
 *
 * ## Duplicate policy, and why it is "re-authorise" rather than "refuse"
 *
 * Connecting a mailbox that is already connected refreshes it in place. The
 * upsert key is `(user, provider, providerAccountId)` — the index `Mailbox` has
 * carried since Phase 5 — so a repeat connection matches the existing row and
 * updates its credential rather than inserting a second one.
 *
 * That is the right behaviour because it is also the *repair* path. The single
 * most common reason somebody connects a mailbox they already have is that its
 * grant was revoked and the UI is asking them to reconnect. Refusing with
 * "this mailbox is already connected" would leave them with a broken mailbox
 * and no way to fix it. The response reports which of the two happened, so the
 * UI can say "Reconnected" rather than claiming a new mailbox appeared.
 *
 * A mailbox already owned by a *different* CRM user is a different matter and
 * is refused: `OutlookAccount.homeAccountId` is globally unique, so proceeding
 * would move the credential — and with it, live mail access — from one
 * workspace to another as a side effect of a button press.
 *
 * @param {object} params
 * @param {string} params.code
 * @param {string} params.state
 * @returns {Promise<{ mailbox: object, reconnected: boolean, returnPath: ?string }>}
 */
export async function completeMailboxConnect({ code, state }) {
  const { flow, reason } = await consumeConnectFlow(state)

  if (!flow) throw ApiError.unauthorized('This connection link is invalid or has already been used.', {
    code: reason,
  })

  const { result, serialisedCache } = await redeemAuthorizationCode({
    code,
    codeVerifier: flow.codeVerifier,
    // The same URI the authorize request used, read back from the flow rather
    // than re-derived — Entra ID rejects the code if the two differ.
    redirectUri: flow.redirectUri ?? config.microsoft.mailboxRedirectUri,
  })

  const homeAccountId = result.account?.homeAccountId
  if (!homeAccountId) {
    throw ApiError.internal('Microsoft returned a token response without account details.')
  }

  /**
   * A reconnect must re-authorise the mailbox it was started for.
   *
   * Clicking Reconnect on `aryan.xplore@…` and then signing in as some other
   * account is not a reconnect — it is a different mailbox. Allowing it through
   * would overwrite the target row's `providerAccountId` and address, so the
   * registry entry the user was trying to repair would silently become a
   * different mailbox and the original would be gone.
   *
   * Rejected rather than reinterpreted as "connect a new mailbox", because the
   * user's stated intent was to fix a specific address and the safe response to
   * "you signed in as the wrong account" is to say so. Adding a mailbox is
   * still one click away on the same page.
   */
  if (flow.targetMailbox) {
    const target = await Mailbox.findOne({ _id: flow.targetMailbox, user: flow.user })

    if (!target) {
      throw ApiError.notFound('The mailbox being reconnected no longer exists.', {
        code: CONNECT_ERROR.TARGET_MISSING,
      })
    }

    if (String(target.providerAccountId) !== String(homeAccountId)) {
      log.warn('Refused a reconnect that authenticated a different Microsoft account', {
        userId: String(flow.user),
        mailboxId: target._id.toString(),
      })

      throw ApiError.conflict(
        `That is a different Microsoft account. To reconnect ${target.emailAddress ?? 'this mailbox'}, ` +
          'sign in with that address. To add a different mailbox, use “Connect Microsoft mailbox”.',
        { code: CONNECT_ERROR.ACCOUNT_MISMATCH },
      )
    }
  }

  /**
   * Ownership check, before anything is written.
   *
   * `homeAccountId` is globally unique on `OutlookAccount`, so an existing
   * record for this Microsoft account belonging to somebody else cannot be
   * upserted into this workspace without taking it away from theirs.
   */
  const existingAccount = await OutlookAccount.findOne({ homeAccountId })

  if (existingAccount && String(existingAccount.user) !== String(flow.user)) {
    log.warn('Refused a mailbox already connected to another workspace', {
      userId: String(flow.user),
    })

    throw ApiError.conflict(
      'That Microsoft mailbox is already connected to a different CRM account. ' +
        'Disconnect it there first, or connect a different mailbox.',
      { code: CONNECT_ERROR.OWNED_ELSEWHERE },
    )
  }

  const claims = result.account.idTokenClaims ?? {}
  const signInAddress =
    result.account.username?.trim().toLowerCase() ??
    claims.preferred_username?.trim().toLowerCase() ??
    null

  const account = await OutlookAccount.findOneAndUpdate(
    { homeAccountId },
    {
      $set: {
        user: flow.user,
        email: signInAddress,
        tokenCache: encryptSecret(serialisedCache, config.security.tokenEncryptionKey),
        scopes: result.scopes ?? [],
        accessTokenExpiresAt: result.expiresOn ?? null,
        // Reconnecting clears any previous failure state, which is the point of
        // reconnecting.
        disconnectedAt: null,
        disconnectReason: null,
        connectedAt: new Date(),
      },
      $setOnInsert: { homeAccountId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )

  /**
   * Enrich from Graph, non-fatally.
   *
   * The mailbox address is what the whole Account page is about, so it is worth
   * one call to get it right — Graph's `mail` is the routable address, whereas
   * the sign-in username can be a UPN that differs from it. But the credential
   * is already stored and valid at this point, and failing here would discard a
   * working connection over a display string.
   */
  let displayName = signInAddress
  let emailAddress = signInAddress

  try {
    const profile = await fetchUserProfile(account._id.toString())
    emailAddress = profile.mail?.trim().toLowerCase() ?? emailAddress
    displayName = profile.displayName ?? displayName

    if (emailAddress && emailAddress !== account.email) {
      account.email = emailAddress
      await account.save()
    }
  } catch (error) {
    log.warn('Connected the mailbox but could not read its Graph profile', {
      message: error.message,
    })
  }

  // Whether this is a repair or an addition, decided before the upsert writes.
  const priorMailbox = await Mailbox.findOne({
    user: flow.user,
    provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
    providerAccountId: homeAccountId,
  })

  const mailbox = await mailboxRepo.upsertMailbox({
    user: flow.user,
    provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
    providerAccountId: homeAccountId,
    emailAddress,
    displayName,
    sourceAccount: account._id,
    capabilities: ['send', 'read', 'folders'],
  })

  await tokenManager.recordConnection({
    mailbox,
    provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
    status: CONNECTION_STATUS.CONNECTED,
    scope: result.scopes ?? config.microsoft.scopes,
  })

  /**
   * The first mailbox becomes the default. Nothing else moves it.
   *
   * The election runs **only when the workspace has no default at all**, which
   * is the first-mailbox rule and nothing more. Authorising a mailbox is not a
   * statement about which address the business sends from, and a reconnect
   * least of all: someone repairing `sales@…` has not asked for the automatic
   * introduction to start going out from it.
   *
   * `ensureDefaultMailbox` on its own would move the flag when the current
   * default is disconnected — a reasonable repair in isolation, but it would
   * mean reconnecting any mailbox could silently change the sender. Sending
   * still resolves correctly in that state because `findDefaultMailbox` prefers
   * a *usable* mailbox without rewriting the flag.
   */
  const hasDefault = await Mailbox.exists({ user: flow.user, isDefault: true })
  if (!hasDefault) await mailboxRepo.ensureDefaultMailbox({ user: flow.user })

  const reconnected = Boolean(priorMailbox)

  log.info(reconnected ? 'Mailbox reconnected' : 'Mailbox connected', {
    userId: String(flow.user),
    mailboxId: mailbox._id.toString(),
  })

  return {
    mailbox: await mailboxRepo.findMailbox({ user: flow.user, mailboxId: mailbox._id }),
    reconnected,
    returnPath: flow.returnPath,
  }
}

export default { beginMailboxConnect, completeMailboxConnect, CONNECT_ERROR }
