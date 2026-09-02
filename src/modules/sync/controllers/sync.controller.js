/**
 * The offline sync endpoints.
 *
 * Thin, like every other controller here: validate the query, delegate, shape
 * the response.
 *
 * ## The one security property this file exists to guarantee
 *
 * `owner` comes from `req.auth.user._id` and from nowhere else. The schema
 * below has **no** `owner` key, so Zod strips one if a client sends it, and the
 * service is called with the session's id explicitly. There is no code path,
 * anywhere in this module, by which a request can name whose records it wants.
 *
 * That is the same discipline `ownerOf(req)` enforces across the CRM's existing
 * controllers, and it is deliberately spelled the same way.
 *
 * ## Why the cursors are flat query parameters
 *
 * They were once a nested object — `cursor[leads]=…`, which is what Axios emits
 * for a nested `params` object. Express 5 defaults its query parser to
 * `"simple"` (Node's `querystring`), which does not nest: the key arrived
 * verbatim as the string `"cursor[leads]"`, Zod stripped it as unknown, and the
 * schema's own default supplied an empty cursor set. Every request therefore
 * read from the beginning of the feed, silently, while still handing back a
 * `nextCursor` the client dutifully stored and could never spend.
 *
 * One flat parameter per entity removes the failure mode rather than
 * compensating for it: `cursorLeads` survives every query parser there is,
 * because there is nothing to parse. The alternative — switching the
 * application to the `extended` parser — would have fixed this endpoint by
 * changing how *every* endpoint reads its query string, which is a far larger
 * blast radius than the bug warrants.
 *
 * The names are derived from `SYNC_ENTITIES` below rather than written out, so
 * a fourth entity cannot arrive with its parameter missing.
 */

import { z } from 'zod'

import * as service from '../services/sync.service.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'

/** The session's user. The only owner this module will ever use. */
const ownerOf = (req) => req.auth.user._id

/**
 * The query parameter carrying one entity's cursor: `leads` → `cursorLeads`.
 *
 * Exported because the verification scripts build their requests with it. A
 * test that spelled the parameter by hand could drift from the schema and still
 * pass, which is precisely how the nested-cursor bug survived its own suite.
 *
 * @param {string} entity
 * @returns {string}
 */
export const cursorParam = (entity) => `cursor${entity[0].toUpperCase()}${entity.slice(1)}`

/**
 * `GET /v1/sync/changes`
 *
 * Note the absence of `owner`. Zod strips unknown keys, so `?owner=<someone>`
 * is discarded here before any query is built — the same defence the lead and
 * contact list endpoints rely on.
 */
const changesQuerySchema = z.object({
  /*
   * One cursor per entity, flat: `?cursorLeads=…&cursorContacts=…`.
   *
   * An absent parameter means "from the beginning" for that entity, which is
   * what makes a first sync and a resumed one the same call.
   */
  ...Object.fromEntries(
    service.SYNC_ENTITIES.map((entity) => [cursorParam(entity), z.string().max(512).optional()]),
  ),

  /**
   * A wall-clock fallback, applied to any entity with no cursor.
   *
   * Offered because it is the obvious thing to reach for. The cursor is exact
   * and should be preferred; this is inclusive of its own millisecond, so it
   * may repeat a record rather than risk skipping one.
   */
  since: z.string().datetime({ offset: true }).optional(),

  /** Which entities to fetch. Defaults to all three. */
  entities: z
    .string()
    .optional()
    .transform((value) =>
      value ? value.split(',').map((entity) => entity.trim()).filter(Boolean) : undefined,
    ),

  limit: z.coerce.number().int().min(1).max(service.MAX_LIMIT).optional().default(service.DEFAULT_LIMIT),
})

/**
 * Collects the flat parameters back into the `{ leads, contacts, companies }`
 * object the service takes.
 *
 * The internal shape is unchanged and deliberately so — only the HTTP
 * representation was ever the problem. An empty string is dropped rather than
 * forwarded, because `decodeCursor` rightly refuses one and a client that sent
 * it means "from the beginning".
 *
 * @param {object} query Parsed query.
 * @returns {Record<string, string>}
 */
const cursorsFrom = (query) =>
  Object.fromEntries(
    service.SYNC_ENTITIES
      .map((entity) => [entity, query[cursorParam(entity)]])
      .filter(([, cursor]) => typeof cursor === 'string' && cursor !== ''),
  )

/**
 * GET /api/v1/sync/changes
 *
 * Everything that changed for the signed-in user since their cursor.
 */
export const getChanges = asyncHandler(async (req, res) => {
  const query = changesQuerySchema.parse(req.query)

  const feed = await service.buildChangeFeed({
    // From the session. Never from `query`.
    owner: ownerOf(req),
    entities: query.entities ?? service.SYNC_ENTITIES,
    cursors: cursorsFrom(query),
    since: query.since ?? null,
    limit: query.limit,
  })

  const total = Object.values(feed.entities).reduce((sum, e) => sum + e.records.length, 0)

  return sendSuccess(res, {
    message: `${total} change(s) since the supplied cursor.`,
    data: feed,
  })
})

/**
 * GET /api/v1/sync/status
 *
 * How much is waiting, without transferring any of it — so a client can decide
 * whether a sync is worth starting on a metered connection, and so the
 * eventual status UI has a cheap thing to poll.
 */
export const getStatus = asyncHandler(async (req, res) => {
  const feed = await service.buildChangeFeed({
    owner: ownerOf(req),
    entities: service.SYNC_ENTITIES,
    cursors: {},
    since: null,
    /* One row per entity: enough to know whether anything is there. */
    limit: 1,
  })

  return sendSuccess(res, {
    message: 'Sync status.',
    data: {
      serverTime: feed.serverTime,
      entities: service.SYNC_ENTITIES,
      maxLimit: service.MAX_LIMIT,
      defaultLimit: service.DEFAULT_LIMIT,
      hasChanges: feed.hasMore || Object.values(feed.entities).some((e) => e.records.length > 0),
    },
  })
})

export default { getChanges, getStatus, cursorParam }
