/**
 * Operational API error.
 *
 * The `isOperational` flag is the important part. It separates two very
 * different kinds of failure:
 *
 *  - operational   — expected and anticipated (invalid input, missing record,
 *                    rate limit). Its message is written for a client and is
 *                    safe to return verbatim.
 *  - programmer    — a bug (undefined reference, bad type). Its message may
 *                    leak internals, so the error handler replaces it with a
 *                    generic one in production.
 *
 * Static factories are provided for the common cases so controllers read as
 * `throw ApiError.notFound('Contact not found')`.
 */

import { ERROR_CODES } from '../constants/errorCodes.js'
import { HTTP_STATUS } from '../constants/httpStatus.js'

export class ApiError extends Error {
  /**
   * @param {number}  statusCode HTTP status to respond with.
   * @param {string}  message    Client-facing description.
   * @param {object}  [options]
   * @param {string}  [options.code]    Machine-readable code from ERROR_CODES.
   * @param {?object} [options.details] Field-level detail, e.g. validation errors.
   * @param {Error}   [options.cause]   Underlying error, preserved for logging.
   */
  constructor(statusCode, message, options = {}) {
    super(message, { cause: options.cause })

    this.name = 'ApiError'
    this.statusCode = statusCode
    this.code = options.code ?? ERROR_CODES.INTERNAL_ERROR
    this.details = options.details ?? null
    this.isOperational = true

    // Omit this constructor from the stack so the trace points at the throw site.
    Error.captureStackTrace(this, ApiError)
  }

  static badRequest(message = 'Bad request.', options = {}) {
    return new ApiError(HTTP_STATUS.BAD_REQUEST, message, {
      code: ERROR_CODES.BAD_REQUEST,
      ...options,
    })
  }

  static validation(message = 'Validation failed.', details = null) {
    return new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, message, {
      code: ERROR_CODES.VALIDATION_ERROR,
      details,
    })
  }

  static unauthorized(message = 'Authentication is required.', options = {}) {
    return new ApiError(HTTP_STATUS.UNAUTHORIZED, message, {
      code: ERROR_CODES.UNAUTHORIZED,
      ...options,
    })
  }

  static forbidden(message = 'You do not have access to this resource.', options = {}) {
    return new ApiError(HTTP_STATUS.FORBIDDEN, message, {
      code: ERROR_CODES.FORBIDDEN,
      ...options,
    })
  }

  static notFound(message = 'Resource not found.', options = {}) {
    return new ApiError(HTTP_STATUS.NOT_FOUND, message, {
      code: ERROR_CODES.NOT_FOUND,
      ...options,
    })
  }

  static conflict(message = 'The resource already exists.', options = {}) {
    return new ApiError(HTTP_STATUS.CONFLICT, message, {
      code: ERROR_CODES.CONFLICT,
      ...options,
    })
  }

  static tooManyRequests(message = 'Too many requests. Please slow down.', options = {}) {
    return new ApiError(HTTP_STATUS.TOO_MANY_REQUESTS, message, {
      code: ERROR_CODES.RATE_LIMITED,
      ...options,
    })
  }

  static serviceUnavailable(message = 'Service temporarily unavailable.', options = {}) {
    return new ApiError(HTTP_STATUS.SERVICE_UNAVAILABLE, message, {
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      ...options,
    })
  }

  static internal(message = 'An unexpected error occurred.', options = {}) {
    return new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, message, {
      code: ERROR_CODES.INTERNAL_ERROR,
      ...options,
    })
  }
}

export default ApiError
