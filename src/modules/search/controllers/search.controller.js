/**
 * Global search.
 *
 * One endpoint, grouped results, permission-aware. Nothing is filtered on the
 * client — the response contains only what the caller may already read, because
 * a source they lack is never queried.
 */

import { z } from 'zod'

import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { resolvePermissions } from '../../../middlewares/authorise.js'
import { SEARCH_SOURCES, search } from '../services/search.service.js'

const SOURCE_KEYS = SEARCH_SOURCES.map((source) => source.key)

/**
 * `GET /api/v1/search`
 *
 * A two-character minimum: one character matches most of the database and
 * turns every keystroke into nine scans for a result set nobody can use.
 */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least two characters.').max(120),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  /** Restrict to named groups, for "see all in Users". */
  only: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value.split(',').filter((key) => SOURCE_KEYS.includes(key)) : null)),
})

export const globalSearch = asyncHandler(async (req, res) => {
  const { q, limit, only } = searchQuerySchema.parse(req.query)

  /**
   * The caller's effective permissions, from the engine that guards every
   * route — not a fresh derivation.
   *
   * `resolvePermissions` memoises per request, so asking here costs nothing and
   * guarantees search agrees with the middleware about what this person may
   * read. A second derivation is a second thing to keep in step.
   */
  const permissions = resolvePermissions(req)

  return sendSuccess(res, {
    message: 'Search completed.',
    data: await search({ term: q, user: req.auth.user, permissions, limit, only }),
  })
})

/**
 * `GET /api/v1/search/sources`
 *
 * Which groups this caller's searches will cover. Lets the palette show its
 * scope up front rather than leaving somebody to infer it from absent results.
 */
export const listSources = asyncHandler(async (req, res) => {
  const permissions = resolvePermissions(req)

  return sendSuccess(res, {
    message: 'Search sources loaded.',
    data: {
      sources: SEARCH_SOURCES.map((source) => ({
        key: source.key,
        label: source.label,
        icon: source.icon,
        permission: source.permission,
        available: source.permission === null || permissions.has(source.permission),
      })),
    },
  })
})

export default { globalSearch, listSources }
