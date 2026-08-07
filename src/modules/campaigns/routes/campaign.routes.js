/**
 * Campaign routes.
 *
 * Mounted at `${API_PREFIX}/v1/campaigns`.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth } from '../../../middlewares/authenticate.js'
import { requirePermission } from '../../../middlewares/authorise.js'
import { PERMISSIONS } from '../../../constants/permissions.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { providerErrorBoundary } from '../../provider/middleware/providerErrorBoundary.js'
import * as controller from '../controllers/campaign.controller.js'

/**
 * Throttle on the sending endpoint.
 *
 * Not a substitute for the per-campaign rate limits — those protect the mailbox
 * from the provider's perspective. This protects the *server* from a client
 * hammering `/send`, which would spawn overlapping drains competing for the
 * same recipients.
 */
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message:
        'Too many send requests. The campaign drains in batches — wait for the current one to finish.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

const router = Router()

// Applied to the whole router, so no route added here can be left unprotected.
router.use(requireAuth)

// --- Literal paths first, so they are not captured as campaign ids ---------
router.get('/analytics', controller.overview)

// Sending mailboxes with rotation health — the builder's rotation step.
router.get('/mailboxes', controller.listMailboxes)

router.get('/templates', controller.listTemplates)
router.post('/templates', controller.createTemplate)

/**
 * Deleting a template reaches the same library as `DELETE /templates/:id`, so it
 * carries the same role guard. Without it this was the shortcut around that
 * endpoint's protection — the one route on this router that can remove
 * something the morning workbook run depends on.
 *
 * Applied to this route alone. No other campaign route gains a role check, so
 * nothing that works today stops working.
 */
router.delete('/templates/:id', requirePermission(PERMISSIONS.CAMPAIGNS_DELETE), controller.deleteTemplate)

router.get('/sequences', controller.listSequences)
router.post('/sequences', controller.createSequence)

// --- Campaigns -------------------------------------------------------------
router.get('/', controller.list)
router.post('/', controller.create)

router.get('/:id', controller.getById)
router.put('/:id', controller.update)

router.post('/:id/audience', controller.rebuildAudience)
router.get('/:id/preview', controller.preview)
router.post('/:id/launch', controller.launch)
router.post('/:id/send', sendLimiter, controller.send)
router.post('/:id/control', controller.control)
router.post('/:id/clone', controller.clone)

router.get('/:id/recipients', controller.recipients)
router.get('/:id/events', controller.events)
router.get('/:id/analytics', controller.analytics)

// Translates a ProviderError into the standard envelope — campaign sending goes
// through the same provider layer as Phase 5.
router.use(providerErrorBoundary)

export default router
