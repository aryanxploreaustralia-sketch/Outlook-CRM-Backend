/**
 * The enterprise directory: reads, and the three lifecycle writes.
 *
 * This is the first module in the admin platform that writes. Everything it
 * writes is on `User`, and only the fields Phase 14.3A added plus the two
 * booleans authentication already reads.
 *
 * ## The invariant this file exists to hold
 *
 * Sign-in reads `isActive` and `isDeleted`. Nothing else. Those code paths are
 * frozen and were not touched.
 *
 * So every status change here writes the status **and** the flags
 * `statusFlags()` derives from it, in one update. Get that wrong in one place
 * and a suspended account keeps signing in — which is why there is exactly one
 * function that changes a status, and the two public verbs both call it.
 *
 * ## What it deliberately does not do
 *
 * No role editing, no mailbox assignment, no permission evaluation, no deletion.
 * Those are later phases and are absent rather than stubbed.
 */

import { Session } from '../../../models/session.model.js'
import { User } from '../../../models/user.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { destroyAllUserSessions } from '../../../services/session.service.js'
import { ROLES, ROLE_LABELS } from '../../../constants/roles.js'
import {
  canAssignRole,
  canDeleteUser,
  canModifyRoleOf,
  canRestoreUser,
  roleControlFor,
} from '../../../constants/roleAssignment.js'
import { permissionListForRole, permissionsForRole } from '../../../constants/roleMatrix.js'
import { PERMISSION_LABELS } from '../../../constants/permissions.js'
import { ROLE_DESCRIPTIONS } from '../../../constants/roles.js'
import { OrganizationBootstrap } from '../../../models/organizationBootstrap.model.js'
import {
  USER_STATUS,
  USER_STATUS_LABELS,
  USER_STATUS_TRANSITIONS,
  canTransition,
  deriveUserStatus,
  statusFlags,
} from '../../../constants/userStatus.js'
import * as repo from '../repositories/adminUser.repository.js'
import { userDirectoryDTO, userProfileDTO } from '../dto/adminUser.dto.js'

const log = createContextLogger('admin-users')

/**
 * The lifecycle events this module produces.
 *
 * **Audit is not implemented in this phase.** These constants are the extension
 * point for it: every mutation returns the event it performed, so when audit
 * recording arrives it subscribes at the controller with one `AuditLog.record()`
 * call per verb and needs no change in here.
 *
 * They are returned in the response rather than defined and left unused — a
 * constant nothing reads is a constant that drifts out of step with the code it
 * was supposed to describe.
 */
export const USER_EVENT = Object.freeze({
  INVITED: 'user.invited',
  ACTIVATED: 'user.activated',
  SUSPENDED: 'user.suspended',
  /** Phase 14.8A. */
  ROLE_CHANGED: 'role.changed',
})

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * One page of the directory.
 *
 * Mailbox counts and last-activity timestamps are resolved with one grouped
 * query each for the whole page, never per row.
 *
 * @param {object} query Already validated by `adminUser.validator.js`.
 */
export async function listUsers(query) {
  const filter = repo.buildUserFilter(query)

  const { items, total } = await repo.findUserPage({
    filter,
    page: query.page,
    limit: query.limit,
    sort: query.sort,
  })

  const ids = items.map((user) => user._id)

  const [mailboxes, activity, roles, statusCounts] = await Promise.all([
    repo.countMailboxesByUser(ids),
    repo.findLastActivityByUser(ids),
    repo.distinctRoles(),
    repo.countByStatus(),
  ])

  return {
    items: items.map((user) =>
      userDirectoryDTO(user, {
        mailboxes: mailboxes.get(String(user._id)),
        activity: activity.get(String(user._id)),
      }),
    ),
    roles,
    statusCounts,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    },
  }
}

/**
 * One account in full, for the profile drawer.
 *
 * @param {string} id
 * @param {?object} [viewer] `req.auth.user`, so the profile can mark itself as
 *   the caller's own. Optional: the profile is complete without it.
 */
