/**
 * The role matrix: which permissions each system role holds.
 *
 * **The one place that answers "what can a Manager do?"** Nothing else in the
 * codebase maps a role to a capability, and nothing branches on a role name.
 *
 * ## System roles, fixed in this phase
 *
 * These bundles are constants, not documents. The brief is explicit that no
 * `Role` or `Permission` collection is created — so a deployment cannot drift
 * from this file, and reading it tells you the whole authorization model.
 *
 * ## The property that made enforcement safe to switch on
 *
 * `OWNER` holds every permission, and every account in this deployment holds
 * `OWNER`. So turning enforcement on changed nobody's access on the day it
 * shipped. Grading people down is a deliberate act taken afterwards, one account
 * at a time — never a side effect of the mechanism arriving.
 */

import { ADMIN_SURFACE_PERMISSIONS, PERMISSIONS, PERMISSION_VALUES } from './permissions.js'
import { ROLES } from './roles.js'

const P = PERMISSIONS

/**
 * Reserved to the account holder.
 *
 * Both grant *authority over authority*: changing what a role may do, and
 * changing the organization the roles exist within. An Administrator runs the
 * platform; only the Owner redefines the rules it runs by.
 */
/**
 * Held by the owner and nobody else.
 *
 * ## `ROLES_MANAGE` left this list in Phase 14.8A
 *
 * It was owner-only, which made the brief's rule — "an admin may assign
 * manager, sales, support and viewer" — impossible to express: an admin who
 * cannot reach the endpoint cannot assign anything.
 *
 * The permission now answers only "may this person manage roles at all", and
 * `constants/roleAssignment.js` answers which targets and which roles. That
 * split is what keeps the finer rules out of the permission engine, where they
 * cannot be expressed: no permission bitmap can say "an admin may not modify
 * another admin", because that is a fact about two people rather than a
 * capability held by one.
 *
 * The admin's ceiling is not weakened by this. `canAssignRole` refuses an admin
 * granting owner or admin, and refuses an admin modifying a peer or a senior —
 * enforced inside the endpoint, not in the interface.
 */
export const OWNER_ONLY_PERMISSIONS = Object.freeze([
  P.ORGANIZATION_MANAGE,
  /**
   * `USERS_INVITE` became owner-only in Phase 14.8C.
   *
   * The brief is explicit: "Only an Organization Owner may invite users." It
   * follows from what an invitation now is — an invitation carries a role, and
   * since 14.8C it can also carry a Microsoft address, so inviting is the act
   * of deciding who enters the organization and with what authority. An admin
   * who could invite could create a Microsoft owner invitation and hand
   * themselves a second, senior identity.
   *
   * An admin retains `roles.manage` and can still promote and demote existing
   * accounts within their ceiling (manager, sales, support, viewer). What they
   * can no longer do is bring somebody new into the organization.
   */
  P.USERS_INVITE,
])

/**
 * Everything a person can read across the CRM, without changing anything.
 *
 * ## What is deliberately not in here
 *
 * `ORGANIZATION_VIEW`. It reads as a harmless read, and the Phase 14.0 design
 * granted it to every role — but the only surface that consumes it is the admin
 * console's Organization screen, and `ADMIN_SURFACE_PERMISSIONS` treats holding
 * it as grounds to open the console.
 *
 * Putting it here therefore gave *every* role, Viewer included, a way into the
 * admin panel. The matrix probe caught it before it shipped. It is granted
 * explicitly to Owner and Administrator instead, which is the only place it
 * currently means anything.
 */
const CRM_READ = Object.freeze([
  P.DASHBOARD_VIEW,
  P.LEADS_VIEW,
  P.CONTACTS_VIEW,
  P.COMPANIES_VIEW,
  P.CAMPAIGNS_VIEW,
  P.TEMPLATES_VIEW,
  P.MAILHISTORY_VIEW,
  P.NOTIFICATIONS_VIEW,
])

/**
 * The matrix.
 *
 * Composed from `CRM_READ` upward rather than each bundle listing forty strings,
 * so a new read permission reaches every role that should have it without seven
 * separate edits — and so the *differences* between roles are what the file
 * actually shows.
 */
