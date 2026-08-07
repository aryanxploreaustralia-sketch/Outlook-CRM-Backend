/**
 * Scheduler routes.
 *
 * Mounted at `${API_PREFIX}/v1/scheduler`:
 *
 *   GET    /api/v1/scheduler       → configuration, last run, next run
 *   GET    /api/v1/scheduler/runs  → every attempt, paginated
 *   PATCH  /api/v1/scheduler       → enable, disable, time, timezone, retries
 *   POST   /api/v1/scheduler/run   → run today's scheduler now
 *
 * Its own mount rather than more paths under `/workbook`, for the same reason
 * the background routes got their own: the workbook endpoints keep exactly the
 * behaviour, responses and limits they have today, and nothing that works now
 * changes.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth } from '../../../middlewares/authenticate.js'
import { requirePermission } from '../../../middlewares/authorise.js'
import { PERMISSIONS } from '../../../constants/permissions.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import * as controller from '../controllers/scheduler.controller.js'

/**
 * Throttle on manual triggering.
 *
 * Generous, because the duplicate guards make a repeated press harmless — but
 * present, because each press reads a directory and hashes a file that may be
 * 25 MB, and there is no legitimate reason to do that thirty times a minute.
 */
const runNowLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'The scheduler has been triggered too often. Please wait a few minutes.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

const router = Router()

// Applied to the whole router, so no route added here can be left unprotected.
router.use(requireAuth)

/**
 * Reading is open to any signed-in member of the workspace.
 *
 * "When does the morning run happen, and did it happen today?" is something a
 * salesperson needs to know before they wonder why a customer has not replied.
 */
router.get('/', requirePermission(PERMISSIONS.SCHEDULER_VIEW), controller.settings)
router.get('/runs', requirePermission(PERMISSIONS.SCHEDULER_VIEW), controller.runs)

/**
 * Changing and triggering are privileged.
 *
 * `scheduler.manage` since Phase 14.4 — the capability rather than the role, for
 * the reason documented on that constant: the role defaults to `owner` and
 * every account in this deployment holds it, so requiring `admin` alone would
 * lock every real administrator out of the control built for them.
 */
router.patch('/', requirePermission(PERMISSIONS.SCHEDULER_MANAGE), controller.update)
router.post('/run', requirePermission(PERMISSIONS.SCHEDULER_MANAGE), runNowLimiter, controller.run)

/**
 * Reply sync, triggered by hand.
 *
 * Shares the limiter with the morning run's button: both are "do the expensive
 * thing now", and a shared budget is the honest ceiling on how often a person
 * can ask this server to go and talk to Microsoft.
 */
router.post(
  '/reply-sync/run',
  requirePermission(PERMISSIONS.SCHEDULER_MANAGE),
  runNowLimiter,
  controller.syncRepliesNow,
)

export default router
