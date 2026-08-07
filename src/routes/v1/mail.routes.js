/**
 * Mail routes.
 *
 * Mounted at `${API_PREFIX}/v1/mail`, so with the default prefix:
 *   POST   /api/v1/mail/send
 *   POST   /api/v1/mail/draft
 *   GET    /api/v1/mail/history
 *   GET    /api/v1/mail/:id
 *   DELETE /api/v1/mail/:id
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { draft, getById, history, remove, send } from '../../controllers/mail.controller.js'
import { requireAuth, requireOutlookConnection } from '../../middlewares/authenticate.js'
import { ERROR_CODES } from '../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../constants/httpStatus.js'

const router = Router()

/**
 * Send-specific throttle.
 *
 * The global limiter (300 / 15 min) is the wrong shape here. Sending is the one
 * operation in this API with an irreversible external effect, and an automation
 * bug that loops over `/send` would burn the tenant's Exchange quota and can get
 * the mailbox flagged for spam. 60 per 15 minutes is comfortably above real
 * interactive use and well below anything that looks like a runaway.
 *
 * Reads are not limited beyond the global policy — they are cheap and harmless.
 */
const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message:
        'Too many messages sent in a short period. Please wait a few minutes before sending again.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

// Applied to the whole router so no route added here can be left unprotected.
router.use(requireAuth)

// --- Writes that reach Microsoft ------------------------------------------
// `requireOutlookConnection` is applied per-route rather than router-wide: a
// user whose mailbox has disconnected must still be able to read and clean up
// their history, which is exactly when they most want to.
router.post('/send', sendLimiter, requireOutlookConnection, send)
router.post('/draft', sendLimiter, requireOutlookConnection, draft)

// --- Reads and local deletes ----------------------------------------------
// Registered before `/:id` so the literal path is not captured as an id.
router.get('/history', history)

router.get('/:id', getById)
router.delete('/:id', remove)

export default router
