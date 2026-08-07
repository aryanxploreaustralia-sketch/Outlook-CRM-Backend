/**
 * The mailbox directory, for administrators.
 *
 * Reads the registry and joins the people who can use each mailbox. It performs
 * no assignment of its own - `mailboxAssignment.service` owns every write, so
 * there is one implementation of what assignment means.
 *
 * ## What it does not do
 *
 * It does not probe. A live provider call per mailbox on every list render would
 * reach into the mailbox engine, which this phase must not touch, and would turn
 * one screen load into six network round trips. Health is derived in the DTO
 * from state the sync engine already recorded, and is labelled as inferred.
 *
 * It does not read `OutlookAccount`, `ProviderToken`, or populate
 * `sourceAccount`. Not reading the credential is a stronger guarantee than
 * filtering it out afterwards.
 */

import { Mailbox } from '../../../models/mailbox.model.js'
import { User } from '../../../models/user.model.js'
import { mailboxHealth, mailboxRowDTO } from '../dto/adminMailbox.dto.js'

/**
 * Fields read from `Mailbox`.
 *
 * An allowlist, and note what is absent: `sourceAccount`. The link to the OAuth
 * grant is not selected at all, so no code path downstream can dereference it by
 * accident.
 */
const MAILBOX_FIELDS =
  'user assignedUsers defaultUsers provider providerAccountId emailAddress displayName status statusReason isDefault syncEnabled connectedAt disconnectedAt lastValidatedAt stats'

/** Escapes a caller-supplied term before it reaches a regex. */
function safePattern(term) {
  return new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

/**
 * Lists every mailbox in the deployment with its assignment state.
 *
 * @param {{ search?: string, status?: string, provider?: string,
 *           health?: string, assignedTo?: string }} [query]
 */
export async function listAdminMailboxes(query = {}) {
  const { search, status, provider, health, assignedTo } = query

  const conditions = []

  if (status) conditions.push({ status })
  if (provider) conditions.push({ provider })

  /**
   * "Assigned user" filter, matching the same access rule the send path uses.
   *
   * Includes the connector, or filtering by the person who connected a mailbox
   * would exclude the one mailbox they most certainly can use.
   */
  if (assignedTo) {
    conditions.push({ $or: [{ user: assignedTo }, { assignedUsers: assignedTo }] })
  }

  if (search) {
    const pattern = safePattern(search)
    conditions.push({ $or: [{ emailAddress: pattern }, { displayName: pattern }] })
  }

  const filter = conditions.length > 0 ? { $and: conditions } : {}

  const mailboxes = await Mailbox.find(filter)
    .select(MAILBOX_FIELDS)
    // Default first, then most recently connected: the default is the mailbox
    // unattended sends go through, so it is the row an operator looks for.
    .sort({ isDefault: -1, connectedAt: -1 })
    .lean()

  /**
   * Health is derived per mailbox and therefore filtered in memory.
   *
   * It is not a stored field, so it cannot be a query condition without either
   * denormalising it - a second copy of something computed - or an aggregation
   * that reimplements the DTO's logic in Mongo. Over a mailbox registry this
   * small, filtering after the read is the honest trade.
   */
  const relevant = health
    ? mailboxes.filter((mailbox) => mailboxHealth(mailbox).state === health)
    : mailboxes

  // One query for every connector rather than a `populate` issuing one per row.
  const connectorIds = [...new Set(relevant.map((mailbox) => String(mailbox.user)))]
  const connectors = await User.find({ _id: { $in: connectorIds } })
    .select('displayName email role status isActive isDeleted avatarUrl')
    .lean()

  const byId = new Map(connectors.map((user) => [String(user._id), user]))

  const items = relevant.map((mailbox) =>
    mailboxRowDTO(mailbox, { connectedBy: byId.get(String(mailbox.user)) ?? null }),
  )

  return {
    items,
    summary: {
      total: items.length,
      connected: items.filter((item) => item.status === 'connected').length,
      disconnected: items.filter((item) => item.status === 'disconnected').length,
      needsAttention: items.filter(
        (item) =>
          item.health.state === 'reconnect_required' || item.health.state === 'token_expiring',
      ).length,
      unassigned: items.filter((item) => item.assignedUserCount === 0).length,
      syncEnabled: items.filter((item) => item.syncEnabled).length,
    },
    /** Distinct providers present, so the filter offers only values that match. */
    providers: [...new Set(mailboxes.map((mailbox) => mailbox.provider).filter(Boolean))].sort(),
  }
}

export default { listAdminMailboxes }
