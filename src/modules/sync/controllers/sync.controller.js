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
 */

import { z } from 'zod'

import * as service from '../services/sync.service.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'

/** The session's user. The only owner this module will ever use. */
const ownerOf = (req) => req.auth.user._id

/**
 * `GET /v1/sync/changes`
 *
 * Note the absence of `owner`. Zod strips unknown keys, so `?owner=<someone>`
 * is discarded here before any query is built — the same defence the lead and
 * contact list endpoints rely on.
 */
const changesQuerySchema = z.object({
  /**
   * Per-entity cursors, as `cursor.leads=…&cursor.contacts=…`.
   *
   * Express's default query parser expands dotted keys into an object, so this
   * arrives already shaped. An absent entry means "from the beginning" for that
   * entity, which is what makes a first sync and a resumed one the same call.
   */
  cursor: z
    .object({
      leads: z.string().max(512).optional(),
      contacts: z.string().max(512).optional(),
      companies: z.string().max(512).optional(),
    })
    .optional()
    .default({}),

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
    cursors: query.cursor,
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

export default { getChanges, getStatus }
