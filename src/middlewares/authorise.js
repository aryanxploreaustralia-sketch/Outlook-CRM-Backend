/**
 * Authorization.
 *
 * Authentication answers *who are you*, and `authenticate.js` owns it. This file
 * answers *what may you do*, and it is the only file that does.
 *
 * ## Permissions, not roles
 *
 * Phase 14.4 replaced role checks with permission checks. The difference is not
 * cosmetic:
 *
 *  - `requireRole(['owner','admin'])` states *who* may pass, so every route has
 *    to be found and edited whenever the role list changes, and the answer to
 *    "what can a Manager do?" is only discoverable by grepping.
 *  - `requirePermission(LEADS_DELETE)` states *what is being done*. The role
 *    matrix answers the question in one table, and adding a role changes no
 *    route at all.
 *
 * ## Failure is 403, never 404
 *
 * A permission failure means the resource exists and you may not act on it. 404
 * would be a lie, and one that costs real debugging time — an operator seeing
 * "not found" investigates a missing record rather than a missing grant.
 *
 * 401 is likewise wrong here: the caller *is* authenticated. `requireAuth` has
 * already run and would have refused an anonymous request.
 */

import { ROLE_LABELS, ROLES } from '../constants/roles.js'
import { PERMISSION_LABELS, isPermission } from '../constants/permissions.js'
import { permissionsForRole } from '../constants/roleMatrix.js'
import { ApiError } from '../utils/ApiError.js'
import { recordAudit } from '../modules/audit/services/auditRecorder.service.js'

/**
 * Resolves the caller's permissions.
 *
 * Derived from the role on **the user document loaded for this request**, not
 * from anything cached in a token — `requireAuth` re-reads the user on every
 * call, so a role change takes effect on the caller's very next request with no
 * revocation problem. That property is inherited from the session design and is
 * worth not giving up.
 *
 * Memoised per request because a route can carry more than one guard and the
 * resolution is otherwise repeated for each.
 *
 * @param {import('express').Request} req
 * @returns {Set<string>}
 */
export function resolvePermissions(req) {
  if (req.permissions) return req.permissions

  const role = req.auth?.user?.role ?? null
  req.permissions = permissionsForRole(role)

  return req.permissions
}

/**
 * Whether the caller holds a permission. The single predicate everything uses.
 *
 * @param {import('express').Request} req
 * @param {string} permission
 * @returns {boolean}
 */
export function hasPermission(req, permission) {
  return resolvePermissions(req).has(permission)
}

/**
 * Validates a guard's arguments at **import time**.
 *
 * A guard built from a typo would deny everybody, silently, forever — and it
 * would look exactly like a correctly-configured guard, which is what makes it
 * the worst available failure mode. Throwing here means the mistake is a boot
 * failure with the offending string in the message, not a support ticket.
 */
function assertPermissions(permissions, factory) {
  if (permissions.length === 0) {
    throw new Error(`${factory}() was called with no permissions.`)
  }

  const unknown = permissions.filter((permission) => !isPermission(permission))

  if (unknown.length > 0) {
    throw new Error(
      `${factory}() was given ${unknown.length} unregistered permission(s): ${unknown.join(', ')}. ` +
        'Every permission must be defined in constants/permissions.js.',
    )
  }
}

/**
 * Builds the refusal.
 *
 * Names the permission and the caller's role, because the two questions an
 * operator asks next are "what did I need?" and "what am I?". Answering both in
 * the message saves a round trip through somebody else's logs.
 *
 * The permission strings are not sensitive: they are the same catalogue
 * `/admin/me/permissions` serves to every authenticated client.
 */
