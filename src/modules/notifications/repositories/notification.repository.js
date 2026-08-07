/**
 * Notification reads and writes for one person.
 *
 * ## Every query is owner-scoped, and that is the whole access model
 *
 * A notification belongs to exactly one user. There is no "can this person read
 * that notification" check anywhere, because the question never arises: the
 * owner is part of every filter, so a caller cannot express a query that
 * reaches somebody else's row. Scoping by construction rather than by a guard
 * is what makes it impossible to forget.
 *
 * Fan-out to several people is several rows, decided by `notifier.service.js`
 * when the notification is raised — not by a read that widens its scope.
 */

import mongoose from 'mongoose'

import { Notification } from '../../../models/notification.model.js'

/** Dismissed rows are invisible to every read. Applied once, here. */
const visible = (owner) => ({ owner, isDeleted: { $ne: true } })

const toObjectId = (value) =>
  mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(String(value)) : null

/**
 * Turns validated query parameters into a filter.
 *
 * Clauses are omitted when absent rather than set to `undefined` — an
 * `undefined` in a Mongo filter matches documents where the field is missing,
 * which silently changes the result set instead of widening it.
 */
export function buildFilter(owner, query = {}) {
  const filter = visible(owner)

  if (query.category) filter.category = query.category
  if (query.type) filter.type = query.type
  if (query.unreadOnly) filter.isRead = false

  if (query.from || query.to) {
    filter.occurredAt = {}
    if (query.from) filter.occurredAt.$gte = query.from
    if (query.to) filter.occurredAt.$lte = query.to
  }

  // `$text` uses the index. Whole-word only, which is stated in the response
  // rather than papered over with a regex that scans the collection.
  if (query.search) filter.$text = { $search: query.search }

  return filter
}

const SORT = Object.freeze({ occurredAt: -1, _id: -1 })

/**
 * One page.
 *
 * Offset paging rather than a cursor, unlike the audit log. The difference is
 * the collection: notifications are per-person and dismissible, so the set a
 * reader pages through is small and shrinking. The audit log only grows, which
 * is what made keyset paging worth its complexity there.
 */
export async function listNotifications(owner, query, { page = 1, limit = 20 } = {}) {
  const filter = buildFilter(owner, query)

  const [items, total] = await Promise.all([
    Notification.find(filter)
      .sort(SORT)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Notification.countDocuments(filter),
  ])

  return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) }
}

/** The badge. One indexed count, polled — so it stays cheap. */
export function unreadCount(owner) {
  return Notification.countDocuments({ ...visible(owner), isRead: false })
}

/** Counts per category for the filter chips, over the visible set. */
export async function categoryCounts(owner) {
  const rows = await Notification.aggregate([
    { $match: visible(owner) },
    {
      $group: {
        _id: '$category',
        total: { $sum: 1 },
        unread: { $sum: { $cond: [{ $eq: ['$isRead', false] }, 1, 0] } },
      },
    },
  ])

  return rows
}

/**
 * Marks one as read.
 *
 * Owner-scoped in the filter, so a caller passing somebody else's id modifies
 * nothing and gets null — a 404, which is the right answer to "that is not
 * yours" here: the resource genuinely does not exist within their scope.
 */
export function markRead(owner, id) {
  const objectId = toObjectId(id)
  if (!objectId) return null

  return Notification.findOneAndUpdate(
    { _id: objectId, ...visible(owner), isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
    { returnDocument: 'after' },
  )
}

/** Marks everything visible and unread as read. */
export function markAllRead(owner) {
  return Notification.updateMany(
    { ...visible(owner), isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
  )
}

/**
 * Dismisses one.
 *
 * A soft delete. See the model: a hard delete frees the `(owner, dedupeKey)`
 * pair, and the next sync re-creates the same notification — which looks to the
 * reader like the delete button does not work.
 */
export function softDelete(owner, id) {
  const objectId = toObjectId(id)
  if (!objectId) return null

  return Notification.findOneAndUpdate(
    { _id: objectId, ...visible(owner) },
    { $set: { isDeleted: true, deletedAt: new Date(), isRead: true, readAt: new Date() } },
    { returnDocument: 'after' },
  )
}

/**
 * The handful of matches global search shows.
 *
 * Separate from `listNotifications` because search wants a short, unpaginated
 * slice across one owner and nothing else — no counts, no facets, no filters.
 */
export function searchNotifications(owner, term, limit) {
  return Notification.find({ ...visible(owner), $text: { $search: term } })
    .sort(SORT)
    .limit(limit)
    .lean()
}

export default {
  buildFilter,
  categoryCounts,
  listNotifications,
  markAllRead,
  markRead,
  searchNotifications,
  softDelete,
  unreadCount,
}
