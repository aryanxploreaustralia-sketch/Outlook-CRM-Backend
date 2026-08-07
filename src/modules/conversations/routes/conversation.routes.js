/**
 * Conversation routes.
 *
 * Mounted at `${API_PREFIX}/v1/conversations`.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth } from '../../../middlewares/authenticate.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { providerErrorBoundary } from '../../provider/middleware/providerErrorBoundary.js'
import * as controller from '../controllers/conversation.controller.js'

/**
 * Throttle for the two expensive operations.
 *
 * A sync pulls up to 200 messages and then downloads their attachments; a reply
 * is a live send. Reading the list stays under the global limiter, which is
 * what the conversation screen polls.
 */
const heavyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many sync or send requests. Wait a moment before trying again.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

const router = Router()

// Applied to the whole router, so no route added here can be left unprotected.
router.use(requireAuth)

// --- Literal paths first, so they are not captured as conversation ids ------
router.get('/filters', controller.filters)
router.get('/statistics', controller.statistics)
router.get('/search', controller.search)
router.get('/activity', controller.activityFeed)
router.get('/tasks', controller.listTasks)

router.post('/sync', heavyLimiter, controller.sync)
router.post('/reply', heavyLimiter, controller.reply)

router.post('/note', controller.addNote)
router.patch('/note/:id/pin', controller.pinNote)

router.post('/task', controller.createTask)
router.put('/task/:id', controller.updateTask)
router.post('/followup', controller.createFollowUp)

router.get('/attachments/:id/download', controller.downloadAttachment)

router.get('/lead/:leadId', controller.leadTimeline)

// --- Conversation by id -----------------------------------------------------
router.get('/', controller.list)
router.get('/:id', controller.getById)
router.post('/:id/assign', controller.assign)
router.post('/:id/status', controller.setStatus)
router.post('/:id/read', controller.markRead)
router.post('/:id/link', controller.link)
router.post('/:id/stage', controller.changeStage)

// Translates a ProviderError into the standard envelope — replying and syncing
// both go through the Phase 5 provider layer.
router.use(providerErrorBoundary)

export default router
