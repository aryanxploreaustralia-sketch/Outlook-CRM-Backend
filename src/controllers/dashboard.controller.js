/**
 * Dashboard controller.
 *
 * Thin by design: translate HTTP in, delegate to a service, translate HTTP out.
 */

import { buildDashboard } from '../services/dashboard.service.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { sendSuccess } from '../utils/ApiResponse.js'

/**
 * GET /api/v1/dashboard
 *
 * Everything the dashboard needs in one response: the authenticated user, the
 * Microsoft connection state, and server health.
 *
 * Requires authentication — enforced by `requireAuth` on the route.
 */
export const getDashboard = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Dashboard loaded successfully.',
    data: await buildDashboard(req.auth),
  }),
)

export default { getDashboard }