function refuse(req, required, mode) {
  const role = req.auth?.user?.role ?? 'unknown'
  const roleLabel = ROLE_LABELS[role] ?? role

  const described = required.map((permission) => PERMISSION_LABELS[permission] ?? permission)

  const requirement =
    required.length === 1
      ? `“${described[0]}”`
      : mode === 'all'
        ? `all of: ${described.join(', ')}`
        : `one of: ${described.join(', ')}`

  /**
   * Phase 14.7: every refusal is recorded.
   *
   * `refuse()` is the single point every permission denial passes through, so
   * one call here covers the whole permission engine — no guard, no route and
   * no future middleware can deny access without it being logged.
   *
   * Deliberately **not awaited**. `refuse()` is synchronous and returns the
   * error its callers pass to `next()`; awaiting would make the whole guard
   * async and change the middleware's shape, which is exactly the kind of
   * redesign this phase must not do. `recordAudit` never rejects — it catches
   * everything internally — so a floating promise here cannot produce an
   * unhandled rejection.
   *
   * Every denial is recorded rather than sampled or throttled. An incomplete
   * security log is worse than a large one: the entry somebody would suppress
   * is precisely the one worth keeping, and the route rate limiters already
   * bound how fast these can arrive.
   */
  void recordAudit({
    req,
    event: 'PERMISSION_DENIED',
    result: 'denied',
    resultReason: 'insufficient_permission',
    summary: `Denied ${req.method} ${req.originalUrl ?? req.url} — requires ${requirement}`,
    target: { type: 'system', name: req.originalUrl ?? req.url ?? null },
    metadata: { required, mode, role },
  })

  return ApiError.forbidden(
    `You do not have permission to do this. It requires ${requirement}, and your account is ${roleLabel}.`,
    { details: { reason: 'insufficient_permission', required, mode, role } },
  )
}

/**
 * Guards a route on a single permission.
 *
 * @param {string} permission
 * @returns {import('express').RequestHandler}
 */
export function requirePermission(permission) {
  assertPermissions([permission], 'requirePermission')

  return function permissionGuard(req, _res, next) {
    // `requireAuth` runs first and would already have rejected this. Checked
    // anyway, because a guard that assumes its predecessor ran is a guard that
    // stops working the day somebody reorders the middleware.
    if (!req.auth?.user) {
      next(ApiError.unauthorized('You must sign in to perform this action.'))
      return
    }

    if (!hasPermission(req, permission)) {
      next(refuse(req, [permission], 'any'))
      return
    }

    next()
  }
}

/**
 * Passes when the caller holds **any** of the permissions.
 *
 * For endpoints reachable from more than one capability — the admin shell, which
 * several distinct admin permissions should all open.
 *
 * @param {string[]} permissions
 * @returns {import('express').RequestHandler}
 */
export function requireAnyPermission(permissions) {
  assertPermissions(permissions, 'requireAnyPermission')

  return function anyPermissionGuard(req, _res, next) {
    if (!req.auth?.user) {
      next(ApiError.unauthorized('You must sign in to perform this action.'))
      return
    }

    if (!permissions.some((permission) => hasPermission(req, permission))) {
      next(refuse(req, permissions, 'any'))
      return
    }

    next()
  }
}

/**
 * Passes only when the caller holds **every** permission.
 *
 * For actions that genuinely combine two capabilities — exporting the register
 * needs both the right to read it and the right to take it out of the CRM.
 *
 * @param {string[]} permissions
 * @returns {import('express').RequestHandler}
 */
export function requireAllPermissions(permissions) {
  assertPermissions(permissions, 'requireAllPermissions')

  return function allPermissionsGuard(req, _res, next) {
    if (!req.auth?.user) {
      next(ApiError.unauthorized('You must sign in to perform this action.'))
      return
    }

    const missing = permissions.filter((permission) => !hasPermission(req, permission))

    if (missing.length > 0) {
      next(refuse(req, missing, 'all'))
      return
    }

    next()
  }
}

// ---------------------------------------------------------------------------
// Legacy
// ---------------------------------------------------------------------------

/**
 * Roles allowed to destroy data.
 *
 * @deprecated Superseded by permissions in Phase 14.4. Re-exported from
 *   `constants/roles.js` so that any import of it keeps resolving.
 */
export { DESTRUCTIVE_ROLES } from '../constants/roles.js'

/**
 * Refuses a request whose user does not hold one of `allowed`.
 *
 * Retained so nothing that imported it breaks, and because a role check is still
 * the right tool for the rare rule that is genuinely *about* a role rather than
 * a capability. Every route that used it was converted in Phase 14.4.
 *
 * @deprecated Use `requirePermission()` and name the capability.
 * @param {string[]} allowed
 * @returns {import('express').RequestHandler}
 */
export function requireRole(allowed) {
  const permitted = new Set(allowed)

  return function roleGuard(req, _res, next) {
    const user = req.auth?.user

    if (!user) {
      next(ApiError.unauthorized('You must sign in to perform this action.'))
      return
    }

    if (!permitted.has(user.role)) {
      next(
        ApiError.forbidden(
          `This action requires ${[...permitted].join(' or ')} access. Your account is ${user.role}.`,
          { details: { reason: 'insufficient_role', required: allowed, role: user.role } },
        ),
      )
      return
    }

    next()
  }
}

export default requirePermission

/** Re-exported for guards that need the owner constant directly. */
export { ROLES }
