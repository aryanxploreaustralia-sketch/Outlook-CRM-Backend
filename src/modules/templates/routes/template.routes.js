/**
 * Email template routes.
 *
 * Mounted at `${API_PREFIX}/v1/templates`.
 *
 * ## Who may do what
 *
 * Reading and previewing are open to any signed-in user — a salesperson should
 * be able to see what the company sends without being able to change it.
 * Everything that writes requires an elevated role, because the active template
 * is what goes to customers unattended every morning; an accidental edit there
 * is not a local mistake.
 *
 * Guarded by `templates.manage` since Phase 14.4, so
 * there is one answer in the codebase to "who can change things that reach
 * customers".
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth, requireOutlookConnection } from '../../../middlewares/authenticate.js'
import { requirePermission } from '../../../middlewares/authorise.js'
import { PERMISSIONS } from '../../../constants/permissions.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { providerErrorBoundary } from '../../provider/middleware/providerErrorBoundary.js'
import * as controller from '../controllers/template.controller.js'

/**
 * Test sends are throttled harder than anything else here.
 *
 * They are the one endpoint on this router with an irreversible external
 * effect, they accept an arbitrary destination address, and a loop over them
 * would burn the tenant's Exchange quota while looking like outbound spam from
 * the company's own domain. Ten in fifteen minutes is far above checking your
 * work and far below anything that could damage the mailbox's reputation.
 */
const testLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many test emails. Please wait a few minutes before sending another.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

const router = Router()

// Applied to the whole router, so no route added here can be left unprotected.
router.use(requireAuth)

// --- Literal paths first, so none of them is captured as a template id ------
router.get('/active', controller.active)
router.get('/variables', controller.variables)
router.post('/preview', controller.preview)
router.post(
  '/test-email',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  testLimiter,
  requireOutlookConnection,
  controller.testEmail,
)

// --- Library ---------------------------------------------------------------
router.get('/', controller.list)
router.post('/', requirePermission(PERMISSIONS.TEMPLATES_MANAGE), controller.create)

router.get('/:id', controller.getById)
router.put('/:id', requirePermission(PERMISSIONS.TEMPLATES_MANAGE), controller.update)
router.delete('/:id', requirePermission(PERMISSIONS.TEMPLATES_MANAGE), controller.remove)

// --- Lifecycle -------------------------------------------------------------
router.post('/:id/activate', requirePermission(PERMISSIONS.TEMPLATES_MANAGE), controller.activate)
router.post('/:id/deactivate', requirePermission(PERMISSIONS.TEMPLATES_MANAGE), controller.deactivate)
router.post('/:id/archive', requirePermission(PERMISSIONS.TEMPLATES_MANAGE), controller.archive)
router.post('/:id/restore', requirePermission(PERMISSIONS.TEMPLATES_MANAGE), controller.restore)
router.post('/:id/duplicate', requirePermission(PERMISSIONS.TEMPLATES_MANAGE), controller.duplicate)

// Translates a ProviderError into the standard envelope — the test send goes
// through the same provider layer as everything else that reaches Microsoft.
router.use(providerErrorBoundary)

export default router
