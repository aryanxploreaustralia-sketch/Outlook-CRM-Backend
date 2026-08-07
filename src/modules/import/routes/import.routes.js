/**
 * Import routes.
 *
 * Mounted at `${API_PREFIX}/v1/import`.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth } from '../../../middlewares/authenticate.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import * as controller from '../controllers/import.controller.js'

/**
 * Throttle for the expensive operations.
 *
 * An upload parses a 25 MB workbook and a run writes tens of thousands of
 * documents. The global limiter is far too permissive for either, while reading
 * job status stays under it — the wizard polls that while a run is in progress.
 */
const heavyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many import operations. Please wait a few minutes before uploading again.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

const router = Router()

// Applied to the whole router, so no route added here can be left unprotected.
router.use(requireAuth)

// --- Literal paths first, so they are not captured as job ids -------------
router.get('/statistics', controller.statistics)
router.get('/templates', controller.listTemplates)
router.post('/templates', controller.saveTemplate)
router.delete('/templates/:id', controller.deleteTemplate)

router.get('/jobs', controller.listJobs)

// --- Wizard ---------------------------------------------------------------
router.post('/upload', heavyLimiter, controller.upload)

router.get('/jobs/:id', controller.getJob)
router.put('/jobs/:id/mapping', controller.setMapping)
router.post('/jobs/:id/analyse', heavyLimiter, controller.analyse)
router.post('/jobs/:id/run', heavyLimiter, controller.run)
router.post('/jobs/:id/rollback', controller.rollback)
router.post('/jobs/:id/apply-template/:templateId', controller.applyTemplate)

export default router
