/**
 * Offline sync routes.
 *
 * Mounted at `${API_PREFIX}/v1/sync`.
 *
 * Additive: no existing route is touched, and nothing outside this module
 * imports it. Removing the one `router.use` line in `routes/v1/index.js`
 * removes the feature.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { requireAuth } from '../../../middlewares/authenticate.js'
import { requirePermission } from '../../../middlewares/authorise.js'
import { PERMISSIONS } from '../../../constants/permissions.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import * as controller from '../controllers/sync.controller.js'

const router = Router()

/**
 * Authentication first, for every route in this module.
 *
 * At the router level rather than per route, so a route added later cannot be
 * left open by omission — the same discipline `dashboard.routes.js` follows.
 */
router.use(requireAuth)

/**
 * A limiter of its own.
 *
 * A syncing client polls, and a first sync of two thousand leads is eight
 * consecutive requests — traffic the global limiter was not sized for. Sixty
 * requests a minute is comfortably above a well-behaved client (which pauses
 * between pages) and far below a loop that has lost its cursor.
 *
 * Keyed on the user rather than the IP: an office behind one address is many
 * clients, and rate-limiting them collectively would punish the largest team.
 *
 * There is no IP fallback, and none is needed — `requireAuth` runs above this,
 * so an unauthenticated request is already refused and `req.auth.user` is
 * always present here. A fallback would also have to be IPv6-aware to satisfy
 * `express-rate-limit`, which is real complexity for a branch that cannot run.
 */
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.auth.user._id),
  message: {
    success: false,
    message: 'Too many synchronisation requests. Please wait a moment.',
    code: ERROR_CODES.RATE_LIMITED,
  },
  statusCode: HTTP_STATUS.TOO_MANY_REQUESTS,
})

router.use(syncLimiter)

/**
 * GET /api/v1/sync/changes
 *
 * Guarded by `leads.view`, the permission the register itself requires. The
 * feed returns exactly what `GET /leads` would return for this user, so it
 * cannot be reached by anyone who could not already read it a page at a time.
 *
 * Contacts and companies ride the same permission deliberately: this endpoint
 * is one transaction from the client's point of view, and splitting it into
 * three differently-guarded calls would let a partial permission produce a
 * partial cache the client could not reason about.
 */
router.get('/changes', requirePermission(PERMISSIONS.LEADS_VIEW), controller.getChanges)

/** GET /api/v1/sync/status — is anything waiting, without transferring it. */
router.get('/status', requirePermission(PERMISSIONS.LEADS_VIEW), controller.getStatus)

export default router
