/**
 * Audit reads.
 *
 * ## Cursor pagination, not offset
 *
 * An audit log is the one collection in this product that only grows, and it is
 * always read newest-first. `skip(n)` makes page 500 walk 12,500 documents to
 * throw them away, so the log gets slower every week it is used — and offsets
 * *shift* as new entries arrive, so an operator paging through an active log
 * sees the same entry twice and misses another.
 *
 * The cursor is `occurredAt` plus `_id`, because two entries can share a
 * millisecond and a cursor on time alone would drop whichever came second.
 * Both are in the sort index, so a page is a range scan regardless of depth.
 *
 * Offset paging is still offered alongside it — the console shows page numbers,
 * and a human clicking "page 4 of 9" wants page 4. It is capped: past the cap
 * the caller is told to narrow the filter rather than served a scan.
 */

import mongoose from 'mongoose'

import { AuditLog } from '../../../models/auditLog.model.js'

/** Beyond this, offset paging is refused and the caller is told why. */
export const MAX_OFFSET_PAGE = 200

const toObjectId = (value) =>
  mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(String(value)) : null

/**
 * Turns validated query parameters into a `$match`.
 *
 * Every clause is omitted when its parameter is absent — an `undefined` in a
 * Mongo filter matches documents where the field is missing, which would
 * silently change the result set rather than widen it.
 */
export function buildAuditFilter(query = {}) {
  const filter = {}

  if (query.from || query.to) {
    filter.occurredAt = {}
    if (query.from) filter.occurredAt.$gte = query.from
    if (query.to) filter.occurredAt.$lte = query.to
  }

  if (query.category) filter.category = query.category
  if (query.action) filter.action = query.action
  if (query.result) filter.result = query.result
  if (query.severity) filter.severity = query.severity
  if (query.entityType) filter.entityType = query.entityType
  if (query.entityId) filter.entityId = String(query.entityId)

  if (query.actor) {
    const id = toObjectId(query.actor)
    // An unparseable id matches nothing rather than being dropped: dropping it
    // would silently return the whole log for a filter the operator set.
    filter.actor = id ?? new mongoose.Types.ObjectId()
  }

  if (query.performedFor) filter.performedFor = toObjectId(query.performedFor) ?? new mongoose.Types.ObjectId()
  if (query.mailboxId) filter.mailboxId = toObjectId(query.mailboxId) ?? new mongoose.Types.ObjectId()
  if (query.campaignId) filter.campaignId = toObjectId(query.campaignId) ?? new mongoose.Types.ObjectId()
  if (query.leadId) filter.leadId = toObjectId(query.leadId) ?? new mongoose.Types.ObjectId()

  /**
   * Search.
   *
   * `$text` uses the index and is what makes search viable on a large log. It
   * matches whole words only, which is the trade: searching `camp` will not
   * find `campaign`. That is stated in the API response rather than papered
   * over with a regex fallback that turns every search into a collection scan.
   */
  if (query.search) filter.$text = { $search: query.search }

  return filter
}

/** The sort every read uses. Compound so a shared millisecond is still ordered. */
const SORT = Object.freeze({ occurredAt: -1, _id: -1 })

/**
 * One page, newest first.
 *
 * @param {object} query   Validated filters.
 * @param {object} options `{ limit, cursor, page }`.
 */
export async function listAuditEntries(query, { limit = 25, cursor = null, page = null } = {}) {
  const filter = buildAuditFilter(query)

  if (cursor) {
    // Strictly "older than the last row of the previous page". The `$or` is the
    // standard keyset form: earlier timestamp, or the same timestamp with a
    // smaller id.
    const [at, id] = String(cursor).split('_')
    const cursorAt = new Date(Number(at))
    const cursorId = toObjectId(id)

    if (!Number.isNaN(cursorAt.getTime()) && cursorId) {
      filter.$and = [
        ...(filter.$and ?? []),
        {
          $or: [
            { occurredAt: { $lt: cursorAt } },
            { occurredAt: cursorAt, _id: { $lt: cursorId } },
          ],
        },
      ]
    }
  }

  const skip = !cursor && page && page > 1 ? (page - 1) * limit : 0

  /**
   * One extra row is fetched to answer "is there a next page" without a second
   * count query. The extra is sliced off before returning.
   */
  const rows = await AuditLog.find(filter)
    .sort(SORT)
    .skip(skip)
    .limit(limit + 1)
    .lean()

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items.at(-1)

  return {
    items,
    hasMore,
    /** Feed back verbatim as `cursor` to get the next page. */
    nextCursor: hasMore && last ? `${new Date(last.occurredAt).getTime()}_${last._id}` : null,
  }
}

/**
 * How many entries match.
 *
 * Separate from the page read and issued in parallel by the service, because a
 * count over a large filtered set is the slow half and the rows can render
 * without it.
 */
export function countAuditEntries(query) {
  return AuditLog.countDocuments(buildAuditFilter(query))
}

/** One entry, for the detail view. */
export function findAuditEntry(id) {
  const objectId = toObjectId(id)
  if (!objectId) return null

  return AuditLog.findById(objectId).lean()
}

/**
 * Counts per category, action and result for the matched set.
 *
 * One `$facet` rather than three round trips: they share a `$match` over the
 * same filter, and running it three times is three index scans for one answer.
 */
export async function auditFacets(query) {
  const [facets] = await AuditLog.aggregate([
    { $match: buildAuditFilter(query) },
    {
      $facet: {
        byCategory: [{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        byAction: [
          { $group: { _id: '$action', count: { $sum: 1 }, lastAt: { $max: '$occurredAt' } } },
          { $sort: { count: -1 } },
          { $limit: 25 },
        ],
        byResult: [{ $group: { _id: '$result', count: { $sum: 1 } } }],
        bySeverity: [{ $group: { _id: '$severity', count: { $sum: 1 } } }],
        actors: [
          {
            $group: {
              _id: '$actor',
              email: { $first: '$actorEmail' },
              role: { $first: '$actorRole' },
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 50 },
        ],
      },
    },
  ])

  return facets ?? { byCategory: [], byAction: [], byResult: [], bySeverity: [], actors: [] }
}

/**
 * Every entry matching a filter, for export.
 *
 * Hard-capped: an unbounded export is how a report request becomes an outage.
 * The cap is reported in the response so the operator knows the file is
 * partial rather than assuming it is complete.
 */
export function listAuditForExport(query, cap) {
  return AuditLog.find(buildAuditFilter(query)).sort(SORT).limit(cap).lean()
}

/** The whole collection's extent, for the retention and coverage panels. */
export async function auditStats() {
  const [oldest, newest, total] = await Promise.all([
    AuditLog.findOne({}).sort({ occurredAt: 1 }).select('occurredAt').lean(),
    AuditLog.findOne({}).sort({ occurredAt: -1 }).select('occurredAt').lean(),
    AuditLog.estimatedDocumentCount(),
  ])

  return {
    total,
    oldestAt: oldest?.occurredAt ?? null,
    newestAt: newest?.occurredAt ?? null,
  }
}

export default {
  auditFacets,
  auditStats,
  buildAuditFilter,
  countAuditEntries,
  findAuditEntry,
  listAuditEntries,
  listAuditForExport,
}