export async function getUser(id, viewer = null) {
  const user = await repo.findUserById(id)

  if (!user) throw ApiError.notFound('That user could not be found.')

  const [activity, mailboxes, invitedBy, statusChangedBy] = await Promise.all([
    repo.summariseUserActivity(user._id),
    repo.countMailboxesByUser([user._id]),
    user.invitedBy ? repo.findUserById(user.invitedBy) : null,
    user.statusChangedBy ? repo.findUserById(user.statusChangedBy) : null,
  ])

  return userProfileDTO(user, {
    activity,
    mailboxes: mailboxes.get(String(user._id)),
    invitedBy,
    statusChangedBy,
    viewerId: viewer?._id ?? null,
  })
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Creates an invitation.
 *
 * ## Why an invitation is a `User` row rather than its own collection
 *
 * Because of what happens next. The Google identity flow already resolves a
 * sign-in by verified email when it finds no matching `googleId` — so an
 * invited row, which has an email and no `googleId`, *becomes* that person's
 * account the first time they sign in, and their `googleId`, name and avatar
 * are linked by code that already exists and was not touched.
 *
 * A separate `Invitation` collection would need a redemption step wired into
 * that flow, which is precisely the frozen path this phase must not modify.
 *
 * ## Why the account starts unable to sign in
 *
 * `statusFlags('invited')` sets `isActive: false`, so an invited person is
 * refused by `canSignIn()` until an administrator activates them. That is the
 * brief's flow — invited, then activated — enforced by the same check that
 * already refuses suspended accounts, with no new gate anywhere.
 *
 * @param {{ fullName: string, email: string, role: string, notes?: string }} input
 * @param {object} actor `req.auth.user`
 */
export async function inviteUser(input, actor) {
  const email = input.email.trim().toLowerCase()

  /**
   * The Microsoft address, when the invitation is for somebody who will sign in
   * that way (Phase 14.8C).
   *
   * Optional and independent of `email`. An owner invited as
   * `enquiry@xploreaustralia.com` may have a primary address of
   * `aryan@gmail.com`, and demanding they match is exactly the assumption this
   * phase removes.
   */
  const microsoftEmail = input.microsoftEmail?.trim().toLowerCase() || null

  /**
   * Rejected before writing, with a message that says which case it is.
   *
   * The partial unique index on invited emails settles the concurrent case; this
   * settles the ordinary one, and it can explain itself where a duplicate-key
   * error cannot.
   */
  const existing = await repo.findUserByEmail(email)

  if (existing) {
    const status = deriveUserStatus(existing)

    throw ApiError.conflict(
      status === USER_STATUS.INVITED
        ? `${email} has already been invited and is waiting to be activated.`
        : `${email} already has a CRM account (${USER_STATUS_LABELS[status] ?? status}).`,
      { details: { reason: 'user_exists', status, userId: String(existing._id) } },
    )
  }

  /**
   * A Microsoft address may claim only one account.
   *
   * The partial unique index settles the concurrent case; this settles the
   * ordinary one and can name the conflicting account, which a duplicate-key
   * error cannot.
   */
  if (microsoftEmail) {
    // Scoped to live accounts for the same reason `findUserByEmail` is: a
    // deleted user must not hold a Microsoft address against their
    // replacement's invitation. See the note on the residual index constraint
    // in that function's caller — the *stored* value is untouched either way.
    const claimed = await User.findOne({ microsoftEmail, isDeleted: { $ne: true } })
      .select('email')
      .lean()

    if (claimed) {
      throw ApiError.conflict(
        `${microsoftEmail} is already linked to ${claimed.email}.`,
        { details: { reason: 'microsoft_identity_taken', userId: String(claimed._id) } },
      )
    }
  }

  const now = new Date()

  let user
  try {
    user = await User.create({
      microsoftEmail,
      displayName: input.fullName.trim(),
      email,
      /**
       * Google, explicitly.
       *
       * The schema defaults `provider` to `microsoft`, which makes
       * `microsoftId` and `tenantId` required — neither of which an invitation
       * has. Declaring the provider is what lets the record validate, and it is
       * also true: this CRM's identity provider is Google.
       */
      provider: 'google',
      role: input.role,
      status: USER_STATUS.INVITED,
      ...statusFlags(USER_STATUS.INVITED),
      isDeleted: false,
      inviteNotes: input.notes?.trim() || null,
      invitedAt: now,
      invitedBy: actor._id,
      statusChangedAt: now,
      statusChangedBy: actor._id,
    })
  } catch (error) {
    // The index caught a race this function's own check could not.
    if (error?.code === 11_000) {
      // Either address could be the duplicate; the message names which.
      throw ApiError.conflict(
        error.message?.includes('microsoftEmail')
          ? `${microsoftEmail} is already linked to another account.`
          : `${email} has already been invited.`,
        { details: { reason: 'user_exists' } },
      )
    }
    throw error
  }

  log.info('User invited', {
    userId: String(user._id),
    email,
    role: input.role,
    invitedBy: String(actor._id),
  })

  return {
    event: USER_EVENT.INVITED,
    /**
     * How this person will sign in, so the console can say so.
     *
     * An owner invited with a Microsoft address signs in through the
     * organization door; everybody else signs in with Google. Stated in the
     * response rather than inferred in React, where it would be a second copy
     * of the rule.
     */
    signInWith: microsoftEmail ? 'microsoft' : 'google',
    isOwnerInvitation: input.role === ROLES.OWNER,
    microsoftEmail,
    user: userDirectoryDTO(user.toObject(), {}),
  }
}

/**
 * Moves an account to a new status.
 *
 * The single point at which a status changes, so the invariant that keeps
 * `isActive` honest is written once and cannot be forgotten by a caller.
 *
 * @param {object} params
 * @param {string} params.id      Target account.
 * @param {string} params.to      Desired status.
 * @param {object} params.actor   `req.auth.user`
 * @param {string} params.event   The `USER_EVENT` this represents.
 */
async function transition({ id, to, actor, event }) {
  const current = await repo.findUserById(id)

  if (!current) throw ApiError.notFound('That user could not be found.')

  const from = deriveUserStatus(current)

  if (from === to) {
    throw ApiError.conflict(
      `${current.email ?? 'That account'} is already ${USER_STATUS_LABELS[to].toLowerCase()}.`,
      { details: { reason: 'already_in_state', status: to } },
    )
  }

  if (!canTransition(from, to)) {
    const allowed = USER_STATUS_TRANSITIONS[from] ?? []

    throw ApiError.badRequest(
      allowed.length === 0
        ? `A ${USER_STATUS_LABELS[from].toLowerCase()} account cannot change status.`
        : `An account that is ${USER_STATUS_LABELS[from].toLowerCase()} can only become ${allowed
            .map((value) => USER_STATUS_LABELS[value].toLowerCase())
            .join(' or ')}.`,
      { details: { reason: 'invalid_transition', from, to, allowed } },
    )
  }

  // --- Guards ------------------------------------------------------------
  // Integrity rules, not permissions. Each protects against locking the
  // deployment out of its own administration, which no permission model would
  // catch because the actor is entitled to the action in general.
  if (to === USER_STATUS.SUSPENDED) {
    if (String(current._id) === String(actor._id)) {
      throw ApiError.badRequest('You cannot suspend your own account.', {
        details: { reason: 'self_suspend' },
      })
    }

    if (current.role === ROLES.OWNER) {
      const owners = await repo.countActiveWithRole(ROLES.OWNER)

      if (owners <= 1) {
        throw ApiError.badRequest(
          'This is the only active owner. Suspending it would leave the CRM with nobody who can administer it.',
          { details: { reason: 'last_owner' } },
        )
      }
    }
  }

  const now = new Date()

  const updated = await User.findByIdAndUpdate(
    id,
    {
      $set: {
        status: to,
        // Written together with the status, never separately. This pair is what
        // sign-in actually reads.
        ...statusFlags(to),
        statusChangedAt: now,
        statusChangedBy: actor._id,
      },
    },
    // `returnDocument` rather than the deprecated `new: true`.
    { returnDocument: 'after', runValidators: true },
  ).lean()

  /**
   * A suspended account loses its sessions immediately.
   *
   * `isActive: false` refuses the *next sign-in*, but `requireAuth` resolves an
   * existing session without re-checking `canSignIn()` — so without this a
   * suspended user keeps working until their cookie expires, which is not what
   * "cannot access the CRM" means to the person who clicked suspend.
   *
   * `destroyAllUserSessions` already exists and is what sign-out uses. Nothing
   * in the authentication flow was changed to make this work.
   */
  if (to === USER_STATUS.SUSPENDED) {
    const revoked = await destroyAllUserSessions(id)
    log.info('Suspended user sessions revoked', { userId: String(id), revoked })
  }

  log.info(`User ${to}`, {
    userId: String(id),
    from,
    to,
    actor: String(actor._id),
  })

  return { event, from, to, user: userDirectoryDTO(updated, {}) }
}

/**
 * Activates an invited or suspended account.
 *
 * No sign-in is required and none is simulated — this is a status transition and
 * nothing more, exactly as the brief specifies. The person's identity is linked
 * when they actually sign in, by the flow that already does it.
 */
export function activateUser(id, actor) {
  return transition({ id, to: USER_STATUS.ACTIVE, actor, event: USER_EVENT.ACTIVATED })
}

/**
 * Suspends an account.
 *
 * Also reachable from `invited`, which is how an invitation is withdrawn. It
 * needs no new concept and no new endpoint: an invitation that should not have
 * been sent becomes an account that cannot sign in, and the row survives so the
 * decision remains visible. Deletion is not offered at all.
 */
export function suspendUser(id, actor) {
  return transition({ id, to: USER_STATUS.SUSPENDED, actor, event: USER_EVENT.SUSPENDED })
}

/** Directory-wide counters, for the summary tiles. */
export async function userDirectorySummary() {
  const [statusCounts, sessions] = await Promise.all([
    repo.countByStatus(),
    Session.estimatedDocumentCount(),
  ])

  return { statusCounts, activeSessions: sessions }
}

export default {
  activateUser,
  getUser,
  inviteUser,
  listUsers,
  suspendUser,
  userDirectorySummary,
}

// ---------------------------------------------------------------------------
// Role management (Phase 14.8A)
// ---------------------------------------------------------------------------

/**
 * How many owners can currently sign in.
 *
 * "Active" means exactly what sign-in means by it — `isActive` and not deleted
 * — rather than a separate definition. A suspended owner cannot administer
 * anything, so counting them would let the last usable owner be demoted and
 * leave a deployment nobody can get into.
 */
export async function countActiveOwners() {
  return User.countDocuments({ role: ROLES.OWNER, isActive: true, isDeleted: { $ne: true } })
}

/**
 * What role controls the console should render for one target.
 *
 * Computed here so the interface never decides who may be promoted. It is a
 * convenience for rendering; `changeUserRole` evaluates the same rules again
 * and is the actual control.
 */
export async function getRoleControl({ targetId, actor }) {
  const target = await repo.findUserById(targetId)

  if (!target) throw ApiError.notFound('That user could not be found.')

  const control = roleControlFor({
    actor: { id: String(actor._id), role: actor.role },
    target: { id: String(target._id), role: target.role },
    activeOwnerCount: await countActiveOwners(),
  })

  const status = deriveUserStatus(target)

  return {
    ...control,

    /** The role they hold now, named and described. */
    current: {
      value: target.role,
      label: ROLE_LABELS[target.role] ?? target.role,
      description: ROLE_DESCRIPTIONS[target.role] ?? null,
    },

    /**
     * What the role actually grants, resolved from the engine that enforces it.
     *
     * Derived rather than stored: this is the same `permissionsForRole` the
     * middleware calls on every request, so the summary cannot claim a
     * capability the guards would refuse. Grouped the way the roles screen
     * groups them, so the two read alike.
     */
    effectivePermissions: permissionListForRole(target.role).map((permission) => ({
      value: permission,
      label: PERMISSION_LABELS[permission] ?? permission,
    })),

    /** Everything the lifecycle buttons need, decided on the server. */
    lifecycle: {
      status,
      isDeleted: status === USER_STATUS.DISABLED,
      deletedAt: target.deletedAt ?? null,
      canDelete: canDeleteUser({
        actor: { id: String(actor._id), role: actor.role, permissions: permissionsForRole(actor.role) },
        target: { id: String(target._id), role: target.role, status },
        activeOwnerCount: await countActiveOwners(),
      }),
      canRestore: canRestoreUser({
        actor: { id: String(actor._id), role: actor.role, permissions: permissionsForRole(actor.role) },
        target: { id: String(target._id), role: target.role, status },
      }),
    },
  }
}

/**
 * Changes a user's role.
 *
 * ## Permissions are not re-derived here
 *
 * Writing `role` is the whole operation. Every capability in the product is
 * resolved from the role at request time by `permissionsForRole()`, so there is
 * no permission set to update, no cache to invalidate and no second place where
 * authority is stored. That is why this function is short: the permission
 * engine already did the hard part.
 *
 * ## Sessions are deliberately **not** revoked
 *
 * A demotion takes effect on the target's very next request, because
 * `resolvePermissions` reads the role from the user document on each one — not
 * from anything stamped into the session at sign-in. Signing them out would
 * therefore buy no security and would interrupt work for no reason.
 *
 * A *suspension* does revoke sessions, and that difference is correct: a
 * suspended account must stop immediately, while a demoted one simply has less
 * authority from its next call onward.
 *
 * @param {object} params
 * @param {string} params.id      Target account.
 * @param {string} params.role    Desired role.
 * @param {?string} params.reason Optional free text, recorded on the audit entry.
 * @param {object} params.actor   `req.auth.user`
 */
export async function changeUserRole({ id, role: nextRole, reason = null, actor }) {
  const target = await repo.findUserById(id)

  if (!target) throw ApiError.notFound('That user could not be found.')

  const decision = canAssignRole({
    actor: { id: String(actor._id), role: actor.role },
    target: { id: String(target._id), role: target.role },
    nextRole,
    activeOwnerCount: await countActiveOwners(),
  })

  if (!decision.allowed) {
    /**
     * 409 for "already has that role", 403 for everything else.
     *
     * An unchanged role is not an authorisation failure — the actor was
     * entitled to make the request and it was simply a no-op — and reporting it
     * as 403 would tell an owner they lack a permission they hold.
     */
    const isConflict = decision.reason === 'unchanged'

    throw isConflict
      ? ApiError.conflict(decision.message, { details: { reason: decision.reason } })
      : ApiError.forbidden(decision.message, { details: { reason: decision.reason } })
  }

  const previousRole = target.role

  const updated = await User.findOneAndUpdate(
    // Guarded on the role we read. Two owners demoting the last owner in the
    // same instant would both pass the count above; this makes the second write
    // match nothing rather than apply against a record that has since changed.
    { _id: target._id, role: previousRole },
    { $set: { role: nextRole } },
    { returnDocument: 'after' },
  )

  if (!updated) {
    throw ApiError.conflict(
      'That account changed while you were editing it. Reload and try again.',
      { details: { reason: 'concurrent_modification' } },
    )
  }

  log.info('User role changed', {
    userId: String(target._id),
    from: previousRole,
    to: nextRole,
    actor: String(actor._id),
    actorRole: actor.role,
  })

  return {
    event: USER_EVENT.ROLE_CHANGED,
    from: previousRole,
    to: nextRole,
    fromLabel: ROLE_LABELS[previousRole] ?? previousRole,
    toLabel: ROLE_LABELS[nextRole] ?? nextRole,
    reason,
    user: userDirectoryDTO(updated, {}),
  }
}

// ---------------------------------------------------------------------------
// Identity linking (Phase 14.8C)
// ---------------------------------------------------------------------------

/**
 * Links a Microsoft address to an existing CRM account.
 *
 * ## What this actually grants
 *
 * The ability to sign in as that account through the organization door. On an
 * owner, that is the highest privilege in the deployment — which is why the
 * route requires `roles.manage` and the service refuses anybody who could not
 * also have granted the target's role. Linking Microsoft to an owner you could
 * not have created would otherwise be a way around the role rules.
 *
 * ## The addresses need not match, and that is the point
 *
 * `aryan@gmail.com` and `enquiry@xploreaustralia.com` become one account with
 * two identities because an owner said so. Nothing compares the two strings.
 *
 * ## What is not written
 *
 * `role` is untouched. Linking never promotes. `microsoftId` is also untouched
 * — it is stamped by Microsoft at the first successful sign-in, and writing a
 * guess here would mean the CRM claiming an identity it has not seen proven.
 *
 * @param {object}  params
 * @param {string}  params.id             Target account.
 * @param {string}  params.microsoftEmail Address to link.
 * @param {object}  params.actor          `req.auth.user`
 */
export async function linkMicrosoftIdentity({ id, microsoftEmail, actor }) {
  const address = String(microsoftEmail).trim().toLowerCase()
  const target = await repo.findUserById(id)

  if (!target) throw ApiError.notFound('That user could not be found.')

  /**
   * Reuses the role rules rather than inventing a second hierarchy.
   *
   * `canModifyRoleOf` already encodes "an admin may not touch a peer or a
   * senior, and nobody edits themselves". Asking it here means the linking
   * endpoint cannot drift from the role endpoint — a second set of rules is a
   * second set to keep in step, and the pair would disagree eventually.
   *
   * Self is the one deliberate difference: an owner linking *their own*
   * Microsoft address is the ordinary case, and refusing it would make the
   * feature unusable by the person most likely to need it. It grants no
   * authority they do not already hold.
   */
  const isSelf = String(actor._id) === String(target._id)

  if (!isSelf && !canModifyRoleOf(
    { id: String(actor._id), role: actor.role },
    { id: String(target._id), role: target.role },
  )) {
    throw ApiError.forbidden(
      `Your role cannot modify a ${ROLE_LABELS[target.role] ?? target.role}.`,
      { details: { reason: 'target_senior' } },
    )
  }

  const claimed = await User.findOne({ microsoftEmail: address, _id: { $ne: target._id } })
    .select('email')
    .lean()

  if (claimed) {
    throw ApiError.conflict(`${address} is already linked to ${claimed.email}.`, {
      details: { reason: 'microsoft_identity_taken', userId: String(claimed._id) },
    })
  }

  const previous = target.microsoftEmail ?? null

  const updated = await User.findOneAndUpdate(
    { _id: target._id },
    { $set: { microsoftEmail: address } },
    { returnDocument: 'after' },
  )

  log.info('Microsoft identity linked', {
    userId: String(target._id),
    microsoftEmail: address,
    previous,
    actor: String(actor._id),
  })

  return { event: 'identity.linked', previous, microsoftEmail: address, user: userDirectoryDTO(updated, {}) }
}

/**
 * Removes a linked Microsoft address.
 *
 * Clears `microsoftId` and `tenantId` as well as the address. Leaving the id
 * behind would let the person keep signing in at step 1 of the lookup — an
 * unlink that does not actually revoke access is worse than none, because it
 * reports success.
 *
 * Refuses to strip the last route into an account: an owner whose Google
 * identity was never established would be locked out permanently, and this
 * product has no password to fall back on.
 */
export async function unlinkMicrosoftIdentity({ id, actor }) {
  const target = await repo.findUserById(id)

  if (!target) throw ApiError.notFound('That user could not be found.')

  const isSelf = String(actor._id) === String(target._id)

  if (!isSelf && !canModifyRoleOf(
    { id: String(actor._id), role: actor.role },
    { id: String(target._id), role: target.role },
  )) {
    throw ApiError.forbidden(
      `Your role cannot modify a ${ROLE_LABELS[target.role] ?? target.role}.`,
      { details: { reason: 'target_senior' } },
    )
  }

  if (!target.microsoftEmail && !target.microsoftId) {
    throw ApiError.conflict('That account has no Microsoft identity linked.', {
      details: { reason: 'not_linked' },
    })
  }

  if (!target.googleId) {
    throw ApiError.conflict(
      'Microsoft is the only way into that account. Link a Google identity first, or this account can never sign in again.',
      { details: { reason: 'last_identity' } },
    )
  }

  const previous = target.microsoftEmail ?? null

  const updated = await User.findOneAndUpdate(
    { _id: target._id },
    { $set: { microsoftEmail: null, microsoftId: null, tenantId: null } },
    { returnDocument: 'after' },
  )

  log.info('Microsoft identity unlinked', {
    userId: String(target._id),
    previous,
    actor: String(actor._id),
  })

  return { event: 'identity.unlinked', previous, user: userDirectoryDTO(updated, {}) }
}

/**
 * Whether the organization has been claimed, and by whom.
 *
 * Read by the console so it can explain the state of installation rather than
 * leaving an operator guessing why Microsoft sign-in refuses them.
 */
export async function getBootstrapStatus() {
  const [record, activeOwners] = await Promise.all([
    OrganizationBootstrap.findOne({}).lean(),
    countActiveOwners(),
  ])

  return {
    completed: Boolean(record),
    completedAt: record?.completedAt ?? null,
    claimedBy: record?.ownerEmail ?? null,
    activeOwners,
    /**
     * True only when a Microsoft sign-in would currently be allowed to claim
     * the organization. Both conditions, matching the resolver exactly.
     */
    open: !record && activeOwners === 0,
  }
}
