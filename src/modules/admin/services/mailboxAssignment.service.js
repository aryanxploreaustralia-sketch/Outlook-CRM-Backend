/**
 * The mailbox assignment engine.
 *
 * **One service. Every assignment operation goes through it**, from either
 * direction — the mailbox screen assigning people, or the user screen assigning
 * mailboxes. Both call the same three functions, so there is one implementation
 * of "what does assigning mean" and one place where the rules live.
 *
 * ## What it does not do
 *
 * It does not connect mailboxes, refresh tokens, or touch OAuth. Connection is
 * `mailboxConnect.service`'s and is untouched. This decides *who may use* a
 * mailbox that is already connected — a different question with a different
 * answer, which is why it is a different service.
 *
 * ## The single-default rule
 *
 * A user is the default of at most one mailbox. That is enforced here, by
 * clearing the id from every other mailbox in the same operation before adding
 * it to the target.
 *
 * It is **not** enforced by a unique index, and that is a deliberate trade-off
 * worth stating rather than discovering: a multikey unique index on
 * `defaultUsers` would index every mailbox's empty array under the same key and
 * collide immediately. The existing `{ user, isDefault }` partial index works
 * because `isDefault` is a scalar; an array cannot be constrained the same way.
 *
 * The mitigation is that this service is the only writer, and the clear runs
 * before the set — so the failure mode of an interleaved race is *no* default
 * rather than two, and the next assignment fixes it. Two simultaneous
 * administrators changing one person's default is not a scenario this
 * deployment has.
 */

import { Mailbox } from '../../../models/mailbox.model.js'
import { User } from '../../../models/user.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import {
  MAILBOX_EVENT,
  assignabilityOf,
  canUseMailbox,
  isDefaultForUser,
} from '../../../constants/mailboxAccess.js'
import { USER_STATUS, deriveUserStatus } from '../../../constants/userStatus.js'
import { mailboxAssignmentDTO, mailboxDetailDTO } from '../dto/adminMailbox.dto.js'

const log = createContextLogger('mailbox-assignment')

/** Human wording for each refusal, so the message says what to do about it. */
const ASSIGNABILITY_MESSAGE = {
  not_found: 'That mailbox could not be found.',
  not_connected:
    'That mailbox is not connected, so it cannot be assigned. Reconnect it from Account first.',
  disconnected:
    'That mailbox has been disconnected, so it cannot be assigned. Reconnect it from Account first.',
}

/**
 * Loads a mailbox and asserts it exists.
 *
 * @param {string} mailboxId
 * @returns {Promise<object>} A hydrated document — callers save it.
 */
async function loadMailbox(mailboxId) {
  const mailbox = await Mailbox.findById(mailboxId)

  if (!mailbox) throw ApiError.notFound('That mailbox could not be found.')

  return mailbox
}

/**
 * Validates the people an assignment names.
 *
 * Every id must resolve to an account that is not deleted and not suspended.
 * Assigning a mailbox to a suspended account is not harmful — they cannot sign
 * in — but it is silently useless, and the administrator would have no way to
 * tell it had not taken effect.
 *
 * @param {string[]} userIds
 * @returns {Promise<object[]>} The resolved users, in no particular order.
 */
