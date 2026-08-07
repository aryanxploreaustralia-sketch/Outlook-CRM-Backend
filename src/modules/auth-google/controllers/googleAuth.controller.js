/**
 * Google sign-in endpoints.
 *
 * Two handlers, both reached by **top-level browser navigation**, so both
 * respond with redirects rather than JSON — the same reasoning the Microsoft
 * `/login` and `/callback` handlers document. Rendering an API error object on
 * a blank page is not a sign-in experience.
 *
 * ## Where this ends
 *
 * `createSession(...)` — the application's existing session service, unchanged.
 * That single call is the entire integration surface with the rest of the CRM.
 * From the moment it returns, a Google-authenticated request is
 * indistinguishable from a Microsoft-authenticated one: the same signed
 * HTTP-only cookie, the same `Session` document, the same `req.auth` shape,
 * the same `requireAuth` and `requireRole` middleware. Nothing downstream was
 * taught about Google, and nothing needed to be.
 */

import { config } from '../../../config/index.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { GoogleAuthFlow } from '../../../models/googleAuthFlow.model.js'
import { sanitiseReturnPath } from '../../../services/auth.service.js'
import { createSession } from '../../../services/session.service.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { generateOpaqueToken } from '../../../utils/crypto.js'
import { createContextLogger } from '../../../utils/logger.js'
import { GOOGLE_AUTH_ERROR, GOOGLE_FLOW_TTL_MS } from '../constants/googleAuth.constants.js'
import { resolveGoogleUser } from '../services/googleIdentity.service.js'
import {
  assertGoogleConfigured,
  buildAuthorisationUrl,
  createFlowSecrets,
  exchangeCode,
  verifyIdToken,
} from '../services/googleOAuth.service.js'

const log = createContextLogger('google-auth')

/** Builds an absolute URL into the web client. */
function clientUrl(pathname, params = {}) {
  const url = new URL(pathname, config.client.url)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * Sends the browser back to the public sign-in page with a reason.
 *
 * The login page, not the post-login path: that one sits behind a route guard
 * which would bounce an unauthenticated browser and discard the message before
 * the user ever saw it. Identical reasoning to the Microsoft callback.
 */
function redirectFailure(res, reason) {
  res.redirect(
    HTTP_STATUS.FOUND,
    clientUrl(config.client.loginPath, { auth: 'error', reason }),
  )
}

/**
 * GET /api/v1/auth/google
 *
 * Starts the flow: mints PKCE and nonce values, records them, and redirects.
 */
export const start = asyncHandler(async (req, res) => {
  assertGoogleConfigured()

  const state = generateOpaqueToken(32)
  const { codeVerifier, codeChallenge, nonce } = createFlowSecrets()

  // Persisted before the redirect, so a callback can only succeed for a flow
  // this server actually started.
  await GoogleAuthFlow.create({
    state,
    codeVerifier,
    nonce,
    returnPath: sanitiseReturnPath(req.query.returnPath),
    expiresAt: new Date(Date.now() + GOOGLE_FLOW_TTL_MS),
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  })

  log.info('Google sign-in flow started', { requestId: req.id })

  // 302 rather than 307: the browser must issue a fresh GET to Google.
  res.redirect(HTTP_STATUS.FOUND, buildAuthorisationUrl({ state, codeChallenge, nonce }))
})

/**
 * GET /api/v1/auth/google/callback
 *
 * The redirect URI registered in the Google Cloud Console.
 */
export const callback = asyncHandler(async (req, res) => {
  // Configuration is checked first: without it there is nothing to verify a
  // callback against, and proceeding would be guesswork.
  try {
    assertGoogleConfigured()
  } catch {
    redirectFailure(res, GOOGLE_AUTH_ERROR.NOT_CONFIGURED)
    return
  }

  const { code, state, error: providerError } = req.query

  // The user declined consent or closed the Google prompt.
  if (providerError) {
    log.warn('Google returned an error to the OAuth callback', {
      requestId: req.id,
      error: String(providerError).slice(0, 200),
    })
    redirectFailure(res, String(providerError).slice(0, 64))
    return
  }

  if (!code || !state) {
    redirectFailure(res, GOOGLE_AUTH_ERROR.FLOW_INVALID)
    return
  }

  /**
   * Consumed atomically.
   *
   * `findOneAndDelete` means two concurrent callbacks carrying the same state
   * cannot both succeed, which is what prevents authorization-code replay. The
   * same primitive the Microsoft flow relies on.
   */
  const flow = await GoogleAuthFlow.findOneAndDelete({ state: String(state) })

  if (!flow || flow.expiresAt.getTime() <= Date.now()) {
    log.warn('Google callback presented an unknown or expired state', { requestId: req.id })
    redirectFailure(res, GOOGLE_AUTH_ERROR.FLOW_INVALID)
    return
  }

  try {
    const { idToken } = await exchangeCode({
      code: String(code),
      codeVerifier: flow.codeVerifier,
    })

    const claims = await verifyIdToken({ idToken, expectedNonce: flow.nonce })

    const { user, isNew, linkedExisting } = await resolveGoogleUser({ claims })

    /**
     * The existing session service. No second mechanism is introduced.
     *
     * `outlookAccountId: null` is correct and deliberate — a Google sign-in
     * establishes identity only. `Session.outlookAccount` has always defaulted
     * to null and `requireAuth` has never required it, so every authenticated
     * route works immediately. The three routes that genuinely need a mailbox
     * (`/mail/send`, `/mail/draft`, `/templates/test-email`) are already gated
     * by `requireOutlookConnection` and correctly continue to refuse until a
     * mailbox is connected in Phase 13.2.
     */
    await createSession({
      req,
      res,
      userId: user._id,
      outlookAccountId: null,
    })

    log.info('Google sign-in completed', {
      requestId: req.id,
      userId: String(user._id),
      isNew,
      linkedExisting,
    })

    res.redirect(
      HTTP_STATUS.FOUND,
      clientUrl(flow.returnPath ?? config.client.postLoginPath, { auth: 'success' }),
    )
  } catch (error) {
    // Logged in full server-side; the browser learns only a reason code.
    log.error('Google sign-in callback failed', {
      requestId: req.id,
      code: error.code,
      message: error.message,
    })

    redirectFailure(res, error.code ?? 'sign_in_failed')
  }
})

export default { start, callback }
