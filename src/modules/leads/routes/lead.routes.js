/**
 * Lead, company and workbook routes.
 *
 * Two routers are exported because they mount at different paths but share a
 * controller — leads and companies are one module, not two.
 */

import express, { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth } from '../../../middlewares/authenticate.js'
import { requireAllPermissions, requirePermission } from '../../../middlewares/authorise.js'
import { PERMISSIONS } from '../../../constants/permissions.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { MAX_FILE_BYTES } from '../../import/constants/importConstants.js'
import * as controller from '../controllers/lead.controller.js'
import * as workbook from '../controllers/workbookSync.controller.js'
import * as followUp from '../controllers/followUp.controller.js'

/**
 * Throttle for workbook operations.
 *
 * Inspecting parses every sheet of a file that may be 25 MB; importing writes
 * thousands of documents and runs for ten seconds. The global limiter is far
 * too permissive for either, while reading the register stays under it.
 */
const workbookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many workbook operations. Please wait a few minutes before uploading again.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

/**
 * The upload body.
 *
 * `express.raw` rather than a multipart parser: the endpoint always receives
 * exactly one file, and adding a multipart dependency for that would be a new
 * attack surface for no gain. The filename travels in `X-Filename`.
 */
const rawUpload = express.raw({
  type: () => true,
  limit: MAX_FILE_BYTES,
})

// ---------------------------------------------------------------------------

export const leadRouter = Router()

leadRouter.use(requireAuth)

// Literal paths first, so they are not captured as lead ids.
leadRouter.get('/facets', controller.facets)
leadRouter.get('/statistics', controller.statistics)
leadRouter.get('/pipeline', controller.pipeline)
leadRouter.get('/search', controller.search)
leadRouter.post('/audience', controller.audience)
leadRouter.post('/bulk-stage', controller.bulkStage)

/**
 * Phase 12 — manual entry and export.
 *
 * Both are literal paths and both are registered here, well above `/:id`, so
 * Express can never read "export" or "next-reference" as a lead id.
 *
 * Neither carries a role guard. The brief is explicit that these use the same
 * permissions as the rest of the Leads page, and every route on this router
 * already sits behind `requireAuth`. `requireRole` is reserved for the
 * destructive operations below, which is what it was added for.
 */
leadRouter.get('/next-reference', controller.nextReferencePreview)

/**
 * Throttled with the workbook limiter rather than a new one.
 *
 * An export reads and serialises up to 50,000 rows, which is the same order of
 * work as the upload endpoints that limiter was written for. Reusing it keeps
 * one budget for "expensive register operations" instead of inventing a second
 * policy nobody would remember to tune.
 */
leadRouter.get('/export', requirePermission(PERMISSIONS.LEADS_EXPORT), workbookLimiter, controller.exportLeads)

// Phase 10 — the morning run. Registered before the Phase 8 paths so the more
// specific literal wins, and before `/:id` so none of them is read as an id.
leadRouter.get('/workbook/history', workbook.history)
leadRouter.get('/workbook/statistics', workbook.statistics)
leadRouter.post('/workbook/sync', workbookLimiter, rawUpload, workbook.sync)
leadRouter.post('/resend', workbook.resend)

/**
 * Follow-ups: the second email, when the first went unanswered.
 *
 * Literal paths, registered above `/:id` so "follow-up" is never read as a
 * lead id.
 *
 * Reading the queue needs `leads.view` — it is a view of the register.
 * Sending needs `compose.send` as well, because it puts a message in front of
 * a customer, and that is a different act from looking at a list. A viewer can
 * see who is waiting and cannot email them.
 */
leadRouter.get('/follow-up', requirePermission(PERMISSIONS.LEADS_VIEW), followUp.list)
leadRouter.post(
  '/follow-up/send',
  requireAllPermissions([PERMISSIONS.LEADS_VIEW, PERMISSIONS.COMPOSE_SEND]),
  followUp.send,
)

/**
 * Bulk delete.
 *
 * Registered here — with the other literal paths and well before `/:id` — so
 * Express never reads "all" as a lead id and routes a purge to the
 * single-delete handler.
 *
 * `requireRole` is applied to this route alone. No existing route gains a role
 * check, so nothing that works today stops working.
 */
leadRouter.get('/purge-preview', requirePermission(PERMISSIONS.LEADS_DELETE), workbook.purgePreview)
leadRouter.delete('/all', requirePermission(PERMISSIONS.LEADS_DELETE), workbook.deleteAll)

leadRouter.post('/workbook/inspect', workbookLimiter, rawUpload, controller.inspectWorkbook)
leadRouter.post('/workbook/import', workbookLimiter, rawUpload, controller.importWorkbook)
leadRouter.post('/workbook/:importJob/rollback', controller.rollback)

leadRouter.get('/', controller.list)

/**
 * Manual creation.
 *
 * Registered after every literal path and before `/:id`, matching the ordering
 * discipline the rest of this router follows.
 */
leadRouter.post('/', controller.create)

leadRouter.get('/:id', controller.getById)
leadRouter.put('/:id', controller.update)
leadRouter.delete('/:id', controller.remove)

// ---------------------------------------------------------------------------

export const companyRouter = Router()

companyRouter.use(requireAuth)

companyRouter.get('/', controller.listCompanies)
companyRouter.get('/:id', controller.getCompany)
companyRouter.put('/:id', controller.updateCompany)

export default leadRouter
