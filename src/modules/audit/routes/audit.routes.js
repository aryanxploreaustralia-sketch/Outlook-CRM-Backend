/**
 * Audit routes.
 *
 * Mounted at `${API_PREFIX}/v1/audit`.
 *
 * ## Every route needs `audit.view`, with no exception
 *
 * Unlike the admin router, which has one authentication-only endpoint, this one
 * has none. There is nothing here a caller is entitled to see merely by being
 * signed in: the log records other people's actions, their addresses and their
 * devices, and "my own entries" is not a supported view precisely because
 * letting somebody read the log filtered to themselves also tells them what is
 * recorded about them and when — which is the first thing anybody covering
 * their tracks would want to know.
 *
 * ## GET only
 *
 * No POST, no PATCH, no DELETE. Entries are written by `recordAudit()` from
 * inside the modules that perform the actions, and removed only by the
 * retention TTL. An endpoint that could add an entry would let a caller forge
 * one; an endpoint that could remove one would let them erase it. Both are
 * absent rather than disabled.
 *
 * ## Failure is 403, never 404
 *
 * Consistent with the rest of the console. Answering 404 to a caller without
 * the permission would send them looking for a missing page rather than a
 * missing grant.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { PERMISSIONS } from '../../../constants/permissions.js'
import { requireAuth } from '../../../middlewares/authenticate.js'
import { requirePermission } from '../../../middlewares/authorise.js'
import * as controller from '../controllers/audit.controller.js'

const router = Router()

/**
 * Authentication at the router level, not per route.
 *
 * Same reasoning as the admin router: a route added later cannot be left
 * unprotected by forgetting a line.
 */
router.use(requireAuth)

/** Reads. Generous, because paging a log is a lot of small requests. */
const readLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many audit requests. Please wait a moment.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

/**
 * Export. Far tighter.
 *
 * One request can read ten thousand documents and serialise them, which is the
 * most expensive thing this module does. Six an hour is enough for an operator
 * pulling a report and not enough to use as a scraping loop.
 */
const exportLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Export limit reached. Please wait before exporting again.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

const guard = requirePermission(PERMISSIONS.AUDIT_VIEW)

/** The log itself. Cursor- or page-paginated, filtered server-side. */
router.get('/logs', guard, readLimiter, controller.getAuditLogs)

/** Filter options with counts. Registered before `/logs/:id` cannot shadow it. */
router.get('/facets', guard, readLimiter, controller.getAuditFilterFacets)

/** Extent, retention and coverage. */
router.get('/overview', guard, readLimiter, controller.getAuditSummary)

/** The grouped activity feed. */
router.get('/timeline', guard, readLimiter, controller.getAuditActivityTimeline)

/** CSV or JSON, honouring the current filter. */
router.get('/export', guard, exportLimiter, controller.exportAuditLogs)

/**
 * One entry.
 *
 * Last, so a literal path like `/logs/export` could never be swallowed by the
 * `:id` parameter. It is under `/logs/` rather than at the root for the same
 * reason — a bare `/:id` would shadow every sibling added later.
 */
router.get('/logs/:id', guard, readLimiter, controller.getAuditLogDetail)

export default router
