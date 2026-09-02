/**
 * The incremental change feed.
 *
 * Answers one question — *what has changed for me since T?* — for the three
 * entities an offline client caches. Everything else the CRM holds is out of
 * scope by design; see the note at the foot of this file.
 *
 * ## The cursor
 *
 * `updatedAt` alone is not a safe cursor. Two records saved in the same
 * millisecond share a timestamp, and a page boundary that lands between them
 * either skips one (`$gt`) or repeats the whole group forever (`$gte`). The
 * import writes hundreds of leads a second, so this is not a theoretical
 * problem here.
 *
 * The cursor is therefore the pair **(updatedAt, _id)**, encoded as one opaque
 * string. `_id` is unique, so the pair is a total order, and the "next page"
 * predicate becomes:
 *
 *     updatedAt > T   OR   (updatedAt == T AND _id > lastId)
 *
 * which skips exactly what has been seen and nothing else. The
 * `{ owner, updatedAt, _id }` index makes both the filter and the sort
 * index-served.
 *
 * ## Deletions travel in the same feed
 *
 * Every ordinary deletion in this CRM is a soft delete, and a soft delete bumps
 * `updatedAt` — so a deleted record arrives as an ordinary change carrying
 * `isDeleted: true`. Nothing special is needed and no tombstone is written.
 *
 * The two paths that remove documents outright are covered by `SyncTombstone`,
 * which is read alongside. See `tombstone.service.js`.
 *
 * ## Authorisation
 *
 * `owner` is taken from the authenticated session and **never** from the
 * request. There is no code path here that reads an owner from a query string;
 * the parameter does not exist. See `sync.controller.js`.
 */

import { Lead } from '../../../models/lead.model.js'
import { Contact } from '../../../models/contact.model.js'
import { Company } from '../../../models/company.model.js'
import { SyncTombstone } from '../../../models/syncTombstone.model.js'
import { ApiError } from '../../../utils/ApiError.js'

/**
 * Entities the feed serves, and the model behind each.
 *
 * `dto` names the serialiser to use. Lead and Contact both expose a
 * `toSummaryJSON` — the shape their list endpoints return, and therefore the
 * shape an offline cache should hold. `Company` has only `toPublicJSON`, which
 * is what `GET /companies` itself returns, so that is the right one for it.
 * Naming the method per entity rather than assuming one exists everywhere is
 * what keeps the cached shape identical to the online one.
 */
const ENTITIES = Object.freeze({
  leads: { model: Lead, tombstoneType: 'lead', dto: 'toSummaryJSON' },
  contacts: { model: Contact, tombstoneType: 'contact', dto: 'toSummaryJSON' },
  companies: { model: Company, tombstoneType: 'company', dto: 'toPublicJSON' },
})

export const SYNC_ENTITIES = Object.freeze(Object.keys(ENTITIES))

/**
 * Page size bounds.
 *
 * The default is deliberately modest: a first sync of 1,861 leads is eight
 * requests rather than one 5 MB response, and eight small responses recover
 * from a dropped connection eight times more cheaply. The ceiling stops a
 * client asking for the whole register in one go.
 */
export const DEFAULT_LIMIT = 250
export const MAX_LIMIT = 500

/**
 * Encodes `(updatedAt, _id)` as one opaque cursor.
 *
 * Opaque because it is the server's business how a position is represented —
 * a client that parsed it would couple itself to that choice. Base64url so it
 * survives a query string without escaping.
 */
export function encodeCursor(updatedAt, id) {
  const raw = `${new Date(updatedAt).toISOString()}|${String(id)}`
  return Buffer.from(raw, 'utf8').toString('base64url')
}

/**
 * Decodes a cursor, or throws a 400.
 *
 * A malformed cursor is refused rather than treated as "start from the
 * beginning": silently restarting a sync would hand the client the entire
 * register and look like a hang, and the cause would be invisible.
 *
 * @returns {{ updatedAt: Date, id: string }}
 */
export function decodeCursor(cursor) {
  let decoded
  try {
    decoded = Buffer.from(String(cursor), 'base64url').toString('utf8')
  } catch {
    throw ApiError.badRequest('That sync cursor is not valid.')
  }

  const separator = decoded.lastIndexOf('|')
  if (separator === -1) throw ApiError.badRequest('That sync cursor is not valid.')

  const updatedAt = new Date(decoded.slice(0, separator))
  const id = decoded.slice(separator + 1)

  if (Number.isNaN(updatedAt.getTime()) || id === '') {
    throw ApiError.badRequest('That sync cursor is not valid.')
  }

  return { updatedAt, id }
}

/**
 * The "everything after this position" predicate.
 *
 * `null` position means the beginning of time — an initial sync — and adds no
 * clause at all rather than comparing against a sentinel date.
 */
function afterPosition(position) {
  if (!position) return {}

  return {
    $or: [
      { updatedAt: { $gt: position.updatedAt } },
      { updatedAt: position.updatedAt, _id: { $gt: position.id } },
    ],
  }
}

/**
 * Resolves the starting position from either parameter.
 *
 * `cursor` is preferred and exact. `since` is offered because it is the obvious
 * thing to reach for and a client resuming from a stored timestamp should not
 * be refused — it is converted to the earliest position at that instant.
 */