const MATRIX = Object.freeze({
  /**
   * Everything, by construction rather than by enumeration.
   *
   * Derived from the registry, so a permission added later is held by the Owner
   * automatically. A hand-listed Owner bundle silently stops being "everything"
   * the first time somebody forgets to add to it — and the failure is invisible,
   * because it looks like a deliberate restriction.
   */
  [ROLES.OWNER]: PERMISSION_VALUES,

  /** Everything except the two that redefine the rules. */
  [ROLES.ADMIN]: PERMISSION_VALUES.filter(
    (permission) => !OWNER_ONLY_PERMISSIONS.includes(permission),
  ),

  /**
   * Full reach across CRM data and outreach, plus reporting.
   *
   * No user administration, no role administration, no organization settings,
   * no system-health control. Mailboxes are visible but not assignable.
   */
  [ROLES.MANAGER]: [
    ...CRM_READ,
    P.LEADS_CREATE,
    P.LEADS_EDIT,
    P.LEADS_DELETE,
    P.LEADS_EXPORT,
    P.CAMPAIGNS_CREATE,
    P.CAMPAIGNS_EDIT,
    P.CAMPAIGNS_DELETE,
    P.TEMPLATES_MANAGE,
    P.COMPOSE_SEND,
    P.REPLYSYNC_VIEW,
    P.WORKBOOK_IMPORT,
    P.WORKBOOK_HISTORY,
    P.SCHEDULER_VIEW,
    P.ANALYTICS_VIEW,
    P.MAILBOXES_VIEW,
  ],

  /**
   * Works enquiries and sends mail. Creates and edits; deletes nothing.
   *
   * The deletion boundary is the point of the role: a consultant who mis-clicks
   * should lose a moment, not a customer record. Exports are withheld for the
   * same reason at larger scale.
   */
  [ROLES.SALES]: [
    ...CRM_READ,
    P.LEADS_CREATE,
    P.LEADS_EDIT,
    P.CAMPAIGNS_CREATE,
    P.CAMPAIGNS_EDIT,
    P.COMPOSE_SEND,
    P.REPLYSYNC_VIEW,
    P.WORKBOOK_HISTORY,
  ],

  /**
   * The reply desk.
   *
   * Answers customers — which needs `COMPOSE_SEND` — and reads the register for
   * the context to answer them with. Changes no sales data: no lead create, no
   * lead edit, no campaigns.
   */
  [ROLES.SUPPORT]: [...CRM_READ, P.REPLYSYNC_VIEW, P.COMPOSE_SEND],

  /**
   * Read-only.
   *
   * Deliberately **no** `ANALYTICS_VIEW`. The Phase 14.0 design granted it, and
   * this phase withholds it: admin analytics aggregate every user's commercial
   * performance across the whole business, which is a different thing from
   * reading the CRM. A Viewer who needs it can be a Manager.
   */
  [ROLES.VIEWER]: CRM_READ,

  /** Legacy. Resolves to the Sales bundle — see `roles.js`. */
  [ROLES.MEMBER]: null,
})

/** Shared empty set, so the unknown-role path allocates nothing. */
const EMPTY = Object.freeze(new Set())

/** Presentation order: most privileged first. `member` is excluded as legacy. */
const ROLE_MATRIX_ROLES = Object.freeze([
  ROLES.OWNER,
  ROLES.ADMIN,
  ROLES.MANAGER,
  ROLES.SALES,
  ROLES.SUPPORT,
  ROLES.VIEWER,
])

/**
 * Role → permission Set, built once at module load.
 *
 * A `Set` rather than the arrays above because resolution runs on every
 * authenticated request: membership must be a hash lookup, not a scan, and the
 * bundle must not be rebuilt per call.
 *
 * Assembled and *then* frozen. Freezing before the legacy alias is assigned
 * would make that assignment a silent no-op in a script and a `TypeError` in a
 * module — and modules are always strict, so it would have thrown on import.
 */
const RESOLVED = (() => {
  const resolved = Object.fromEntries(
    Object.entries(MATRIX)
      .filter(([, permissions]) => permissions !== null)
      .map(([role, permissions]) => [role, Object.freeze(new Set(permissions))]),
  )

  // The alias, assigned once the bundle it points at exists. Shares the same
  // frozen Set rather than copying it — they are the same capability.
  resolved[ROLES.MEMBER] = resolved[ROLES.SALES]

  return Object.freeze(resolved)
})()

/**
 * Roles an administrator may redefine, and the reasons the rest may not.
 *
 * `OWNER` is excluded and must stay excluded. Every account in this deployment
 * holds it, and it is the only role carrying `OWNER_ONLY_PERMISSIONS` — so a
 * mis-click that stripped it would not degrade one person's access, it would
 * remove the deployment's ability to administer itself, with no path back
 * through the interface that just removed it. The owner is the recovery route
 * for every other role's mistakes and therefore cannot be one of them.
 *
 * `MEMBER` is excluded because it is a legacy alias that shares Sales' `Set` by
 * identity. Editing it would silently edit Sales.
 */
export const EDITABLE_ROLES = Object.freeze([
  ROLES.ADMIN,
  ROLES.MANAGER,
  ROLES.SALES,
  ROLES.SUPPORT,
  ROLES.VIEWER,
])

