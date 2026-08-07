/**
 * Health controller.
 *
 * Controllers stay thin: translate HTTP in, delegate to a service, translate
 * HTTP out. No business logic lives here.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js'
import { buildHealthReport } from '../services/health.service.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { sendSuccess } from '../utils/ApiResponse.js'

/**
 * GET /api/v1/health
 *
 * Returns 200 when every critical dependency is up, and 503 when one is not, so
 * load balancers and uptime monitors can act on the status code alone without
 * parsing the body.
 */
export const getHealth = asyncHandler(async (req, res) => {
  const { healthy, report } = buildHealthReport()

  return sendSuccess(res, {
    statusCode: healthy ? HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE,
    message: healthy ? 'Service is healthy.' : 'Service is degraded.',
    data: report,
  })
})

export default { getHealth }