function resolvePosition({ cursor = null, since = null }) {
  if (cursor) return decodeCursor(cursor)
  if (!since) return null

  const updatedAt = new Date(since)
  if (Number.isNaN(updatedAt.getTime())) {
    throw ApiError.badRequest('“since” must be an ISO 8601 timestamp.')
  }

  /*
   * An all-zero ObjectId sorts before every real one, so `(t, 000…0)` is the
   * position immediately *before* anything saved at `t` — which makes `since`
   * inclusive of that millisecond. Inclusive is the safe direction: a repeated
   * record is idempotent on the client, a skipped one is lost.
   */
  return { updatedAt, id: '000000000000000000000000' }
}

/**
 * One entity's changes since a position.
 *
 * @param {object}  params
 * @param {string}  params.entity   'leads' | 'contacts' | 'companies'
 * @param {any}     params.owner    From the session. Never from the request.
 * @param {?object} params.position
 * @param {number}  params.limit
 */
async function readEntityChanges({ entity, owner, position, limit }) {
  const { model } = ENTITIES[entity]

  /*
   * `owner` last, for the same reason `buildLeadFilter` puts it last: nothing
   * merged in afterwards can displace it. Here the object is built inline and
   * no caller-supplied criteria exist at all, which is the stronger guarantee —
   * but the ordering is kept so the rule reads the same everywhere.
   */
  const filter = { ...afterPosition(position), owner }

  /*
   * One extra row, to answer "is there more?" without a second count query.
   * A `countDocuments` on the same predicate would double the work of every
   * poll to learn one boolean.
   */
  const rows = await model
    .find(filter)
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit + 1)
    .lean()

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  return { rows: page, hasMore }
}

/** Tombstones since a position, for one entity. */
async function readTombstones({ entity, owner, position, limit }) {
  const { tombstoneType } = ENTITIES[entity]

  const filter = {
    entityType: tombstoneType,
    ...(position ? { deletedAt: { $gte: position.updatedAt } } : {}),
    owner,
  }

  const rows = await SyncTombstone.find(filter)
    .sort({ deletedAt: 1, _id: 1 })
    .limit(limit)
    .select('entityType entityId deletedAt reason')
    .lean()

  return rows.map((row) => ({
    entity,
    id: row.entityId ? String(row.entityId) : null,
    deletedAt: row.deletedAt,
    reason: row.reason ?? null,
    /* A null id means the whole entity went — the client must start again. */
    purged: row.entityId === null,
  }))
}

/**
 * Builds the change feed.
 *
 * Each entity carries its **own** cursor. They change at different rates —
 * an import touches thousands of leads and no companies — and one shared
 * cursor would drag the quiet entities through the busy one's pages.
 *
 * @param {object}   params
 * @param {any}      params.owner      From the session.
 * @param {string[]} [params.entities] Defaults to all three.
 * @param {object}   [params.cursors]  Per entity: `{ leads: '<cursor>' }`.
 * @param {?string}  [params.since]    ISO timestamp, applied where no cursor.
 * @param {number}   [params.limit]
 */
export async function buildChangeFeed({
  owner,
  entities = SYNC_ENTITIES,
  cursors = {},
  since = null,
  limit = DEFAULT_LIMIT,
}) {
  if (!owner) throw ApiError.unauthorized('A sync request needs an authenticated user.')

  const requested = entities.filter((entity) => SYNC_ENTITIES.includes(entity))
  if (requested.length === 0) {
    throw ApiError.badRequest(`“entities” must name at least one of: ${SYNC_ENTITIES.join(', ')}.`)
  }

  const pageSize = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const serverTime = new Date()

  const results = await Promise.all(requested.map(async (entity) => {
    const position = resolvePosition({ cursor: cursors[entity] ?? null, since })

    const [{ rows, hasMore }, deleted] = await Promise.all([
      readEntityChanges({ entity, owner, position, limit: pageSize }),
      readTombstones({ entity, owner, position, limit: pageSize }),
    ])

    const last = rows[rows.length - 1]

    return {
      entity,
      /*
       * The DTO the CRM already returns, not the raw document. A client caching
       * `toSummaryJSON()` is caching what the existing pages render, so the
       * offline copy and the online one cannot disagree about shape.
       *
       * `.lean()` above means these are plain objects, so the model's methods
       * are called through `hydrate`.
       */
      records: rows.map((row) => {
        const { model, dto } = ENTITIES[entity]
        return model.hydrate(row)[dto]()
      }),
      deleted,
      /*
       * The cursor to send next time. When a page came back, it is the last
       * row's position; when nothing changed, the caller's own cursor is
       * returned unchanged so an idle client does not lose its place.
       */
      nextCursor: last ? encodeCursor(last.updatedAt, last._id) : (cursors[entity] ?? null),
      hasMore,
    }
  }))

  const byEntity = Object.fromEntries(results.map((r) => [r.entity, r]))

  return {
    entities: byEntity,
    /*
     * Stated so a client can store a wall-clock time alongside its cursors
     * without trusting its own clock, which may be minutes out.
     */
    serverTime: serverTime.toISOString(),
    hasMore: results.some((r) => r.hasMore),
  }
}

export default { buildChangeFeed, encodeCursor, decodeCursor, SYNC_ENTITIES, DEFAULT_LIMIT, MAX_LIMIT }
