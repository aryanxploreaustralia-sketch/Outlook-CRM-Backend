/**
 * Authentication controller.
 *
 * Two response styles are used deliberately:
 *
 *  - `/login` and `/callback` are reached by **top-level browser navigation**, so
 *    they respond with redirects. Returning JSON there would render as raw text
 *    on a blank page.
 *  - `/logout`, `/profile` and `/status` are called by **fetch/XHR**, so they
 *    respond with the standard JSON envelope.
 */

import { config } from '../config/index.js'
import { HTTP_STATUS } from '../constants/httpStatus.js'
import { Mailbox } from '../models/mailbox.model.js'
import { OutlookAccount } from '../models/outlookAccount.model.js'
import { ProviderToken } from '../models/providerToken.model.js'
import { SyncState } from '../models/syncState.model.js'
import { AUTH_FLOW_PURPOSE, AuthFlow, MAILBOX_FLOW_PURPOSES } from '../models/authFlow.model.js'
import { adminCallback } from '../modules/auth-microsoft-admin/controllers/adminAuth.controller.js'
import { CONNECTION_STATUS } from '../modules/provider/constants/providerTypes.js'
import { completeMailboxConnect } from '../modules/provider/services/mailboxConnect.service.js'
import { listMailboxes } from '../modules/provider/repositories/mailbox.repository.js'
import { beginSignIn, completeSignIn, sanitiseReturnPath } from '../services/auth.service.js'
import { fetchUserProfile, verifyMailboxAccess } from '../services/graph.service.js'
import { buildLogoutUrl, purgeCachedAccount } from '../services/msal.service.js'
import { createSession, destroySession } from '../services/session.service.js'
import { callbackQuerySchema, loginQuerySchema } from '../validators/auth.validator.js'
import { ApiError } from '../utils/ApiError.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { sendSuccess } from '../utils/ApiResponse.js'
import { recordAudit } from '../modules/audit/services/auditRecorder.service.js'
import { createContextLogger } from '../utils/logger.js'

const log = createContextLogger('auth-controller')

