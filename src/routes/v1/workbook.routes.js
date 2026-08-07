/**
 * Background workbook routes.
 *
 * Mounted at `${API_PREFIX}/v1/workbook`:
 *
 *   POST /api/v1/workbook/sync              → 202 with a job id
 *   GET  /api/v1/workbook/jobs              → recent background runs
 *   GET  /api/v1/workbook/jobs/:id          → live progress
 *   POST /api/v1/workbook/jobs/:id/cancel   → stop at the next batch boundary
 *
 * A separate mount rather than more paths under `/leads/workbook`, so the
 * synchronous endpoints there keep their exact behaviour, their exact responses
 * and their exact rate limit. Nothing that works today changes.
 */

import express, { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth } from '../../middlewares/authenticate.js'
import { ERROR_CODES } from '../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../constants/httpStatus.js'
import { MAX_FILE_BYTES } from '../../modules/import/constants/importConstants.js'
import * as controller from '../../modules/leads/controllers/workbookJob.controller.js'

/**
 * Throttle on queueing.
 *
 * Matched to the synchronous endpoint's limit rather than relaxed. Returning
 * immediately makes uploading cheap for the *client*, which is exactly why the
 * server still needs a ceiling — twenty-five queued 25 MB workbooks would sit
 * on disk waiting for a worker that processes one at a time.
 *
 * Polling is not limited beyond the global policy: it reads one document, and
 * the UI is expected to do it every couple of seconds.
 */
const queueLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many workbook uploads. Please wait a few minutes before queueing another.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

/** The upload body — one file, filename in `X-Filename`, as elsewhere. */
const rawUpload = express.raw({ type: () => true, limit: MAX_FILE_BYTES })

const router = Router()

// Applied to the whole router, so no route added here can be left unprotected.
router.use(requireAuth)

router.post('/sync', queueLimiter, rawUpload, controller.enqueue)

// Literal path before `/jobs/:id`, so "jobs" is never read as an id.
router.get('/jobs', controller.list)
router.get('/jobs/:id', controller.status)
router.post('/jobs/:id/cancel', controller.cancel)

export default router
