/**
 * Data access for the enterprise directory.
 *
 * Queries only. Every write in this module goes through
 * `services/adminUser.service.js`, which owns the state machine and the
 * boolean-synchronisation invariant — a repository that could also flip a
 * status would be a second place for that invariant to be got wrong.
 *
 * ## Scope
 *
 * Deployment-wide, like the rest of the admin module. `User` carries no `owner`
 * and never has: it is the identity collection, not business data, so there is
 * nothing to scope it by until Phase 14.3B introduces the organization.
 */

import { Conversation } from '../../../models/conversation.model.js'
import { Lead } from '../../../models/lead.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { Session } from '../../../models/session.model.js'
import { User } from '../../../models/user.model.js'
import { Campaign } from '../../../models/campaign.model.js'
import { USER_STATUS } from '../../../constants/userStatus.js'

/**
 * Fields read from `User`.
 *
 * An explicit allowlist rather than the whole document, so a field added to the
 * schema later cannot start appearing in an admin response because nobody
 * thought to exclude it. Opting in is the safe direction to fail.
 */
export const USER_FIELDS = [
  'displayName',
  'email',
  'userPrincipalName',
  'avatarUrl',
  'jobTitle',
  'role',
  'provider',
  'status',
  'isActive',
  'isDeleted',
  'lastLoginAt',
  'createdAt',
  'invitedAt',
  'invitedBy',
  'inviteNotes',
  'statusChangedAt',
  'statusChangedBy',

  /**
   * Identity fields (Phase 14.8C).
   *
   * The projection is an allowlist, so a field added to the schema is invisible
   * to every read that goes through here until it is named. Omitting these made
   * `unlinkMicrosoftIdentity` read `microsoftEmail` as undefined and refuse a
   * genuinely linked account with "no Microsoft identity linked" — a projection
   * bug that looked exactly like a state bug.
   *
   * `googleId` and `microsoftId` are the identifiers themselves, needed because
   * unlinking must refuse to remove the last way into an account.
   */
  'googleId',
  'microsoftId',
  'microsoftEmail',
  'tenantId',
  'lastGoogleLoginAt',
  'lastMicrosoftLoginAt',
].join(' ')

