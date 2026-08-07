/**
 * Who may use which mailbox.
 *
 * **The single definition of mailbox access in this CRM.** Every resolution path
 * — send, campaign sender, auto-mail, template test, reply sync, the account
 * screen — builds its filter from here. Nothing else decides.
 *
 * ## The model
 *
 *   User ──many──< Mailbox >──many── User
 *
 * A mailbox is reachable by a user when **either**:
 *
 *  1. they connected it (`Mailbox.user`), or
 *  2. it has been assigned to them (`Mailbox.assignedUsers`).
 *
 * ## Why the connector always keeps access
 *
 * This is what makes the phase backward compatible, and it is not merely
 * convenient — it is correct. The connector completed the OAuth consent; the
 * grant is theirs. Revoking their own access while their credential is what
 * makes the mailbox work would be incoherent.
 *
 * The practical consequence is the important one: before this phase every
 * mailbox resolved by `{ user: X }`. The new filter is `{ $or: [{ user: X },
 * { assignedUsers: X }] }` — a strict **superset**. No mailbox that resolved
 * yesterday stops resolving today, for anybody, with no migration and no
 * backfill. Assignment only ever widens.
 *
 * ## Defaults
 *
 * `defaultUsers` holds the users for whom this mailbox is *their* default. A
 * user appears in at most one mailbox's array — see `mailboxAssignment.service`
 * for how that is kept true and why it is not an index.
 *
 * The legacy `isDefault` boolean is untouched and still means "the connector's
 * default". Resolution prefers the new per-user answer and falls back to it, so
 * a workspace that has never used assignment behaves exactly as it always did.
 */

import { CONNECTION_STATUS } from '../modules/provider/constants/providerTypes.js'

/**
 * The filter for "mailboxes this user may use".
 *
 * Returned as a filter rather than a list because every caller composes it with
 * something else — a provider, a status, a specific id — and returning ids would
 * mean a second query plus an `$in` of unbounded length.
 *
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @returns {object} A Mongo filter fragment.
 */
export function mailboxAccessFilter(userId) {
  return { $or: [{ user: userId }, { assignedUsers: userId }] }
}

/**
 * Composes the access filter with additional conditions.
 *
 * `$or` cannot simply be spread alongside another `$or`, and a caller that
 * writes `{ ...accessFilter(id), status: 'connected' }` silently produces a
 * *different* query than intended the moment the extra conditions contain their
 * own `$or` — which the search filters do. `$and` composes without that trap.
 *
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {object} [extra]
 * @returns {object}
 */
export function scopedMailboxFilter(userId, extra = {}) {
  const conditions = Object.keys(extra).length > 0 ? [mailboxAccessFilter(userId), extra] : null

  return conditions ? { $and: conditions } : mailboxAccessFilter(userId)
}

/**
 * Whether a loaded mailbox document is reachable by a user.
 *
 * The in-memory counterpart of the filter, for the cases where the document is
 * already in hand and a second round trip would be wasteful. Kept beside the
 * filter so the two rules cannot drift.
 *
 * @param {object} mailbox
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @returns {boolean}
 */
export function canUseMailbox(mailbox, userId) {
  if (!mailbox || !userId) return false

  const id = String(userId)

  if (String(mailbox.user) === id) return true

  return (mailbox.assignedUsers ?? []).some((assigned) => String(assigned) === id)
}

/**
 * Whether this mailbox is the given user's default.
 *
 * @param {object} mailbox
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @returns {boolean}
 */
export function isDefaultForUser(mailbox, userId) {
  if (!mailbox || !userId) return false

  const id = String(userId)

  if ((mailbox.defaultUsers ?? []).some((assigned) => String(assigned) === id)) return true

  /**
   * Legacy fallback: the connector's own `isDefault` flag.
   *
   * A workspace that predates assignment has `isDefault` set and `defaultUsers`
   * empty. Without this, every such user would lose their recorded default the
   * moment this phase shipped — and unattended mail would start resolving by
   * "newest connected" instead of by their decision.
   */
  return mailbox.isDefault === true && String(mailbox.user) === id
}

/**
 * Whether a mailbox may be assigned to anybody.
 *
 * Assignment is a promise that the person can send from it. Handing somebody a
 * mailbox whose grant was revoked is handing them a send that will fail, and
 * they have no way to tell from the picker that it is broken — so the refusal
 * belongs at assignment time, where an administrator can act on it.
 *
 * @param {object} mailbox
 * @returns {{ ok: boolean, reason: ?string }}
 */
export function assignabilityOf(mailbox) {
  if (!mailbox) return { ok: false, reason: 'not_found' }

  if (mailbox.status !== CONNECTION_STATUS.CONNECTED) {
    return { ok: false, reason: 'not_connected' }
  }

  if (mailbox.disconnectedAt) return { ok: false, reason: 'disconnected' }

  return { ok: true, reason: null }
}

/**
 * Structured lifecycle events.
 *
 * **Audit is not implemented in this phase.** Every assignment operation returns
 * one of these, so Phase 14.7 subscribes at the controller with one
 * `AuditLog.record()` per verb and needs no change in the service.
 *
 * They are returned in responses rather than defined and left unused — a
 * constant nothing reads is one that drifts from the code it describes.
 */
export const MAILBOX_EVENT = Object.freeze({
  ASSIGNED: 'MAILBOX_ASSIGNED',
  UNASSIGNED: 'MAILBOX_UNASSIGNED',
  DEFAULT_CHANGED: 'DEFAULT_CHANGED',
})

export default mailboxAccessFilter
