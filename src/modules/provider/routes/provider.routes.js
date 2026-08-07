/**
 * Provider routes.
 *
 * Mounted at `${API_PREFIX}/v1/provider`, so with the default prefix:
 *   GET  /api/v1/provider/status
 *   GET  /api/v1/provider/validate
 *   GET  /api/v1/provider/folders
 *   POST /api/v1/provider/connect
 *   POST /api/v1/provider/disconnect
 *   POST /api/v1/provider/sync
 *   POST /api/v1/provider/sync/inbox
 *   POST /api/v1/provider/sync/sent
 *   POST /api/v1/provider/sync/drafts
 *   POST /api/v1/provider/sync/archive
 *   GET  /api/v1/provider/history
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth } from '../../../middlewares/authenticate.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import * as controller from '../controllers/provider.controller.js'
import { providerErrorBoundary } from '../middleware/providerErrorBoundary.js'

const router = Router()

/**
 * Sync-specific throttle.
 *
 * A sync run makes many upstream calls and writes many documents, so it is far
 * more expensive than an ordinary request. Providers also throttle per mailbox:
 * hammering `/sync` produces 429s upstream and makes synchronisation slower, not
 * faster. Twenty runs per fifteen minutes is well above interactive use and far
 * below anything that looks like a loop.
 */
const syncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message:
        'Too many synchronisation requests. Please wait a few minutes — syncing more often does not retrieve mail faster.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

// Applied to the whole router, so no route added here can be left unprotected.
router.use(requireAuth)

// --- Reads ---------------------------------------------------------------
// Deliberately not gated on a live connection: reporting "not connected" is the
// answer the UI needs, and refusing to answer would leave it unable to render.
router.get('/status', controller.getStatus)
router.get('/validate', controller.validate)
router.get('/folders', controller.getFolders)
router.get('/history', controller.getHistory)

// --- Connection lifecycle -------------------------------------------------
router.post('/connect', controller.connect)
router.post('/disconnect', controller.disconnect)

// --- Synchronisation ------------------------------------------------------
// Per-folder routes are registered before the general one for readability; they
// are distinct paths, so ordering does not affect matching.
router.post('/sync/inbox', syncLimiter, controller.syncInbox)
router.post('/sync/sent', syncLimiter, controller.syncSent)
router.post('/sync/drafts', syncLimiter, controller.syncDrafts)
router.post('/sync/archive', syncLimiter, controller.syncArchive)
router.post('/sync', syncLimiter, controller.sync)

// Registered last: translates ProviderError into the standard envelope before
// the application's global handler sees it.
router.use(providerErrorBoundary)

export default router