/** Escapes a caller-supplied term before it reaches a regex. */
function safePattern(term) {
  return new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

/**
 * Translates directory filters into a Mongo filter.
 *
 * ## Why status filtering is not `{ status }`
 *
 * Records written before Phase 14.3A have no `status` field at all, so a plain
 * equality match would silently exclude every pre-existing account from the
 * "Active" filter — the exact users an administrator most expects to see. Each
 * status therefore matches its stored value *or* the boolean shape that meant
 * the same thing before the field existed.
 *
 * @param {object} query
 */
/**
 * One status, as a condition that also matches records written before the field.
 *
 * The legacy shapes mirror `deriveUserStatus()` exactly. `invited` has none: an
 * invitation cannot predate the field that defines it.
 */
function statusCondition(status) {
  const legacy = {
    [USER_STATUS.ACTIVE]: {
      status: { $exists: false },
      isActive: { $ne: false },
      isDeleted: { $ne: true },
    },
    [USER_STATUS.SUSPENDED]: {
      status: { $exists: false },
      isActive: false,
      isDeleted: { $ne: true },
    },
    [USER_STATUS.DISABLED]: { status: { $exists: false }, isDeleted: true },
    [USER_STATUS.INVITED]: null,
  }[status]

  return { $or: legacy ? [{ status }, legacy] : [{ status }] }
}

/** A closed date range. The closing day is included in full, not to its midnight. */
function dateRange(from, to) {
  const bounds = {}

  if (from) bounds.$gte = new Date(from)

  if (to) {
    const end = new Date(to)
    end.setUTCHours(23, 59, 59, 999)
    bounds.$lte = end
  }

  return Object.keys(bounds).length > 0 ? bounds : null
}

export function buildUserFilter(query = {}) {
  const { search, role, status, createdFrom, createdTo, lastLoginFrom, lastLoginTo } = query

  /**
   * Built as a flat list and combined once at the end.
   *
   * The alternative — mutating one filter object as each clause is considered —
   * needs later clauses to undo earlier ones (an explicit `disabled` filter has
   * to defeat the default exclusion of disabled accounts), and a filter that
   * deletes its own keys is a filter nobody can read.
   */
  const conditions = []

  if (status) {
    conditions.push(statusCondition(status))
  } else {
    // No status asked for: hide removed accounts. A directory is a list of
    // people who have access. `$ne` also matches documents with no `status`.
    conditions.push({ isDeleted: { $ne: true } }, { status: { $ne: USER_STATUS.DISABLED } })
  }

  if (role) conditions.push({ role })

  if (search) {
    const pattern = safePattern(search)
    conditions.push({
      $or: [
        { displayName: pattern },
        { email: pattern },
        { jobTitle: pattern },
        { role: pattern },
        { status: pattern },
      ],
    })
  }

  const created = dateRange(createdFrom, createdTo)
  if (created) conditions.push({ createdAt: created })

  const lastLogin = dateRange(lastLoginFrom, lastLoginTo)
  if (lastLogin) conditions.push({ lastLoginAt: lastLogin })

  return conditions.length > 0 ? { $and: conditions } : {}
}

/**
 * One page of the directory, plus its total.
 *
 * @param {{ filter: object, page: number, limit: number, sort: string }} params
 */
export async function findUserPage({ filter, page, limit, sort }) {
  const [items, total] = await Promise.all([
    User.find(filter)
      .select(USER_FIELDS)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ])

  return { items, total }
}

/** One account, or null. */
export function findUserById(id) {
  return User.findById(id).select(USER_FIELDS).lean()
}

/**
 * A **live** account for an address.
 *
 * Used by the invite flow to answer one question: would inviting this address
 * create a second account for somebody who already has one?
 *
 * Only a account that has not been deleted can. A soft-deleted user keeps their
 * document and all their history — that is the point of the soft delete — but
 * they no longer hold their address against a new invitation. Deleting somebody
 * and then hiring a replacement onto the same shared mailbox address is a
 * normal thing to do, and it was previously refused with "already has a CRM
 * account" and no way forward short of restoring the account you had just
 * removed.
 *
 * This deliberately reversed an earlier decision to look *past* the soft-delete
 * filter here. That reading answered "has this address ever been used", which
 * turns out not to be the question the invite flow is asking.
 *
 * Duplicate protection for live accounts is unchanged and unweakened: an active,
 * invited or suspended user still matches and still produces the 409.
 *
 * The address is lowercased because the schema stores it that way; matching on
 * the stored form keeps this an indexed equality rather than a regex scan.
 */
export function findUserByEmail(email) {
  return User.findOne({
    email: String(email).trim().toLowerCase(),
    // `$ne: true` rather than `false`, so documents written before the field
    // existed — which have no `isDeleted` at all — still count as live.
    isDeleted: { $ne: true },
  })
    .select(USER_FIELDS)
    .lean()
}

/**
 * Mailbox counts for a set of users, in one query.
 *
 * One grouped aggregation rather than a lookup per row: twenty-five users would
 * otherwise be twenty-five extra round trips, and it stays one at five hundred.
 */
export async function countMailboxesByUser(userIds) {
  if (userIds.length === 0) return new Map()

  const rows = await Mailbox.aggregate([
    { $match: { user: { $in: userIds } } },
    {
      $group: {
        _id: '$user',
        total: { $sum: 1 },
        connected: { $sum: { $cond: [{ $eq: ['$status', 'connected'] }, 1, 0] } },
      },
    },
  ])

  return new Map(rows.map((row) => [String(row._id), { total: row.total, connected: row.connected }]))
}

/**
 * Last recorded activity per user, derived from the session store.
 *
 * ## Why there is no `lastActivity` field on `User`
 *
 * `Session.lastUsedAt` is already written on every authenticated request by
 * `touchSession`, so the answer exists. Adding a column to `User` would be a
 * second copy of it, kept in step by a write on every request to a collection
 * that has no other reason to be written — and the brief for this phase is
 * explicit that authentication data must not be duplicated.
 *
 * The trade-off is honest and bounded: sessions expire and are swept by a TTL
 * index, so this reports activity within the session window and `null` beyond
 * it. `lastLoginAt` on `User` is the durable long-range answer, and the profile
 * shows both.
 */
export async function findLastActivityByUser(userIds) {
  if (userIds.length === 0) return new Map()

  const rows = await Session.aggregate([
    { $match: { user: { $in: userIds } } },
    { $group: { _id: '$user', lastUsedAt: { $max: '$lastUsedAt' }, sessions: { $sum: 1 } } },
  ])

  return new Map(
    rows.map((row) => [String(row._id), { lastActivityAt: row.lastUsedAt, activeSessions: row.sessions }]),
  )
}

/**
 * What one person owns across the CRM.
 *
 * Read for the profile drawer only. Counts, never records — the profile answers
 * "how much of the business does this account touch", which is a question about
 * volume, and returning the rows would make it a second leads screen.
 */
export async function summariseUserActivity(userId) {
  const [leads, campaigns, conversations, mailboxes, sessions, lastSession] = await Promise.all([
    Lead.countDocuments({ owner: userId, isDeleted: false }),
    Campaign.countDocuments({ owner: userId }),
    Conversation.countDocuments({ owner: userId, isDeleted: false }),
    Mailbox.countDocuments({ user: userId }),
    Session.countDocuments({ user: userId }),
    Session.findOne({ user: userId }).sort({ lastUsedAt: -1 }).select('lastUsedAt ipAddress userAgent').lean(),
  ])

  return {
    leads,
    campaigns,
    conversations,
    mailboxes,
    activeSessions: sessions,
    lastActivityAt: lastSession?.lastUsedAt ?? null,
    /**
     * Captured at sign-in for audit purposes and shown here for the same reason.
     * Never used to validate a session — mobile networks rotate addresses, and
     * enforcing them signs legitimate users out.
     */
    lastIp: lastSession?.ipAddress ?? null,
  }
}

/** Distinct roles actually present, so the filter offers only values that match. */
export async function distinctRoles() {
  const roles = await User.distinct('role', { isDeleted: { $ne: true } })
  return roles.filter(Boolean).sort()
}

/** Counts per status, for the directory's summary tiles. */
export async function countByStatus() {
  const rows = await User.aggregate([
    {
      $group: {
        // Mirrors `deriveUserStatus()` so a record written before the field
        // counts as what it actually is rather than as `unknown`.
        _id: {
          $ifNull: [
            '$status',
            { $cond: [{ $eq: ['$isDeleted', true] }, 'disabled', { $cond: [{ $eq: ['$isActive', false] }, 'suspended', 'active'] }] },
          ],
        },
        count: { $sum: 1 },
      },
    },
  ])

  return Object.fromEntries(rows.map((row) => [row._id, row.count]))
}

/** How many accounts still hold a role. Guards the last-owner rule. */
export function countActiveWithRole(role) {
  return User.countDocuments({
    role,
    isDeleted: { $ne: true },
    isActive: { $ne: false },
    status: { $ne: USER_STATUS.SUSPENDED },
  })
}

export default {
  buildUserFilter,
  countActiveWithRole,
  countByStatus,
  countMailboxesByUser,
  distinctRoles,
  findLastActivityByUser,
  findUserByEmail,
  findUserById,
  findUserPage,
  summariseUserActivity,
}
