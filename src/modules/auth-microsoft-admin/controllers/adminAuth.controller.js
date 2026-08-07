/**
 * Administrator sign-in with Microsoft.
 *
 * ## The role gate is here, on the server, and it is the only one that counts
 *
 * The brief asks for "Microsoft login lands in the admin portal". The redirect
 * that performs that landing is a convenience. The control is this: a session
 * is created **only** for an account that holds admin-portal access, and for
 * anybody else the callback creates no session at all and redirects to a
 * refusal page.
 *
 * That ordering matters. A version that signed everybody in and then let the
 * client decide where to send them would be a system where the refusal is a
 * page the browser chose to render — and the browser is not a security
 * boundary. Here a manager who reaches `/admin` by typing it has no session to
 * carry, and every admin endpoint independently re-checks its own permission
 * anyway.
 *
 * ## Why a role check and not a permission check
 *
 * Everything else in this product gates on a permission, and that is still
 * true of every admin route. This one is the documented exception the brief
 * calls the "bootstrap check": the question is not "may you do X" but "does the
 * admin portal exist for you at all", which is answered by
 * `isOrganizationAdministrator()` — itself derived from the permission matrix
 * rather than a hardcoded list of role names.
 *
 * Note it is narrower than `roleHasAdminAccess()`, which a manager satisfies
 * because they legitimately see cross-user analytics. A manager is not an
 * organization administrator and this door is not for them.
 */

import { config } from '../../../config/index.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { isOrganizationAdministrator } from '../../../constants/roleMatrix.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { createSession } from '../../../services/session.service.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import { beginAdminSignIn, completeAdminSignIn } from '../services/adminAuthFlow.service.js'
import { ADMIN_SIGN_IN_ERROR, resolveAdminUser } from '../services/adminIdentity.service.js'

const log = createContextLogger('admin-auth')

/** Where the console lives. The one place this path is written down. */
export const ADMIN_PORTAL_PATH = '/admin'

/** Builds an absolute client URL with query parameters. */
function clientUrl(pathname, params = {}) {
  const url = new URL(pathname, config.client.url)

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }

  return url.toString()
}

/** Refuses when Azure credentials are absent, with actionable guidance. */
function assertConfigured() {
  if (config.microsoft.enabled) return

  throw ApiError.serviceUnavailable(
    'Microsoft sign-in is not configured on this deployment. Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_TENANT_ID.',
  )
}

/**
 * GET /api/v1/auth/microsoft/admin/login
 *
 * Starts the flow and redirects to Microsoft.
 *
 * Deliberately **not** gated on `MICROSOFT_ALLOW_SIGN_IN`. That flag governs
 * the legacy flow that mints a CRM user per Microsoft account — the Phase 13.2
 * defect — and this flow cannot create a user at all, so the reason the flag
 * exists does not apply to it. Sharing the flag would mean a deployment could
 * not have administrator sign-in without also re-enabling the broken path.
 */
export const adminLogin = asyncHandler(async (req, res) => {
  assertConfigured()

  const { authorizationUrl } = await beginAdminSignIn({ req })

  return res.redirect(HTTP_STATUS.FOUND, authorizationUrl)
})

/**
 * GET /api/v1/auth/microsoft/admin/callback
 *
 * Where Microsoft returns. Always redirects to the browser; never renders JSON.
 *
 * Every failure path funnels to the login page with a `reason` code rather than
 * a message, so the copy lives in the client and the server does not leak
 * whether a particular address has an account. `no_account` and `suspended`
 * are distinct codes because an administrator seeing them needs to know which
 * — but both render the same "access denied" page to the person refused.
 */
export const adminCallback = asyncHandler(async (req, res) => {
  const { code, state, error: providerError } = req.query

  const fail = (reason) =>
    res.redirect(HTTP_STATUS.FOUND, clientUrl(config.client.loginPath, { admin: 'error', reason }))

  if (!config.microsoft.enabled) return fail('not_configured')

  // The user cancelled at the Microsoft prompt, or declined consent.
  if (providerError) {
    log.warn('Microsoft returned an error to the administrator callback', {
      requestId: req.id,
      error: String(providerError).slice(0, 200),
    })

    return fail(String(providerError).slice(0, 64))
  }

  if (!code || !state) return fail(ADMIN_SIGN_IN_ERROR.FLOW_INVALID)

  let user
  try {
    const { claims } = await completeAdminSignIn({ code: String(code), state: String(state) })
    const resolved = await resolveAdminUser({ claims })
    user = resolved.user

    if (resolved.linkedExisting) {
      await recordAudit({
        req,
        actor: user,
        event: 'MICROSOFT_CONNECTED',
        summary: `Linked a Microsoft identity to ${user.email}`,
        target: { type: 'user', id: String(user._id), name: user.email },
        metadata: { provider: 'microsoft', purpose: 'admin_sign_in' },
      })
    }
  } catch (error) {
    log.warn('Administrator sign-in failed', {
      requestId: req.id,
      code: error.code,
      reason: error.details?.reason ?? null,
      message: error.message,
    })

    await recordAudit({
      req,
      event: 'LOGIN_FAILED',
      result: 'failure',
      resultReason: error.details?.reason ?? 'admin_sign_in_failed',
      summary: 'Administrator sign-in attempt failed',
      metadata: { provider: 'microsoft', reason: error.details?.reason ?? null },
    })

    return fail(error.details?.reason ?? ADMIN_SIGN_IN_ERROR.EXCHANGE_FAILED)
  }

  /**
   * The gate.
   *
   * Checked **before** `createSession`, so a refused person leaves with no
   * cookie. Signing them in and then redirecting them away would give a
   * non-administrator a valid CRM session obtained through the admin door,
   * which is a different and worse outcome than refusing them.
   */
  if (!isOrganizationAdministrator(user.role)) {
    log.warn('Administrator sign-in refused: the account is not an administrator', {
      userId: String(user._id),
      role: user.role,
    })

    await recordAudit({
      req,
      actor: user,
      event: 'PERMISSION_DENIED',
      result: 'denied',
      resultReason: ADMIN_SIGN_IN_ERROR.NOT_ADMIN,
      summary: `${user.email} attempted administrator sign-in without administrator access`,
      target: { type: 'user', id: String(user._id), name: user.email },
      metadata: { role: user.role, provider: 'microsoft' },
    })

    return fail(ADMIN_SIGN_IN_ERROR.NOT_ADMIN)
  }

  await createSession({ req, res, userId: user._id })

  await recordAudit({
    req,
    actor: user,
    event: 'MICROSOFT_LOGIN',
    summary: `${user.email} signed in with Microsoft as ${user.role}`,
    target: { id: String(user._id), name: user.email },
    metadata: { provider: 'microsoft', portal: 'admin', role: user.role },
  })

  log.info('Administrator signed in with Microsoft', {
    userId: String(user._id),
    role: user.role,
  })

  // Straight into the console. The brief's "no manual /admin navigation".
  return res.redirect(HTTP_STATUS.FOUND, clientUrl(ADMIN_PORTAL_PATH, { auth: 'success' }))
})

export default { adminCallback, adminLogin }
