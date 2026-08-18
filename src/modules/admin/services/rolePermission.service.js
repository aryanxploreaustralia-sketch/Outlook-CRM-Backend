/**
 * Reading and rewriting role definitions.
 *
 * The rules below are the whole point of this module. A permission editor with
 * no rails is a button that lets an administrator remove their own ability to
 * press it, and every one of these checks exists because a plausible sequence of
 * clicks ends somewhere the interface cannot recover from.
 *
 * All of them are enforced **here**, on the server. The console mirrors some of
 * them so the reader is not offered something that will be refused, but nothing
 * depends on the console honouring them: every rule is re-checked against the
 * request's own actor before anything is written.
 */

import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { RolePermission } from '../../../models/rolePermission.model.js'
import { User } from '../../../models/user.model.js'
import { PERMISSIONS, PERMISSION_VALUES } from '../../../constants/permissions.js'
import { ROLES } from '../../../constants/roles.js'
import { USER_STATUS } from '../../../constants/userStatus.js'
import {
  EDITABLE_ROLES,
  defaultPermissionListForRole,
  permissionsForRole,
  setRoleOverrides,
} from '../../../constants/roleMatrix.js'

const log = createContextLogger('role-permissions')

/**
 * Permissions that must never vanish from the deployment.
 *
 * Not "must never be revoked" — a role may lose them. What must not happen is
 * the *last* active account holding one losing it, because these are the
 * permissions the recovery path itself needs. `roles.manage` edits roles;
 * `roles.view` and `users.view` are what the console needs to show the screen
 * the edit happens on. Lose all three and the only way back is a database
 * client.
 */
const IRREVOCABLE_PERMISSIONS = Object.freeze([
  PERMISSIONS.ROLES_MANAGE,
  PERMISSIONS.ROLES_VIEW,
  PERMISSIONS.USERS_VIEW,
])

/**
 * How long a process may serve a cached overlay before re-reading it.
 *
 * The overlay is refreshed immediately in whichever process handled the write.
 * A second process — another instance, a worker — learns about the change on its
 * next check, so this is the ceiling on how long two processes can disagree
 * about a role. Thirty seconds is short enough that an administrator testing a
 * change does not conclude it failed, and long enough that the read costs
 * nothing measurable.
 */
const OVERRIDE_TTL_MS = 30_000

let lastLoadedAt = 0
let inFlight = null

/** Reads every stored override and installs it into the matrix overlay. */
export async function refreshRoleOverrides() {
  const rows = await RolePermission.find().select('role permissions').lean()

  setRoleOverrides(Object.fromEntries(rows.map((row) => [row.role, row.permissions ?? []])))
  lastLoadedAt = Date.now()

  return rows.length
}

/**
 * Refreshes the overlay if it has gone stale, and only once concurrently.
 *
 * Awaited from `authenticate`, which is already async — that is what lets the
 * lookup itself stay synchronous. The in-flight promise is shared so a burst of
 * requests arriving after the TTL expires produces one query rather than one
 * per request.
 *
 * A failed read is logged and swallowed: the process keeps serving the overlay
 * it already has. Refusing every request because a refresh failed would turn a
 * transient database blip into a total outage, and the cached answer is the one
 * that was correct a moment ago.
 */
