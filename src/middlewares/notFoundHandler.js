/**
 * Catch-all for unmatched routes.
 *
 * Registered after every route, so reaching it means nothing matched. It
 * converts the miss into an `ApiError` and delegates to the error handler,
 * which keeps 404 responses in the same envelope as every other failure.
 *
 * Express 5 note: this is mounted with `app.use(notFoundHandler)` and no path
 * string. Express 5 replaced the path-to-regexp wildcard syntax, so the old
 * `app.all('*', …)` idiom now throws; a path-less `use` is both simpler and
 * version-proof.
 */

import { ERROR_CODES } from '../constants/errorCodes.js'
import { HTTP_STATUS } from '../constants/httpStatus.js'
import { ApiError } from '../utils/ApiError.js'

/** @type {import('express').RequestHandler} */
export function notFoundHandler(req, _res, next) {
  next(
    new ApiError(HTTP_STATUS.NOT_FOUND, `Route not found: ${req.method} ${req.originalUrl}`, {
      code: ERROR_CODES.ROUTE_NOT_FOUND,
    }),
  )
}

export default notFoundHandler
