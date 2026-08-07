/**
 * Who may give whom which role.
 *
 * ## This is not a permission, and it is not a duplicate of one
 *
 * `roles.manage` answers "may this person reach the role endpoint at all", and
 * the permission engine decides it. Everything here answers the question that
 * comes *after* that: given that they may manage roles, is **this** actor
 * allowed to give **this** target **that** role.
 *
 * The two are genuinely different. A permission is a capability held by a role;
 * these are rules about the relationship between three parties, and no
 * permission bitmap can express "an admin may not modify another admin". Trying
 * to encode them as permissions would mean a permission per (actor, target)
 * pair, which is not a permission system.
 *
 * Everything below is a pure function of its arguments. That is deliberate:
 * these are the rules that stop somebody escalating their own privileges, and
 * rules like that should be exhaustively testable without a database.
 *
 * ## The rules, in the order they are applied
 *
 *  0. **Capability.** The actor must hold `roles.manage`. Redundant with the
 *     route guard today, and here anyway: these functions are pure and callable
 *     from anywhere, so a future script must not get "a manager may edit a
 *     viewer" — true of the ranking, false of the product.
 *  1. **Self.** Nobody changes their own role — not up, not down. An owner who
 *     could demote themselves could lock the deployment out of its own
 *     administration by accident, and an admin who could promote themselves
 *     would make every other rule here decorative.
 *  2. **Grant ceiling.** An actor may only grant roles they are themselves
 *     senior to, plus their own rank if they are the owner. An admin cannot
 *     mint an owner or another admin.
 *  3. **Target ceiling.** An actor may only modify people junior to them. An
 *     admin cannot touch another admin or an owner — not to promote, not to
 *     demote, not at all.
 *  4. **Last owner.** The final active owner cannot be demoted by anybody,
 *     including another owner, because the result is a deployment nobody can
 *     administer.
 *
 * Rule 1 is checked before rules 2 and 3 so that "you cannot change your own
 * role" is the message a confused owner gets, rather than a rank explanation
 * that does not describe what they did wrong. Rule 0 precedes even that: for
 * somebody with no authority over anybody, "your role cannot manage roles" is
 * the true answer, and reporting `self` would imply they could edit others.
 */

import { PERMISSIONS } from './permissions.js'
import { permissionsForRole } from './roleMatrix.js'
import { ROLES, ROLE_LABELS, ROLE_RANK } from './roles.js'

/**
 * The roles the interface offers, most senior first.
 *
 * `member` is deliberately absent. It is the legacy role kept alive so existing
 * documents keep validating; offering it in a dropdown would let an
 * administrator newly assign a role that exists only for backward
 * compatibility.
 */
export const ROLE_OPTIONS = Object.freeze([
  ROLES.OWNER,
  ROLES.ADMIN,
  ROLES.MANAGER,
  ROLES.SALES,
  ROLES.SUPPORT,
  ROLES.VIEWER,
])

/** Why a change was refused. Stable keys so the client can react to them. */
export const ROLE_CHANGE_REFUSAL = Object.freeze({
  NOT_PERMITTED: 'not_permitted',
  SELF: 'self',
  NOT_ASSIGNABLE: 'not_assignable',
  TARGET_SENIOR: 'target_senior',
  LAST_OWNER: 'last_owner',
  UNCHANGED: 'unchanged',
  UNKNOWN_ROLE: 'unknown_role',
})

/**
 * Rank, with an unknown role treated as the most junior possible.
 *
 * Fail-closed: an unrecognised role must never rank *above* a real one, or an
 * account with a corrupt role field would become unmodifiable by everybody.
 */
function rankOf(role) {
  return ROLE_RANK[role] ?? Number.MAX_SAFE_INTEGER
}

/**
 * The roles an actor may hand out.
 *
 * The owner may grant every role including owner — succession has to be
 * possible. Everybody else may grant only roles strictly junior to their own,
 * which is what prevents an admin creating a peer.
 *
 * @param {string} actorRole
 * @returns {string[]}
 */
export function assignableRolesFor(actorRole) {
  if (actorRole === ROLES.OWNER) return [...ROLE_OPTIONS]

  const actorRank = rankOf(actorRole)

  return ROLE_OPTIONS.filter((role) => rankOf(role) > actorRank)
}

/**
 * Whether an actor may modify a target's role at all, ignoring which role.
 *
 * Separate from `canAssignRole` because the interface needs it on its own: a
 * row the actor may never touch should render without the control, rather than
 * with a control that refuses every option in it.
 *
 * @param {{ role: string, id: string }} actor
 * @param {{ role: string, id: string }} target
 */
