/**
 * Global search routes.
 *
 * Mounted at `${API_PREFIX}/v1/search`.
 *
 * ## Authentication only, and no route-level permission
 *
 * That is not a gap. A permission here would have to be the *union* of nine
 * different ones, and holding it would say nothing about which sources a caller
 * may read. The check that matters is per source, inside the service, where a
 * source the caller lacks is never queried at all. Guarding the route as well
 * would add a check that is either redundant or wrong.
 *
 * ## Rate limited
 *
 * Search-as-you-type is debounced at 300ms in the client, but the client is not
 * a control: a script can call this as fast as it likes, and each call fans out
 * to nine indexed queries. The limit is generous enough that a person typing
 * never meets it.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { requireAuth } from '../../../middlewares/authenticate.js'
import * as controller from '../controllers/search.controller.js'

const router = Router()

router.use(requireAuth)

const searchLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many searches. Please wait a moment.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

/** Literal path first, so it cannot be read as a search term. */
router.get('/sources', controller.listSources)
router.get('/', searchLimiter, controller.globalSearch)

export default router