/** Builds an absolute URL into the web client. */
function clientUrl(pathname, params = {}) {
  const url = new URL(pathname, config.client.url)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** Rejects requests when Azure credentials are absent, with actionable guidance. */
function assertAuthEnabled() {
  if (config.microsoft.enabled) return

  throw ApiError.serviceUnavailable(
    'Microsoft authentication is not configured on this server. ' +
      'See docs/AZURE_SETUP.md, then set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, ' +
      'MICROSOFT_TENANT_ID, MICROSOFT_REDIRECT_URI, SESSION_SECRET and ' +
      'TOKEN_ENCRYPTION_KEY in backend/.env.',
  )
}

/**
 * GET /api/v1/auth/login
 *
 * Starts the OAuth flow by redirecting to Microsoft.
 */
export const login = asyncHandler(async (req, res) => {
  assertAuthEnabled()

  const { returnPath } = loginQuerySchema.parse(req.query)

  /**
   * A signed-in caller is connecting a mailbox, not signing in.
   *
   * This is the entry point the Phase 13.2 defect came through. Somebody
   * already authenticated who arrived here would previously be taken through
   * `completeSignIn`, which upserts a `User` from the Microsoft claims and
   * opens a **new session as that user** — so connecting `aryan.xplore@…`
   * while signed in as `sadhaliya18@…` silently replaced the CRM identity, and
   * with it the workspace whose mailbox registry the Account page then showed.
   *
   * Redirecting into the mailbox flow means the legacy URL keeps working and
   * now does the thing the user actually intended. The CRM identity is
   * untouched.
   */
  if (req.auth?.isAuthenticated) {
    const url = new URL(
      `${config.app.apiPrefix}/v1/mailboxes/connect`,
      `${req.protocol}://${req.get('host')}`,
    )
    if (returnPath) url.searchParams.set('returnPath', returnPath)

    log.info('Redirected a signed-in Microsoft sign-in attempt to the mailbox flow', {
      requestId: req.id,
      userId: String(req.auth.user._id),
    })

    return res.redirect(HTTP_STATUS.FOUND, url.toString())
  }

  /**
   * Anonymous, and Microsoft is no longer an identity provider.
   *
   * Refused rather than quietly redirected to Google, so the reason is visible
   * on the login page instead of looking like a broken button.
   */
  if (!config.microsoft.allowSignIn) {
    return res.redirect(
      HTTP_STATUS.FOUND,
      clientUrl(config.client.loginPath, {
        auth: 'error',
        reason: 'microsoft_signin_disabled',
      }),
    )
  }

  const { authorizationUrl } = await beginSignIn({
    req,
    returnPath: sanitiseReturnPath(returnPath),
  })

  // 302 rather than 307: the browser must issue a fresh GET to Microsoft.
  res.redirect(HTTP_STATUS.FOUND, authorizationUrl)
})

/**
 * GET /api/v1/auth/callback
 *
 * Redirect target registered in Azure. Redeems the authorization code, opens a
 * session, and returns the browser to the web client.
 *
 * Failures redirect to the client with an error code in the query string rather
 * than rendering an API error, because the user is looking at a browser tab.
 */
export const callback = asyncHandler(async (req, res, next) => {
  assertAuthEnabled()

  const query = callbackQuerySchema.parse(req.query)

  // The user declined consent or cancelled at the Microsoft prompt.
  if (query.error) {
    log.warn('Microsoft returned an error to the OAuth callback', {
      requestId: req.id,
      error: query.error,
      description: query.error_description,
    })

    res.redirect(
      HTTP_STATUS.FOUND,
      // Failures go to the public login page: the post-login path is behind a
      // route guard, which would bounce an unauthenticated browser and discard
      // the error before the user ever saw it.
      clientUrl(config.client.loginPath, {
        auth: 'error',
        reason: query.error,
      }),
    )
    return
  }

  if (!query.code) {
    res.redirect(
      HTTP_STATUS.FOUND,
      clientUrl(config.client.loginPath, { auth: 'error', reason: 'missing_code' }),
    )
    return
  }

  /**
   * Dispatch on what this flow was actually started for.
   *
   * ## Why this has to happen here
   *
   * Microsoft returns every flow to the one registered redirect URI, so a
   * mailbox connect and a sign-in both arrive at *this* handler.
   * `/api/v1/mailboxes/callback` exists as a route but Microsoft is never given
   * it, so it was never reached — and this handler treated every arrival as a
   * sign-in.
   *
   * That single assumption caused both defects in this area. Before Microsoft
   * sign-in was disabled, a mailbox connection reached `completeSignIn`, which
   * consumed the flow without checking its purpose and minted a CRM user —
   * which is how four Microsoft CRM users came to exist. After it was disabled,
   * the same arrival was refused as a legacy login, which is why a legitimate
   * Reconnect returned "Use Connect Microsoft mailbox".
   *
   * The purpose is read from the server-written flow record, located by the
   * unguessable `state`, so this is a dispatch on validated intent and not on
   * anything the caller can set. The record is *peeked* at rather than consumed;
   * `completeMailboxConnect` performs the atomic single-use delete, so the
   * replay guarantee still belongs to one place.
   */
  const pendingFlow = await AuthFlow.findOne({ state: String(query.state ?? '') })

  if (pendingFlow && MAILBOX_FLOW_PURPOSES.includes(pendingFlow.purpose)) {
    try {
      const { mailbox, reconnected, returnPath } = await completeMailboxConnect({
        code: String(query.code),
        state: String(query.state),
      })

      log.info('Mailbox authorised through the shared callback', {
        requestId: req.id,
        intent: pendingFlow.purpose,
        mailboxId: mailbox?.id ?? null,
      })

      return res.redirect(
        HTTP_STATUS.FOUND,
        clientUrl(returnPath ?? '/account', {
          mailbox: reconnected ? 'reconnected' : 'connected',
          address: mailbox?.emailAddress ?? null,
        }),
      )
    } catch (error) {
      log.warn('Mailbox authorisation failed at the shared callback', {
        requestId: req.id,
        code: error.code,
        message: error.message,
      })

      return res.redirect(
        HTTP_STATUS.FOUND,
        clientUrl('/account', {
          mailbox: 'error',
          reason: error.code ?? 'exchange_failed',
        }),
      )
    }
  }

  /**
   * Administrator sign-in returns here too (Phase 14.8B fix).
   *
   * ## Why this branch has to exist
   *
   * `beginAdminSignIn` calls `buildAuthorizationUrl` without a `redirectUri`,
   * so it inherits `MICROSOFT_REDIRECT_URI` — this callback. The dedicated
   * route at `/auth/microsoft/admin/callback` is registered and was never once
   * reached, because nothing ever told Microsoft to go there.
   *
   * The consequence was the reported failure: an `ADMIN_SIGN_IN` flow fell past
   * the mailbox dispatch above, hit the `allowSignIn` guard below, and was
   * refused as `microsoft_signin_disabled` — a message about the legacy
   * user-minting flow, shown to somebody using a flow that cannot mint a user.
   *
   * Dispatching here rather than registering a second redirect URI keeps the
   * property Phase 13.3 established: one URI in the Entra ID app registration,
   * and the *server-recorded purpose* decides which handler runs. Adding a URI
   * would have required a portal change to deploy this.
   *
   * ## It must be above the `allowSignIn` guard, and that is not a weakening
   *
   * That guard exists to stop a Microsoft account *becoming* a CRM user. The
   * administrator flow cannot do that — `resolveAdminUser` has no create path
   * and refuses an address with no existing account — so the guard's reason
   * does not apply to it. Every check that does apply still runs, inside
   * `adminCallback`: the flow purpose is re-verified, the code is redeemed and
   * consumed atomically, an existing CRM account is required, the identity is
   * linked rather than duplicated, and a session is created only after
   * `isOrganizationAdministrator` passes.
   *
   * The record is *peeked* at here, not consumed; `completeAdminSignIn`
   * performs the atomic single-use delete, so the replay guarantee stays in
   * one place — the same division the mailbox branch above uses.
   */
  if (pendingFlow?.purpose === AUTH_FLOW_PURPOSE.ADMIN_SIGN_IN) {
    log.info('Administrator sign-in routed from the shared callback', { requestId: req.id })

    return adminCallback(req, res, next)
  }

  /**
   * The last place a Microsoft account could become the CRM identity.
   *
   * Reached only when the flow was genuinely a sign-in — a mailbox flow has
   * already returned above. `/login` also refuses to start one, so arriving
   * here means an old record was redeemed after the policy changed, or a second
   * entry point was added later. Either way this callback must never mint a CRM
   * user or open a session when Microsoft is not an identity provider.
   *
   * Checked independently of `/login` rather than trusting that guard, because
   * "the caller cannot have got here" is exactly the assumption that produced
   * the original defect.
   */
  if (!config.microsoft.allowSignIn) {
    log.warn('Refused a Microsoft sign-in callback: Microsoft is not an identity provider', {
      requestId: req.id,
      alreadyAuthenticated: Boolean(req.auth?.isAuthenticated),
    })

    return res.redirect(
      HTTP_STATUS.FOUND,
      req.auth?.isAuthenticated
        ? // Signed in already: nothing changed, so send them back to Account
          // rather than to a login page they do not need.
          clientUrl('/account', { mailbox: 'error', reason: 'use_connect_mailbox' })
        : clientUrl(config.client.loginPath, {
            auth: 'error',
            reason: 'microsoft_signin_disabled',
          }),
    )
  }

  try {
    const { user, account, returnPath } = await completeSignIn({
      code: query.code,
      state: query.state,
    })

    await createSession({
      req,
      res,
      userId: user._id,
      outlookAccountId: account._id,
    })

    /**
     * Phase 14.7: the only change this file received.
     *
     * Nothing above or below is altered — no branch, no order, no redirect. A
     * sign-in is the single most important thing an audit log records, so it is
     * recorded here, after the session exists and before the redirect.
     *
     * Safe to add to this route because `recordAudit` cannot throw: a failed
     * audit write returns null and logs a warning rather than turning a
     * successful sign-in into an error page.
     */
    await recordAudit({
      req,
      actor: user,
      event: 'GOOGLE_LOGIN',
      summary: `${user.email ?? 'A user'} signed in`,
      target: { id: String(user._id), name: user.email ?? null },
      // Never the code, the state, or any part of the token exchange.
      metadata: { provider: 'google', returnPath: returnPath ?? null },
    })

    res.redirect(
      HTTP_STATUS.FOUND,
      clientUrl(returnPath ?? config.client.postLoginPath, { auth: 'success' }),
    )
  } catch (error) {
    // Logged with full detail server-side; the browser only learns that it failed.
    log.error('Sign-in callback failed', {
      requestId: req.id,
      code: error.code,
      message: error.message,
    })

    /**
     * A failed sign-in is recorded too — a log that only holds successes cannot
     * show a brute-force attempt.
     *
     * `actor` is the CRM's own record of who tried, which does not exist here:
     * the exchange failed, so there is no verified identity. `recordAudit`
     * declines to write an entry it cannot attribute, so this call is a no-op
     * unless a session already existed. That is deliberate — an unattributable
     * entry answers "what" but not "who", and inventing an actor would be
     * worse than the gap.
     */
    await recordAudit({
      req,
      event: 'LOGIN_FAILED',
      result: 'failure',
      resultReason: error.code ?? 'sign_in_failed',
      summary: 'Sign-in attempt failed',
      metadata: { provider: 'google', code: error.code ?? null },
    })

    res.redirect(
      HTTP_STATUS.FOUND,
      clientUrl(config.client.loginPath, {
        auth: 'error',
        reason: error.code ?? 'sign_in_failed',
      }),
    )
  }
})

/**
 * POST /api/v1/auth/logout
 *
 * Ends the local session. POST rather than GET because it changes state — a GET
 * could be triggered by a prefetch or an <img> tag and sign the user out.
 *
 * Responds 200 even for an already-anonymous caller: logout is idempotent, and
 * a client clearing its state should not have to handle an error.
 */
export const logout = asyncHandler(async (req, res) => {
  const session = req.auth?.session ?? null
  const account = req.auth?.outlookAccount ?? null

  // Invalidate the stored MSAL cache so recovering the encrypted blob later
  // still yields nothing usable.
  if (account && config.microsoft.enabled) {
    const withCache = await OutlookAccount.findById(account._id).select('+tokenCache')

    if (withCache) {
      const purgedCache = await purgeCachedAccount(withCache)

      if (purgedCache) {
        withCache.tokenCache = purgedCache
        withCache.disconnectedAt = new Date()
        withCache.disconnectReason = 'signed_out'
        await withCache.save()
      }
    }

    /**
     * Phase 5 state must follow the sign-out.
     *
     * Without this, `Mailbox` stayed `connected` and `ProviderToken` stayed
     * `connected` after logout — so the provider page reported a live mailbox
     * for a session that no longer existed, and the next sign-in inherited a
     * credential record claiming to be valid.
     *
     * Synced messages are deliberately **not** deleted: they are the user's
     * data, and signing out is not a request to discard their mail history.
     *
     * ## Scoped to this session's own mailbox in Phase 13.2
     *
     * This used to disconnect *every* mailbox the user had. That was
     * indistinguishable from correct while a user had one, and destructive once
     * they can have three: the MSAL cache purged above belongs to the mailbox
     * this session signed in with, so marking the other two disconnected would
     * revoke, in the CRM's records, credentials that were never purged and are
     * still perfectly valid — and the operator would have to reconnect
     * mailboxes that signing out never touched.
     *
     * Mailboxes connected from the Account page are attached to the CRM user,
     * not to a session, and survive sign-out. That is what makes them reusable
     * by the next authorised session, and it is why the Google logout path
     * reaches none of this: `account` is null there, so the whole block is
     * skipped and every connected mailbox is left intact.
     */
    const mailboxes = await Mailbox.find({ user: account.user, sourceAccount: account._id })

    for (const mailbox of mailboxes) {
      await ProviderToken.updateMany(
        { mailbox: mailbox._id },
        {
          $set: {
            status: CONNECTION_STATUS.DISCONNECTED,
            accessToken: null,
            refreshToken: null,
            expiresAt: null,
          },
        },
      )

      mailbox.status = CONNECTION_STATUS.DISCONNECTED
      mailbox.statusReason = 'signed_out'
      mailbox.disconnectedAt = new Date()
      await mailbox.save()
    }

    // A run interrupted by sign-out would otherwise hold folder locks until the
    // 15-minute TTL expired, blocking the next sign-in's first sync.
    await SyncState.updateMany(
      { user: account.user, lockedAt: { $ne: null } },
      { $set: { lockedAt: null } },
    )
  }

  // Recorded *before* the session is destroyed, so `req.auth.session` is still
  // there to attribute the entry to. This is the one place where recording
  // first is correct: the sign-out is already inevitable by this line.
  await recordAudit({
    req,
    event: 'GOOGLE_LOGOUT',
    summary: `${req.auth?.user?.email ?? 'A user'} signed out`,
    target: { id: session ? String(session._id) : null },
    metadata: { hadMicrosoftAccount: Boolean(account) },
  })

  await destroySession({ res, session })

  return sendSuccess(res, {
    message: 'Signed out successfully.',
    data: {
      signedOut: true,
      // Offered, not followed automatically: ending the Microsoft SSO session is
      // the user's choice, and forcing it would sign them out of other apps.
      microsoftSignOutUrl: buildLogoutUrl(clientUrl(config.client.postLoginPath)),
    },
  })
})

/**
 * GET /api/v1/auth/profile
 *
 * Returns the signed-in user's Microsoft profile, read live from Graph so the
 * response reflects changes made in Microsoft 365 since sign-in.
 *
 * Requires authentication.
 */
export const profile = asyncHandler(async (req, res) => {
  assertAuthEnabled()

  const { user, outlookAccount } = req.auth

  if (!outlookAccount || outlookAccount.disconnectedAt) {
    throw ApiError.forbidden(
      'No active Outlook connection for this session. Please reconnect your Microsoft account.',
    )
  }

  const graphProfile = await fetchUserProfile(outlookAccount._id.toString())

  return sendSuccess(res, {
    message: 'Profile retrieved successfully.',
    data: {
      user: user.toPublicJSON(),
      microsoft: {
        id: graphProfile.id ?? null,
        displayName: graphProfile.displayName ?? null,
        givenName: graphProfile.givenName ?? null,
        surname: graphProfile.surname ?? null,
        mail: graphProfile.mail ?? null,
        userPrincipalName: graphProfile.userPrincipalName ?? null,
        jobTitle: graphProfile.jobTitle ?? null,
        officeLocation: graphProfile.officeLocation ?? null,
        preferredLanguage: graphProfile.preferredLanguage ?? null,
      },
      connection: outlookAccount.toPublicJSON(),
    },
  })
})

/**
 * GET /api/v1/auth/status
 *
 * Reports whether the caller is signed in and whether Outlook is reachable.
 *
 * Intentionally open to anonymous callers — "not signed in" is a valid answer,
 * and the web client calls this on load to decide what to render. Returning 401
 * here would make an ordinary first visit look like a failure.
 *
 * `?verifyMailbox=true` additionally proves the Mail scopes work by making a real
 * Graph call. It is opt-in because it costs a round trip and consumes throttling
 * budget, which a poll-on-load should not do by default.
 */
export const status = asyncHandler(async (req, res) => {
  const isAuthenticated = Boolean(req.auth?.isAuthenticated)
  const account = req.auth?.outlookAccount ?? null

  /**
   * Connected mailboxes, which is what "can this workspace send mail?" now
   * depends on.
   *
   * Loaded only for an authenticated caller — an anonymous status check has no
   * workspace to read, and issuing the query anyway would put a database round
   * trip on the unauthenticated first page load.
   */
  const mailboxes = isAuthenticated
    ? await listMailboxes({ user: req.auth.user._id })
    : []

  const mailboxSummaries = mailboxes.map((mailbox) => mailbox.toPublicJSON())
  const sendableMailboxes = mailboxSummaries.filter((mailbox) => mailbox.canSend)

  const payload = {
    /**
     * Microsoft configuration. Unchanged, and still keyed `configured`.
     *
     * Renaming it would break the login page and the system screen, both of
     * which read it today. Google's own flag is added alongside rather than
     * folded into it — the two providers are independently configurable and a
     * single boolean could not express that.
     */
    configured: config.microsoft.enabled,

    /** Phase 13.1 — additive. True once a Google OAuth client is configured. */
    googleConfigured: config.google.enabled,

    /**
     * Phase 13.2 — whether Microsoft may still establish a CRM identity.
     *
     * Reported so the login page renders the server's actual policy rather than
     * inferring it. False here means `/auth/login` will bounce an anonymous
     * caller, so no client should offer the button.
     */
    microsoftSignInAllowed: config.microsoft.enabled && config.microsoft.allowSignIn,

    authenticated: isAuthenticated,

    /**
     * Kept, but its meaning is now correct rather than accidental.
     *
     * This used to be read from the *session's* Outlook account, which a Google
     * sign-in leaves null — so it reported "not connected" for a workspace with
     * healthy mailboxes, and the web client's route guard turned that into a
     * full-page block on every CRM page. That was the Phase 13.2 defect.
     *
     * It now answers the question its name implies: does this workspace have a
     * mailbox it can send through? The session account is still consulted so a
     * Microsoft-authenticated installation whose mailboxes have not been
     * materialised yet keeps reporting exactly what it always did.
     *
     * Consumers reading this key are unchanged. What changed is that it can no
     * longer be false while sending works, or true while it does not.
     */
    outlookConnected:
      sendableMailboxes.length > 0 || Boolean(account && !account.disconnectedAt),

    /** Phase 13.2 — the mailbox layer, additive. */
    mailboxes: mailboxSummaries,
    defaultMailboxId: mailboxSummaries.find((mailbox) => mailbox.isDefault)?.id ?? null,
    /** Whether any mail-sending UI should be enabled at all. */
    canSendMail: sendableMailboxes.length > 0,

    scopesRequested: config.microsoft.scopes,
    user: isAuthenticated ? req.auth.user.toPublicJSON() : null,
    connection: account ? account.toPublicJSON() : null,
    session: isAuthenticated
      ? {
          expiresAt: req.auth.session.expiresAt,
          lastUsedAt: req.auth.session.lastUsedAt,
        }
      : null,
    mailbox: null,
  }

  /**
   * The live probe targets whichever mailbox this workspace would actually send
   * from.
   *
   * `account._id` was safe while the session always carried one. It is not any
   * more: `outlookConnected` can now be true because a *connected mailbox*
   * exists while the session's own account is null, and dereferencing it there
   * would turn an opt-in health check into a 500 on the Account page.
   */
  if (req.query.verifyMailbox === 'true' && payload.outlookConnected) {
    const probeAccountId =
      sendableMailboxes.length > 0
        ? mailboxes.find((mailbox) => String(mailbox._id) === sendableMailboxes[0].id)
            ?.sourceAccount
        : account?._id

    payload.mailbox = probeAccountId
      ? await verifyMailboxAccess(probeAccountId.toString())
      : { reachable: false, reason: 'No mailbox credential is available to check.' }
  }

  return sendSuccess(res, {
    message: isAuthenticated ? 'Authenticated.' : 'Not authenticated.',
    data: payload,
  })
})

export default { login, callback, logout, profile, status }