/**
 * Stored departures from `MATRIX`, layered over it at lookup time.
 *
 * ## Why an overlay and not a rewrite of the lookup
 *
 * `permissionsForRole` is called on **every authenticated request**, from
 * synchronous middleware, and by `roleHasPermission`, `roleHasAdminAccess` and
 * `isOrganizationAdministrator` beneath it. Making it read the database would
 * mean making it async, which would mean touching every authorization call site
 * in the product — an enormous change to the one part of the system where a
 * mistake is a security incident rather than a bug.
 *
 * An overlay keeps the signature, the synchronous contract and every caller
 * exactly as they were. The database is read when the process starts and when a
 * role is edited; lookups stay a hash hit on a frozen `Set`.
 *
 * Frozen `Set`s, replaced wholesale rather than mutated: a request that reads
 * this mid-update sees either the old definition or the new one, never a
 * half-applied set of permissions.
 */
let OVERRIDES = Object.freeze({})

/**
 * Replaces the overlay. Called by the role service — nothing else should.
 *
 * A role absent from `next` reverts to its built-in default, which is what makes
 * "reset this role" require deleting a row rather than storing an inverse.
 *
 * @param {Record<string, string[]>} next
 */
export function setRoleOverrides(next) {
  OVERRIDES = Object.freeze(
    Object.fromEntries(
      Object.entries(next ?? {})
        // A role nobody may edit cannot be overridden even if a row for it
        // exists — a hand-written document must not reach further than the
        // endpoint that is supposed to be the only way in.
        .filter(([role]) => EDITABLE_ROLES.includes(role))
        .map(([role, permissions]) => [role, Object.freeze(new Set(permissions))]),
    ),
  )
}

/** The built-in bundle for a role, ignoring any override. */
export function defaultPermissionListForRole(role) {
  return [...(RESOLVED[role] ?? EMPTY)].sort()
}

/** Whether a role currently differs from its built-in default. */
export function roleIsCustomised(role) {
  return Object.hasOwn(OVERRIDES, role)
}

/**
 * The permissions a role holds.
 *
 * A stored override wins over the built-in bundle. An unrecognised role resolves
 * to **an empty set, never to a default bundle**. That is the safe direction to
 * fail: a typo, or a role written by a future version of the software, grants
 * nothing and the request is refused — rather than silently inheriting somebody
 * else's access.
 *
 * @param {?string} role
 * @returns {Set<string>}
 */
export function permissionsForRole(role) {
  return OVERRIDES[role] ?? RESOLVED[role] ?? EMPTY
}

/**
 * Whether a role holds a permission.
 *
 * @param {?string} role
 * @param {string} permission
 * @returns {boolean}
 */
export function roleHasPermission(role, permission) {
  return permissionsForRole(role).has(permission)
}

/**
 * Whether a role is an **organization administrator** (Phase 14.8B).
 *
 * Deliberately narrower than `roleHasAdminAccess`, and the two must not be
 * confused:
 *
 *  - `roleHasAdminAccess` asks *"does any admin surface exist for you"*. A
 *    manager holds `analytics.view`, so it answers true for them — correctly,
 *    because the console does show them cross-user reporting.
 *  - This asks *"are you an administrator of this organization"*, which is what
 *    the Microsoft admin door is for. A manager is not.
 *
 * Derived from `USERS_VIEW` rather than compared against a list of role names.
 * "May see the people directory" is the closest capability in the matrix to
 * "administers the organization", and deriving it means promoting a role in the
 * matrix carries its portal access with it — there is no second list to
 * remember to update.
 *
 * This is the bootstrap check the Phase 14.8B brief permits, and it is the only
 * one in the product. Every individual admin endpoint still names its own
 * permission; this decides whether the *door* opens, not what is behind it.
 */
export function isOrganizationAdministrator(role) {
  return permissionsForRole(role).has(P.USERS_VIEW)
}

/**
 * Whether a role can reach the admin console at all.
 *
 * @param {?string} role
 * @returns {boolean}
 */
export function roleHasAdminAccess(role) {
  const held = permissionsForRole(role)
  return ADMIN_SURFACE_PERMISSIONS.some((permission) => held.has(permission))
}

/** A role's permissions as a sorted array, for API responses and the console. */
export function permissionListForRole(role) {
  return [...permissionsForRole(role)].sort()
}

/**
 * The whole matrix, as data.
 *
 * Serves the Roles screen so it renders what is actually enforced rather than a
 * second description of it that can drift.
 */
export function buildRoleMatrix() {
  return ROLE_MATRIX_ROLES.map((role) => ({
    role,
    permissions: permissionListForRole(role),
    adminAccess: roleHasAdminAccess(role),
    /*
     * Whether the console may offer this role's checkboxes, decided here rather
     * than in the console. The screen that renders the matrix and the endpoint
     * that enforces it then cannot disagree about which roles are protected —
     * and a client that ignores the flag still meets the same rule server-side.
     */
    editable: EDITABLE_ROLES.includes(role),
    customised: roleIsCustomised(role),
    defaultPermissions: defaultPermissionListForRole(role),
  }))
}

export default permissionsForRole
