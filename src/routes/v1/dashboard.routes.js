/**
 * Dashboard routes.
 *
 * Mounted at `${API_PREFIX}/v1/dashboard`.
 */

import { Router } from 'express'

import { getDashboard } from '../../controllers/dashboard.controller.js'
import { requireAuth } from '../../middlewares/authenticate.js'

const router = Router()

/**
 * GET /api/v1/dashboard
 *
 * `requireAuth` is applied at the router level rather than per route, so a route
 * added later cannot be left unprotected by omission.
 */
router.use(requireAuth)

router.get('/', getDashboard)

export default router
