/**
 * The Microsoft OAuth round trip for administrator sign-in.
 *
 * Reuses `services/msal.service.js` unchanged — the same confidential client,
 * the same PKCE pair, the same redirect URI already registered in Entra ID. No
 * part of the Microsoft OAuth implementation is redesigned or duplicated; this
 * module only decides *why* a flow was started and *what to do* with the
 * identity that comes back.
 *
 * ## The flow is told apart by its recorded purpose, not by its path
 *
 * All three Microsoft flows in this product — legacy sign-in, mailbox connect,
 * and this — can return to the same redirect URI, because the callback
 * dispatches on the `purpose` written to `AuthFlow` *before* the redirect.
 * That is the mechanism Phase 13.3 introduced, and reusing it means an
 * administrator sign-in needs no new URI registered in the Entra ID portal.
 *
 * `consumeAdminFlow` refuses any purpose but its own, so a mailbox
 * authorisation redeemed here cannot open an admin session, and an admin flow
 * cannot be redeemed as a mailbox connection.
 */

import { AuthFlow, AUTH_FLOW_PURPOSE } from '../../../models/authFlow.model.js'
import { config } from '../../../config/index.js'
import { createPkcePair, generateOpaqueToken } from '../../../utils/crypto.js'
import { buildAuthorizationUrl, redeemAuthorizationCode } from '../../../services/msal.service.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { ADMIN_SIGN_IN_ERROR } from './adminIdentity.service.js'

const log = createContextLogger('admin-auth')

/**
 * Starts an administrator sign-in.
 *
 * @param {{ req: object }} params
 * @returns {Promise<{ authorizationUrl: string, state: string }>}
 */
export async function beginAdminSignIn({ req }) {
  const state = generateOpaqueToken(32)
  const { codeVerifier, codeChallenge } = createPkcePair()

  // Persisted before the redirect, so the callback can only succeed for a flow
  // this server actually started — and can only be redeemed once.
  await AuthFlow.create({
    state,
    codeVerifier,
    purpose: AUTH_FLOW_PURPOSE.ADMIN_SIGN_IN,
    expiresAt: new Date(Date.now() + config.session.authFlowTtlMs),
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  })

  const authorizationUrl = await buildAuthorizationUrl({ state, codeChallenge })

  log.info('Administrator sign-in flow started', { requestId: req.id })

  return { authorizationUrl, state }
}

/**
 * Consumes the flow, verifying `state` and purpose.
 *
 * `findOneAndDelete` makes consumption atomic, so two callbacks carrying the
 * same state cannot both succeed — which is what prevents authorization-code
 * replay.
 */
async function consumeAdminFlow(state) {
  const flow = await AuthFlow.findOneAndDelete({ state })

  if (!flow) {
    throw ApiError.unauthorized('This sign-in link is invalid or has already been used.', {
      details: { reason: ADMIN_SIGN_IN_ERROR.FLOW_INVALID },
    })
  }

  if (flow.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('This sign-in attempt expired. Please start again.', {
      details: { reason: ADMIN_SIGN_IN_ERROR.FLOW_INVALID },
    })
  }

  /**
   * A flow started for anything else may not be redeemed here.
   *
   * Without this, clicking "Connect Microsoft mailbox" and being returned to
   * the shared redirect URI could open an administrator session — the same
   * class of confusion Phase 13.3 fixed for the mailbox path, applied in the
   * other direction.
   */
  if (flow.purpose !== AUTH_FLOW_PURPOSE.ADMIN_SIGN_IN) {
    log.warn('An administrator callback received a flow started for something else', {
      purpose: flow.purpose,
    })

    throw ApiError.unauthorized('That sign-in link was not an administrator sign-in.', {
      details: { reason: ADMIN_SIGN_IN_ERROR.FLOW_INVALID },
    })
  }

  return flow
}

/**
 * Redeems the code and returns the verified claims.
 *
 * Deliberately stops at the claims. Turning them into a CRM user is
 * `adminIdentity.service.js`'s job, and keeping the two apart means the account
 * rules can be read and argued about without also reading a token exchange.
 *
 * **The MSAL token cache is discarded.** This flow proves identity and requests
 * no mail scopes, so persisting a cache would store a credential nothing is
 * going to use — and would put a Microsoft token on a record whose mailbox
 * credentials are managed by an entirely separate module.
 *
 * @param {{ code: string, state: string }} params
 * @returns {Promise<{ claims: object }>}
 */
export async function completeAdminSignIn({ code, state }) {
  const flow = await consumeAdminFlow(state)

  const { result } = await redeemAuthorizationCode({
    code,
    codeVerifier: flow.codeVerifier,
  })

  const claims = result?.account?.idTokenClaims ?? null

  if (!claims) {
    throw ApiError.unauthorized('Microsoft did not return an identity.', {
      details: { reason: ADMIN_SIGN_IN_ERROR.EXCHANGE_FAILED },
    })
  }

  return { claims }
}

export default { beginAdminSignIn, completeAdminSignIn }
