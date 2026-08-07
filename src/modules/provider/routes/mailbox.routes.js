/**
 * Connected mailbox routes.
 *
 * Mounted at `${API_PREFIX}/v1/mailboxes`, so with the default prefix:
 *   GET    /api/v1/mailboxes
 *   GET    /api/v1/mailboxes/connect     → redirects to Microsoft
 *   GET    /api/v1/mailboxes/callback    → Microsoft redirect target
 *   PATCH  /api/v1/mailboxes/:id/default
 *   DELETE /api/v1/mailboxes/:id
 *
 * A new router rather than more routes on `/provider`, because `/provider/*`
 * addresses *the* mailbox in the singular — `/provider/status`,
 * `/provider/disconnect` — and every one of those paths is still in use by the
 * provider page. Bending them to mean "one of several" would have changed the
 * meaning of endpoints that already have clients. They are left exactly as they
 * were.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth } from '../../../middlewares/authenticate.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import * as controller from '../controllers/mailbox.controller.js'
import { providerErrorBoundary } from '../middleware/providerErrorBoundary.js'

const router = Router()

/**
 * Throttle on starting a connection.
 *
 * Each attempt writes a flow record and sends someone to Microsoft; a loop
 * would fill the collection and hammer Entra ID's authorize endpoint. Ten in
 * fifteen minutes is far above connecting three mailboxes in a sitting and far
 * below anything automated.
 */
const connectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many mailbox connection attempts. Please wait a few minutes.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

/**
 * The callback is registered before `requireAuth` is applied.
 *
 * See the handler for why it is open: authority comes from the single-use
 * `AuthFlow` record, not from the session cookie, and requiring the cookie
 * would fail legitimate connections whose return trip does not carry it.
 */
router.get('/callback', controller.callback)

// Everything below acts on the caller's own mailboxes and requires a session.
router.use(requireAuth)

router.get('/', controller.list)
router.get('/connect', connectLimiter, controller.connect)

router.patch('/:id/default', controller.setDefault)
router.delete('/:id', controller.disconnect)

// Registered last: translates ProviderError into the standard envelope before
// the application's global handler sees it.
router.use(providerErrorBoundary)

export default router