export function canModifyRoleOf(actor, target) {
  /**
   * The actor must hold the capability, checked here and not only at the route.
   *
   * The route guard already requires `roles.manage`, so in the running system
   * this is redundant — today. It is here because these functions are pure and
   * therefore callable from anywhere: a future bulk import, a migration script
   * or a second endpoint would otherwise get "a manager may edit a viewer" as
   * the answer, which is true of the ranking and false of the product.
   *
   * Read from the permission engine rather than compared against a hardcoded
   * list of roles, so changing who may manage roles remains a one-line change
   * in the matrix.
   */
  if (!permissionsForRole(actor.role).has(PERMISSIONS.ROLES_MANAGE)) return false

  if (String(actor.id) === String(target.id)) return false

  // An owner may modify anybody but themselves — including another owner, which
  // is what makes it possible to reduce a two-owner deployment to one.
  if (actor.role === ROLES.OWNER) return true

  // Strictly junior. Equal rank fails, which is the "an admin may never modify
  // another admin" rule falling out of the ordering rather than being a
  // special case somebody could forget to apply to a new role.
  return rankOf(target.role) > rankOf(actor.role)
}

/**
 * The full decision.
 *
 * Returns a result object rather than throwing, so the same function can serve
 * the endpoint (which turns a refusal into a 403) and the read that tells the
 * interface which options to render. A version that threw would force the read
 * path to catch exceptions to build a dropdown.
 *
 * @param {object}  params
 * @param {{ role: string, id: string }} params.actor
 * @param {{ role: string, id: string }} params.target
 * @param {string}  params.nextRole
 * @param {number}  params.activeOwnerCount How many active owners exist now.
 * @returns {{ allowed: boolean, reason: ?string, message: ?string }}
 */
export function canAssignRole({ actor, target, nextRole, activeOwnerCount }) {
  const allow = { allowed: true, reason: null, message: null }
  const deny = (reason, message) => ({ allowed: false, reason, message })

  if (!ROLE_OPTIONS.includes(nextRole)) {
    return deny(
      ROLE_CHANGE_REFUSAL.UNKNOWN_ROLE,
      `"${nextRole}" is not a role that can be assigned.`,
    )
  }

  // --- 0. Capability -------------------------------------------------------
  //
  // Before the self check, because "you cannot manage roles" is the more
  // accurate message for somebody who holds no such power over anybody.
  if (!permissionsForRole(actor.role).has(PERMISSIONS.ROLES_MANAGE)) {
    return deny(
      ROLE_CHANGE_REFUSAL.NOT_PERMITTED,
      'Your role cannot manage roles.',
    )
  }

  // --- 1. Self -------------------------------------------------------------
  if (String(actor.id) === String(target.id)) {
    return deny(
      ROLE_CHANGE_REFUSAL.SELF,
      'You cannot change your own role. Ask another owner to do it.',
    )
  }

  // --- 2. Target ceiling ---------------------------------------------------
  if (!canModifyRoleOf(actor, target)) {
    return deny(
      ROLE_CHANGE_REFUSAL.TARGET_SENIOR,
      `Your role cannot modify a ${ROLE_LABELS[target.role] ?? target.role}.`,
    )
  }

  // --- 3. Grant ceiling ----------------------------------------------------
  if (!assignableRolesFor(actor.role).includes(nextRole)) {
    return deny(
      ROLE_CHANGE_REFUSAL.NOT_ASSIGNABLE,
      `Your role cannot grant ${ROLE_LABELS[nextRole] ?? nextRole}.`,
    )
  }

  // --- 4. Last owner -------------------------------------------------------
  //
  // Checked last because it is the only rule that depends on the state of the
  // whole collection rather than on the three parties, and the caller has to
  // pay for a count to evaluate it.
  if (target.role === ROLES.OWNER && nextRole !== ROLES.OWNER && activeOwnerCount <= 1) {
    return deny(
      ROLE_CHANGE_REFUSAL.LAST_OWNER,
      'This is the last active owner. Promote somebody else to owner first.',
    )
  }

  if (target.role === nextRole) {
    return deny(ROLE_CHANGE_REFUSAL.UNCHANGED, `That account is already a ${ROLE_LABELS[nextRole]}.`)
  }

  return allow
}

/**
 * What the interface should render for one target.
 *
 * Computed on the server and sent with the user record, so the console never
 * decides for itself who may be promoted. The client using this to hide a
 * control is a convenience; `canAssignRole` running again inside the endpoint
 * is the actual control.
 */
export function roleControlFor({ actor, target, activeOwnerCount }) {
  const canModify = canModifyRoleOf(actor, target)

  return {
    canModify,
    isSelf: String(actor.id) === String(target.id),
    /** Roles this actor may set on this target, each with why not. */
    options: ROLE_OPTIONS.map((role) => {
      const decision = canAssignRole({ actor, target, nextRole: role, activeOwnerCount })

      return {
        value: role,
        label: ROLE_LABELS[role] ?? role,
        allowed: decision.allowed,
        /**
         * The role the target holds right now.
         *
         * Reported separately from `allowed`, which is false for it — selecting
         * it is a genuine no-op. Without this the dropdown could not tell "the
         * option you already have" apart from "an option you are forbidden",
         * and would render the current role as though it were prohibited.
         */
        isCurrent: role === target.role,
        reason: decision.reason,
        message: decision.message,
      }
    }),
  }
}

