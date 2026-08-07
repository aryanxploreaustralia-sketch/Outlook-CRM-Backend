/**
 * Soft delete and restore (Phase 15.2).
 *
 * Its own file rather than more weight in `adminUserAdmin.service.js`, which is
 * already the largest service in the module. The split is by *consequence*:
 * everything here removes or returns somebody's access to the whole product,
 * and that is worth being able to read on one screen.
 *
 * ## Nothing is ever removed from MongoDB
 *
 * Not the user document, not their leads, not their campaigns, not their audit
 * entries, not their notifications. Every one of those references a user by id,
 * and deleting the row would leave the references pointing at nothing — a lead
 * with no owner, an audit entry that cannot say who acted.
 *
 * So "delete" means exactly this: the person loses access. Their history stays
 * intact and keeps working, which is why analytics for last quarter still add up
 * after somebody leaves.
 *
 * ## What is actively revoked
 *
 * Two things, because leaving either would mean a deleted account that still
 * *does* something:
 *
 *  1. **Sessions.** Otherwise a signed-in tab keeps working until its cookie
 *     expires — the account is deleted and the person is still using the CRM.
 *  2. **Mailbox assignments.** Otherwise they remain in the assignee list of
 *     every mailbox they could send from, and an administrator reading that
 *     list sees a name that no longer has an account.
 *
 * Mailbox *ownership* is deliberately untouched: the connector's grant is what
 * a mailbox runs on, and revoking it would disconnect a mailbox the rest of the
 * organization is still sending from.
 */

import { Mailbox } from '../../../models/mailbox.model.js'
import { User } from '../../../models/user.model.js'
import { OrganizationBootstrap } from '../../../models/organizationBootstrap.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { destroyAllUserSessions } from '../../../services/session.service.js'
import { canDeleteUser, canRestoreUser } from '../../../constants/roleAssignment.js'
import { permissionsForRole } from '../../../constants/roleMatrix.js'
import { USER_STATUS, deriveUserStatus, statusFlags } from '../../../constants/userStatus.js'
import { userDirectoryDTO } from '../dto/adminUser.dto.js'
import * as repo from '../repositories/adminUser.repository.js'
import { countActiveOwners } from './adminUserAdmin.service.js'

const log = createContextLogger('admin-user-lifecycle')

/** Whether this account is the one that claimed the organization. */
async function isBootstrapOwner(userId) {
  const record = await OrganizationBootstrap.findOne({}).select('owner').lean()
  return Boolean(record && String(record.owner) === String(userId))
}

/**
 * Assembles the three parties a lifecycle decision needs.
 *
 * The actor's permissions are resolved from the matrix rather than passed in,
 * so this cannot be called with a hand-made permission set that grants more
 * than the caller's role does.
 */
async function context({ id, actor }) {
  const target = await repo.findUserById(id)

  if (!target) throw ApiError.notFound('That user could not be found.')

  const status = deriveUserStatus(target)

  return {
    target,
    status,
    decisionActor: {
      id: String(actor._id),
      role: actor.role,
      permissions: permissionsForRole(actor.role),
    },
    decisionTarget: {
      id: String(target._id),
      role: target.role,
      status,
      isBootstrapOwner: await isBootstrapOwner(target._id),
    },
  }
}

/** Turns a refusal into the right status code. */
function refuse(decision) {
  // 409 for "the account is already in that state" — the caller was entitled to
  // ask and it was simply a no-op. 403 would tell an owner they lack a
  // permission they hold.
  const isConflict =
    decision.reason === 'already_deleted' || decision.reason === 'not_deleted'

  throw isConflict
    ? ApiError.conflict(decision.message, { details: { reason: decision.reason } })
    : ApiError.forbidden(decision.message, { details: { reason: decision.reason } })
}

/**
 * Soft-deletes an account.
 *
 * @param {{ id: string, reason?: ?string, actor: object }} params
 */
