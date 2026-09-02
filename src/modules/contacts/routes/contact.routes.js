/**
 * Contact routes.
 *
 * Mounted at `${API_PREFIX}/v1/contacts` and `${API_PREFIX}/v1/contact-groups`.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth } from '../../../middlewares/authenticate.js'
import { idempotent } from '../../../middlewares/idempotency.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { providerErrorBoundary } from '../../provider/middleware/providerErrorBoundary.js'
import * as contacts from '../controllers/contact.controller.js'
import * as groups from '../controllers/contactGroup.controller.js'

/**
 * Throttle for the expensive operations.
 *
 * Sync, import and export each touch the whole address book — a sync makes many
 * upstream calls, an import writes thousands of documents, an export builds a
 * file in memory. The global limiter is far too permissive for those, while
 * ordinary reads and edits stay under it.
 */
const heavyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message:
        'Too many synchronisation or transfer requests. Please wait a few minutes before trying again.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

// --- Contacts --------------------------------------------------------------

export const contactRouter = Router()

// Applied to the whole router, so no route added here can be left unprotected.
contactRouter.use(requireAuth)

/**
 * Literal paths are registered before `/:id`.
 *
 * Without this, `GET /contacts/statistics` would match the id route and fail
 * validation with "that is not a valid contact id" — a confusing error for a
 * perfectly good request.
 */
contactRouter.get('/statistics', contacts.statistics)
contactRouter.get('/duplicates', contacts.duplicates)
contactRouter.get('/providers', contacts.providers)

contactRouter.post('/sync', heavyLimiter, contacts.sync)
contactRouter.post('/import', heavyLimiter, contacts.importFile)
contactRouter.post('/export', heavyLimiter, contacts.exportFile)
contactRouter.post('/bulk', contacts.bulk)

contactRouter.get('/', contacts.list)
contactRouter.post('/', idempotent(), contacts.create)

contactRouter.get('/:id', contacts.getById)
contactRouter.put('/:id', idempotent(), contacts.update)
contactRouter.delete('/:id', idempotent(), contacts.remove)
contactRouter.post('/:id/restore', contacts.restore)
contactRouter.post('/:id/merge', contacts.merge)

// Translates a ProviderError into the standard envelope before the global
// handler sees it — contact sync calls the same provider layer as Phase 5.
contactRouter.use(providerErrorBoundary)

// --- Contact groups --------------------------------------------------------

export const contactGroupRouter = Router()

contactGroupRouter.use(requireAuth)

contactGroupRouter.get('/', groups.list)
contactGroupRouter.post('/', groups.create)

contactGroupRouter.get('/:id', groups.getById)
contactGroupRouter.put('/:id', groups.update)
contactGroupRouter.delete('/:id', groups.remove)

contactGroupRouter.post('/:id/members', groups.addMembers)
contactGroupRouter.delete('/:id/members', groups.removeMembers)

export default contactRouter