async function resolveAssignees(userIds) {
  const unique = [...new Set(userIds.map(String))]

  const users = await User.find({ _id: { $in: unique } })
    .select('displayName email role status isActive isDeleted')
    .lean()

  if (users.length !== unique.length) {
    const found = new Set(users.map((user) => String(user._id)))
    const missing = unique.filter((id) => !found.has(id))

    throw ApiError.badRequest(
      `${missing.length} of the selected users could not be found.`,
      { details: { reason: 'user_not_found', missing } },
    )
  }

  const blocked = users.filter((user) => {
    const status = deriveUserStatus(user)
    return status === USER_STATUS.SUSPENDED || status === USER_STATUS.DISABLED
  })

  if (blocked.length > 0) {
    throw ApiError.badRequest(
      `${blocked.map((user) => user.email).join(', ')} cannot be assigned a mailbox while suspended.`,
      {
        details: {
          reason: 'user_not_assignable',
          users: blocked.map((user) => String(user._id)),
        },
      },
    )
  }

  return users
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * Grants a set of users access to a mailbox.
 *
 * Idempotent: assigning somebody who already holds access is not an error, it
 * is a no-op reported as such. An administrator who clicks twice, or who
 * re-saves a multi-select containing existing members, should not see a failure
 * — the request describes a desired state and the state is already correct.
 *
 * The connector is skipped rather than refused, for the same reason: they
 * already have access through `Mailbox.user`, and adding them to
 * `assignedUsers` would make a later "remove" ambiguous about whether it
 * revokes the grant the mailbox actually runs on.
 *
 * @param {{ mailboxId: string, userIds: string[] }} input
 * @param {object} actor
 */
export async function assignUsersToMailbox({ mailboxId, userIds }, actor) {
  const mailbox = await loadMailbox(mailboxId)

  const assignability = assignabilityOf(mailbox)
  if (!assignability.ok) {
    throw ApiError.badRequest(ASSIGNABILITY_MESSAGE[assignability.reason], {
      details: { reason: assignability.reason, mailboxId },
    })
  }

  const users = await resolveAssignees(userIds)

  const existing = new Set((mailbox.assignedUsers ?? []).map(String))
  const connector = String(mailbox.user)

  const added = []
  const skipped = []

  for (const user of users) {
    const id = String(user._id)

    if (id === connector) {
      skipped.push({ id, reason: 'connector' })
      continue
    }

    if (existing.has(id)) {
      skipped.push({ id, reason: 'already_assigned' })
      continue
    }

    existing.add(id)
    added.push(id)
  }

  if (added.length > 0) {
    mailbox.assignedUsers = [...existing]
    await mailbox.save()

    log.info('Mailbox assigned', {
      mailboxId: String(mailbox._id),
      added,
      actor: String(actor._id),
    })
  }

  return {
    event: MAILBOX_EVENT.ASSIGNED,
    added,
    skipped,
    mailbox: mailboxAssignmentDTO(mailbox),
  }
}

/**
 * Revokes access.
 *
 * ## Two things it refuses to do
 *
 * **It will not remove the connector.** Their access comes from the OAuth grant
 * that makes the mailbox work at all; "unassigning" them would be an
 * incoherent request, and silently succeeding while nothing changed would be
 * worse than refusing.
 *
 * **It clears the default alongside the assignment.** Leaving somebody as the
 * default of a mailbox they can no longer reach would produce a user whose
 * unattended mail resolves to a mailbox every send then refuses — a failure
 * that appears hours later, in a scheduled run, with no obvious cause.
 *
 * @param {{ mailboxId: string, userIds: string[] }} input
 * @param {object} actor
 */
export async function unassignUsersFromMailbox({ mailboxId, userIds }, actor) {
  const mailbox = await loadMailbox(mailboxId)

  const target = new Set(userIds.map(String))
  const connector = String(mailbox.user)

  if (target.has(connector)) {
    throw ApiError.badRequest(
      'This mailbox was connected by that user, so their access cannot be removed. Disconnect the mailbox instead.',
      { details: { reason: 'cannot_remove_connector', userId: connector } },
    )
  }

  const before = (mailbox.assignedUsers ?? []).map(String)
  const removed = before.filter((id) => target.has(id))

  if (removed.length === 0) {
    return {
      event: MAILBOX_EVENT.UNASSIGNED,
      removed: [],
      mailbox: mailboxAssignmentDTO(mailbox),
    }
  }

  mailbox.assignedUsers = before.filter((id) => !target.has(id))

  // A default they can no longer reach is worse than no default.
  const clearedDefaults = (mailbox.defaultUsers ?? []).map(String).filter((id) => target.has(id))
  if (clearedDefaults.length > 0) {
    mailbox.defaultUsers = (mailbox.defaultUsers ?? [])
      .map(String)
      .filter((id) => !target.has(id))
  }

  await mailbox.save()

  log.info('Mailbox unassigned', {
    mailboxId: String(mailbox._id),
    removed,
    clearedDefaults,
    actor: String(actor._id),
  })

  return {
    event: MAILBOX_EVENT.UNASSIGNED,
    removed,
    clearedDefaults,
    mailbox: mailboxAssignmentDTO(mailbox),
  }
}

/**
 * Replaces a user's whole set of mailboxes.
 *
 * The user-side counterpart of the two functions above, and deliberately a
 * *set* operation rather than a diff the client computes: a modal that submits
 * "these are the mailboxes this person should have" cannot leave the two sides
 * inconsistent, where an add-list plus a remove-list can.
 *
 * Delegates to the same primitives, so there is still one implementation of what
 * assignment means.
 *
 * @param {{ userId: string, mailboxIds: string[] }} input
 * @param {object} actor
 */
export async function setUserMailboxes({ userId, mailboxIds }, actor) {
  const [user] = await resolveAssignees([userId])

  const desired = new Set(mailboxIds.map(String))

  // Everything the user currently reaches by assignment. Connector-held
  // mailboxes are excluded: they are not assignments and cannot be revoked here.
  const current = await Mailbox.find({ assignedUsers: user._id }).select('_id').lean()
  const currentIds = new Set(current.map((mailbox) => String(mailbox._id)))

  const toAdd = [...desired].filter((id) => !currentIds.has(id))
  const toRemove = [...currentIds].filter((id) => !desired.has(id))

  const added = []
  const removed = []

  for (const mailboxId of toAdd) {
    const result = await assignUsersToMailbox({ mailboxId, userIds: [String(user._id)] }, actor)
    if (result.added.length > 0) added.push(mailboxId)
  }

  for (const mailboxId of toRemove) {
    await unassignUsersFromMailbox({ mailboxId, userIds: [String(user._id)] }, actor)
    removed.push(mailboxId)
  }

  return {
    event: MAILBOX_EVENT.ASSIGNED,
    userId: String(user._id),
    added,
    removed,
    mailboxes: await listMailboxesForUser(user._id),
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Makes a mailbox a user's default.
 *
 * Order is load-bearing: the id is cleared from every other mailbox *before* it
 * is added to the target. Interrupted halfway that leaves the user with no
 * default, which resolution handles by falling back to a usable mailbox. The
 * other order would leave them with two, which resolution cannot handle — it
 * would pick one non-deterministically, and a customer would hear from a
 * different address than yesterday for no visible reason.
 *
 * @param {{ mailboxId: string, userId: string }} input
 * @param {object} actor
 */
export async function setDefaultMailboxForUser({ mailboxId, userId }, actor) {
  const mailbox = await loadMailbox(mailboxId)
  const [user] = await resolveAssignees([userId])

  if (!canUseMailbox(mailbox, user._id)) {
    throw ApiError.badRequest(
      'That mailbox is not assigned to this user, so it cannot be their default. Assign it first.',
      { details: { reason: 'not_assigned', mailboxId, userId } },
    )
  }

  const assignability = assignabilityOf(mailbox)
  if (!assignability.ok) {
    throw ApiError.badRequest(ASSIGNABILITY_MESSAGE[assignability.reason], {
      details: { reason: assignability.reason, mailboxId },
    })
  }

  if (isDefaultForUser(mailbox, user._id) && (mailbox.defaultUsers ?? []).length > 0) {
    return {
      event: MAILBOX_EVENT.DEFAULT_CHANGED,
      changed: false,
      mailbox: mailboxAssignmentDTO(mailbox),
    }
  }

  // Cleared first. See the note above on why this order and not the other.
  await Mailbox.updateMany(
    { _id: { $ne: mailbox._id }, defaultUsers: user._id },
    { $pull: { defaultUsers: user._id } },
  )

  await Mailbox.updateOne({ _id: mailbox._id }, { $addToSet: { defaultUsers: user._id } })

  const updated = await Mailbox.findById(mailbox._id)

  log.info('Default mailbox changed', {
    mailboxId: String(mailbox._id),
    userId: String(user._id),
    actor: String(actor._id),
  })

  return {
    event: MAILBOX_EVENT.DEFAULT_CHANGED,
    changed: true,
    mailbox: mailboxAssignmentDTO(updated),
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every mailbox a user may use, marked with which is their default.
 *
 * Uses the same access rule the send path does, so this screen cannot show a
 * person a mailbox they could not actually send from.
 *
 * @param {string} userId
 */
export async function listMailboxesForUser(userId) {
  const mailboxes = await Mailbox.find({
    $or: [{ user: userId }, { assignedUsers: userId }],
  })
    .sort({ connectedAt: -1 })
    .lean()

  return mailboxes.map((mailbox) => ({
    ...mailboxAssignmentDTO(mailbox),
    isDefaultForUser: isDefaultForUser(mailbox, userId),
    /** Distinguishes "they connected it" from "it was given to them". */
    accessVia: String(mailbox.user) === String(userId) ? 'connector' : 'assigned',
  }))
}

/**
 * One mailbox with the people who can use it.
 *
 * @param {string} mailboxId
 */
export async function getMailboxDetail(mailboxId) {
  const mailbox = await Mailbox.findById(mailboxId).lean()

  if (!mailbox) throw ApiError.notFound('That mailbox could not be found.')

  const ids = [mailbox.user, ...(mailbox.assignedUsers ?? [])]

  const users = await User.find({ _id: { $in: ids } })
    .select('displayName email role status isActive isDeleted avatarUrl')
    .lean()

  const byId = new Map(users.map((user) => [String(user._id), user]))

  return mailboxDetailDTO(mailbox, {
    connectedBy: byId.get(String(mailbox.user)) ?? null,
    assignees: (mailbox.assignedUsers ?? [])
      .map((id) => byId.get(String(id)))
      .filter(Boolean),
  })
}

export default {
  assignUsersToMailbox,
  getMailboxDetail,
  listMailboxesForUser,
  setDefaultMailboxForUser,
  setUserMailboxes,
  unassignUsersFromMailbox,
}
