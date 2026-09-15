/**
 * Health controller.
 *
 * HTTP adapter only: translates the health report into a status code and a
 * response body. All decision-making lives in the health service.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js'
import { buildHealthReport } from '../services/health.service.js'
import { asyncHandler } from '../utils/asyncHandler.js'

/**
 * GET /api/v1/health
 *
 * Public liveness probe for uptime monitoring.
 *
 * 200 `{ "status": "ok" }` when healthy, 503 `{ "status": "degraded" }` when a
 * critical dependency is down. The body is deliberately bare — no envelope, no
 * timestamp, nothing about the infrastructure. Detailed diagnostics are served
 * to administrators by `GET /api/v1/admin/system-health`.
 */
export const getHealth = asyncHandler(async (req, res) => {
  const { healthy, report } = buildHealthReport()

  return res.status(healthy ? HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE).json(report)
})

export default { getHealth }