/** Why a delete or restore was refused. Stable keys the client can react to. */
export const LIFECYCLE_REFUSAL = Object.freeze({
  NOT_PERMITTED: 'not_permitted',
  SELF: 'self',
  TARGET_SENIOR: 'target_senior',
  LAST_OWNER: 'last_owner',
  BOOTSTRAP_OWNER: 'bootstrap_owner',
  ALREADY_DELETED: 'already_deleted',
  NOT_DELETED: 'not_deleted',
})

/**
 * Whether an actor may soft-delete a target (Phase 15.2).
 *
 * Reuses `canModifyRoleOf` for the seniority question rather than restating it.
 * "An admin may not touch a peer or a senior" is one rule, and two copies of it
 * would disagree the first time either changed — which is exactly the kind of
 * divergence that produces a privilege-escalation path nobody reviewed.
 *
 * The three additional rules are all about not locking the deployment out of
 * itself:
 *
 *  - **Self.** Deleting your own account revokes your own sessions mid-request.
 *    Recoverable only by another owner, and confusing enough that nobody should
 *    be able to do it by misclicking a row.
 *  - **Last active owner.** The obvious one. An organization with no owner
 *    cannot invite, cannot promote, and cannot be administered at all.
 *  - **The bootstrap owner.** The account that claimed the organization is
 *    protected while it is the *only* owner — the same condition as the rule
 *    above, but named separately because the message an operator needs is
 *    different: "promote somebody else first" versus "this is the founding
 *    account".
 *
 * @param {object}  params
 * @param {{ id: string, role: string, permissions: Set }} params.actor
 * @param {{ id: string, role: string, status: string, isBootstrapOwner?: boolean }} params.target
 * @param {number}  params.activeOwnerCount
 * @returns {{ allowed: boolean, reason: ?string, message: ?string }}
 */
export function canDeleteUser({ actor, target, activeOwnerCount }) {
  const deny = (reason, message) => ({ allowed: false, reason, message })

  if (!actor.permissions?.has(PERMISSIONS.USERS_DELETE)) {
    return deny(LIFECYCLE_REFUSAL.NOT_PERMITTED, 'Your role cannot delete users.')
  }

  if (String(actor.id) === String(target.id)) {
    return deny(
      LIFECYCLE_REFUSAL.SELF,
      'You cannot delete your own account. Ask another owner to do it.',
    )
  }

  if (target.status === 'disabled') {
    return deny(LIFECYCLE_REFUSAL.ALREADY_DELETED, 'That account has already been deleted.')
  }

  /**
   * Seniority, borrowed from the role rules.
   *
   * `canModifyRoleOf` also re-checks `roles.manage`, which the owner and the
   * admin both hold — the same two roles that hold `users.delete`. So this adds
   * the ranking rule without widening or narrowing who may act.
   */
  if (!canModifyRoleOf(actor, target)) {
    return deny(
      LIFECYCLE_REFUSAL.TARGET_SENIOR,
      `Your role cannot delete a ${ROLE_LABELS[target.role] ?? target.role}.`,
    )
  }

  if (target.role === ROLES.OWNER && activeOwnerCount <= 1) {
    return deny(
      target.isBootstrapOwner ? LIFECYCLE_REFUSAL.BOOTSTRAP_OWNER : LIFECYCLE_REFUSAL.LAST_OWNER,
      target.isBootstrapOwner
        ? 'This is the account that created the organization and the only owner. Promote another owner first.'
        : 'This is the last active owner. Promote somebody else to owner first.',
    )
  }

  return { allowed: true, reason: null, message: null }
}

/**
 * Whether an actor may restore a soft-deleted target.
 *
 * The same seniority rule, in reverse: somebody who could not have deleted this
 * person must not be able to bring them back either. Restoring an owner you
 * could not have removed would be a way to acquire a peer.
 */
export function canRestoreUser({ actor, target }) {
  const deny = (reason, message) => ({ allowed: false, reason, message })

  if (!actor.permissions?.has(PERMISSIONS.USERS_DELETE)) {
    return deny(LIFECYCLE_REFUSAL.NOT_PERMITTED, 'Your role cannot restore users.')
  }

  if (target.status !== 'disabled') {
    return deny(LIFECYCLE_REFUSAL.NOT_DELETED, 'That account has not been deleted.')
  }

  if (!canModifyRoleOf(actor, target)) {
    return deny(
      LIFECYCLE_REFUSAL.TARGET_SENIOR,
      `Your role cannot restore a ${ROLE_LABELS[target.role] ?? target.role}.`,
    )
  }

  return { allowed: true, reason: null, message: null }
}

export default {
  assignableRolesFor,
  canAssignRole,
  canDeleteUser,
  canModifyRoleOf,
  canRestoreUser,
  roleControlFor,
}