export async function deleteUser({ id, reason = null, actor }) {
  const { target, decisionActor, decisionTarget } = await context({ id, actor })

  const decision = canDeleteUser({
    actor: decisionActor,
    target: decisionTarget,
    activeOwnerCount: await countActiveOwners(),
  })

  if (!decision.allowed) refuse(decision)

  const now = new Date()

  /**
   * Guarded on `isDeleted: false` rather than on the id alone.
   *
   * Two administrators deleting the same account in the same instant would both
   * pass the checks above; this makes the second write match nothing, so
   * `deletedBy` records who actually did it rather than whoever wrote last.
   */
  const updated = await User.findOneAndUpdate(
    { _id: target._id, isDeleted: { $ne: true } },
    {
      $set: {
        status: USER_STATUS.DISABLED,
        // `statusFlags` is the single definition of which booleans a status
        // implies. Writing `isActive: false, isDeleted: true` by hand here
        // would be a second copy able to drift from what sign-in checks.
        ...statusFlags(USER_STATUS.DISABLED),
        deletedAt: now,
        deletedBy: actor._id,
        statusChangedAt: now,
        statusChangedBy: actor._id,
      },
    },
    { returnDocument: 'after' },
  )

  if (!updated) {
    throw ApiError.conflict('That account changed while you were working. Reload and try again.', {
      details: { reason: 'concurrent_modification' },
    })
  }

  // --- Revoke access ------------------------------------------------------
  const revokedSessions = await destroyAllUserSessions(target._id)

  /**
   * Assignments only, never ownership.
   *
   * `$pull` from both lists in one pass. A mailbox this person *connected*
   * keeps running — the organization is still sending from it, and revoking the
   * grant would break that for everybody.
   */
  const unassigned = await Mailbox.updateMany(
    { $or: [{ assignedUsers: target._id }, { defaultUsers: target._id }] },
    { $pull: { assignedUsers: target._id, defaultUsers: target._id } },
  )

  log.warn('User soft-deleted', {
    userId: String(target._id),
    email: target.email,
    actor: String(actor._id),
    revokedSessions,
    mailboxesUnassigned: unassigned.modifiedCount ?? 0,
  })

  return {
    event: 'user.deleted',
    reason,
    revokedSessions,
    mailboxesUnassigned: unassigned.modifiedCount ?? 0,
    /** Stated so the confirmation can promise it truthfully. */
    preserved: ['audit', 'analytics', 'campaigns', 'leads', 'notifications'],
    user: userDirectoryDTO(updated, {}),
  }
}

/**
 * Restores a soft-deleted account.
 *
 * ## Sessions are not restored, and that is the point
 *
 * `destroyAllUserSessions` ran at deletion and nothing here undoes it. The
 * person signs in again, which re-establishes identity through the provider
 * rather than resurrecting a cookie minted before they were removed. A restored
 * session would be a credential issued to somebody the organization had, at the
 * time, decided to remove.
 */
export async function restoreUser({ id, actor }) {
  const { target, decisionActor, decisionTarget } = await context({ id, actor })

  const decision = canRestoreUser({ actor: decisionActor, target: decisionTarget })

  if (!decision.allowed) refuse(decision)

  const now = new Date()

  const updated = await User.findOneAndUpdate(
    { _id: target._id, isDeleted: true },
    {
      $set: {
        status: USER_STATUS.ACTIVE,
        ...statusFlags(USER_STATUS.ACTIVE),

        /**
         * `isDeleted` is cleared explicitly, and it has to be.
         *
         * `statusFlags(ACTIVE)` returns `{ isActive: true }` and nothing else —
         * it never had to clear `isDeleted`, because before this phase no
         * transition ever set it. Relying on it here would produce an account
         * marked active *and* deleted, which `canSignIn` reads as deleted: a
         * restore that reports success and restores nothing.
         */
        isDeleted: false,

        // Cleared too: leaving a timestamp behind would make the directory show
        // a live account with a deletion date. The audit log is where the
        // history of the deletion lives.
        deletedAt: null,
        deletedBy: null,
        statusChangedAt: now,
        statusChangedBy: actor._id,
      },
    },
    { returnDocument: 'after' },
  )

  if (!updated) {
    throw ApiError.conflict('That account changed while you were working. Reload and try again.', {
      details: { reason: 'concurrent_modification' },
    })
  }

  log.warn('User restored', {
    userId: String(target._id),
    email: target.email,
    actor: String(actor._id),
    note: 'sessions remain revoked; the user must sign in again',
  })

  return {
    event: 'user.restored',
    /** Surfaced so the console can tell them they must sign in again. */
    sessionsRestored: false,
    user: userDirectoryDTO(updated, {}),
  }
}

export default { deleteUser, restoreUser }
