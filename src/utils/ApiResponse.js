/**
 * Standard success envelope.
 *
 * Every successful response shares one shape, so clients parse results with a
 * single code path rather than guessing per endpoint:
 *
 *   {
 *     "success": true,
 *     "message": "Service is healthy.",
 *     "data": { ... },
 *     "meta": { "page": 1 },        // optional, omitted when absent
 *     "timestamp": "2026-07-30T…"
 *   }
 *
 * The failure envelope is produced by the error handler and mirrors this shape
 * with `success: false` plus `code`.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js'

/**
 * Writes a standard success response.
 *
 * @param {import('express').Response} res
 * @param {object}  [options]
 * @param {number}  [options.statusCode] Defaults to 200.
 * @param {string}  [options.message]    Short human-readable summary.
 * @param {*}       [options.data]       The payload.
 * @param {?object} [options.meta]       Pagination or other envelope metadata.
 */
export function sendSuccess(res, options = {}) {
  const {
    statusCode = HTTP_STATUS.OK,
    message = 'Request completed successfully.',
    data = null,
    meta = null,
  } = options

  const body = {
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
  }

  if (meta) body.meta = meta

  return res.status(statusCode).json(body)
}

export default { sendSuccess }