export async function ensureRoleOverridesFresh() {
  if (Date.now() - lastLoadedAt < OVERRIDE_TTL_MS) return
  if (inFlight) return inFlight

  inFlight = refreshRoleOverrides()
    .catch((error) => {
      log.warn(`Role override refresh failed; serving the cached matrix: ${error.message}`)
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}

/**
 * Rewrites one role's permissions.
 *
 * @param {{ role: string, permissions: string[], actor: object, req?: object }} input
 */
export async function updateRolePermissions({ role, permissions, actor }) {
  // --- The role itself ----------------------------------------------------
  if (!EDITABLE_ROLES.includes(role)) {
    throw ApiError.forbidden(
      role === ROLES.OWNER
        ? 'The Owner role cannot be changed. It is the recovery path for every other role.'
        : 'That role cannot be edited.',
      { code: 'ROLE_NOT_EDITABLE' },
    )
  }

  // --- The permission strings ---------------------------------------------
  const requested = [...new Set(permissions)]
  const unknown = requested.filter((permission) => !PERMISSION_VALUES.includes(permission))
  if (unknown.length > 0) {
    throw ApiError.badRequest(`Unknown permission: ${unknown.join(', ')}.`, {
      code: 'UNKNOWN_PERMISSION',
    })
  }

  /*
   * `OWNER_ONLY_PERMISSIONS` is a **default**, not a ceiling.
   *
   * It still builds the matrix — Administrator's built-in bundle is everything
   * except those two, which is why the role starts at 36 of 38. What it no
   * longer does is refuse them at this endpoint: an owner may now grant
   * `users.invite` to a role that should have it, which is the entire point of
   * a permission editor.
   *
   * That is only safe because the escalation it was guarding is now blocked
   * where it actually happens. `inviteUser` applies `assignableRolesFor`, so an
   * administrator holding `users.invite` can invite a manager, sales, support or
   * viewer — and cannot invite an owner or a peer administrator. The route that
   * would have handed somebody a senior identity is closed at the route, rather
   * than by withholding the permission from everyone forever.
   *
   * The actor ceiling immediately below is what still prevents escalation here:
   * nobody grants a permission they do not themselves hold.
   */

  // --- The actor ----------------------------------------------------------
  /*
   * Nobody edits the role they themselves hold.
   *
   * This is the self-lockout rule, and it is deliberately blunt rather than
   * clever. The subtle version — allow the edit, then check whether the actor
   * still holds what they need — has to be right about every permission the
   * console depends on, forever, including ones added later. Refusing outright
   * cannot rot: an administrator changes the Administrator role by asking the
   * Owner, who is exactly the account that exists for this.
   */
  if (actor.role === role) {
    throw ApiError.forbidden(
      'You cannot edit your own role. Ask an Owner to make this change.',
      { code: 'CANNOT_EDIT_OWN_ROLE' },
    )
  }

  /*
   * No granting what you do not hold.
   *
   * Without this an administrator could write a permission they lack into a
   * role, assign themselves that role — or simply use an account that has it —
   * and arrive at access the matrix never gave them. Escalation by two legal
   * steps is still escalation.
   */
  const actorHolds = permissionsForRole(actor.role)
  const beyondActor = requested.filter((permission) => !actorHolds.has(permission))
  if (beyondActor.length > 0) {
    throw ApiError.forbidden(
      `You cannot grant permissions you do not hold: ${beyondActor.join(', ')}.`,
      { code: 'PERMISSION_BEYOND_ACTOR' },
    )
  }

  // --- The deployment as a whole ------------------------------------------
  const previous = [...permissionsForRole(role)].sort()
  const granted = requested.filter((permission) => !previous.includes(permission)).sort()
  const revoked = previous.filter((permission) => !requested.includes(permission)).sort()

  if (granted.length === 0 && revoked.length === 0) {
    return { role, permissions: previous, granted: [], revoked: [], unchanged: true }
  }

  /*
   * Would this leave nobody able to administer the deployment?
   *
   * Counted over **active accounts**, not roles: a permission held only by a
   * role nobody occupies is not held. The check runs against the state after the
   * change, and only for permissions actually being revoked — granting can never
   * cause a lockout, so it is not made slower by this.
   */
  const atRisk = revoked.filter((permission) => IRREVOCABLE_PERMISSIONS.includes(permission))
  if (atRisk.length > 0) {
    const holders = await User.find({
      status: USER_STATUS.ACTIVE,
      isDeleted: { $ne: true },
    })
      .select('role')
      .lean()

    for (const permission of atRisk) {
      const stillHeld = holders.some((user) =>
        // The role being edited answers from the proposed list; every other role
        // from what it holds now.
        user.role === role ? requested.includes(permission) : permissionsForRole(user.role).has(permission),
      )

      if (!stillHeld) {
        throw ApiError.forbidden(
          `Revoking ${permission} would leave no active user able to administer this deployment.`,
          { code: 'LAST_ADMINISTRATOR' },
        )
      }
    }
  }

  // --- Write --------------------------------------------------------------
  const isDefault = (() => {
    const defaults = defaultPermissionListForRole(role)
    return defaults.length === requested.length && defaults.every((p) => requested.includes(p))
  })()

  if (isDefault) {
    // Back to the built-in bundle: delete the row rather than store a copy of
    // the default. A stored copy would silently pin the role to today's default
    // and stop tracking a later release that changes it.
    await RolePermission.deleteOne({ role })
  } else {
    await RolePermission.findOneAndUpdate(
      { role },
      { role, permissions: requested.sort(), updatedBy: actor._id },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
  }

  // Immediately, in this process. Others pick it up within the TTL.
  await refreshRoleOverrides()

  return {
    role,
    permissions: [...permissionsForRole(role)].sort(),
    granted,
    revoked,
    unchanged: false,
    resetToDefault: isDefault,
  }
}

export default { updateRolePermissions, refreshRoleOverrides, ensureRoleOverridesFresh }
