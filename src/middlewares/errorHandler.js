/**
 * Central error handler — the single exit point for every failure in the API.
 *
 * Responsibilities, in order:
 *  1. translate known third-party error shapes into a normalised `ApiError`;
 *  2. log the failure once, with the request correlation id attached;
 *  3. emit the standard failure envelope, withholding internals in production.
 *
 * Express identifies error middleware by its four-parameter signature, so all
 * four parameters must be declared.
 */

import mongoose from 'mongoose'
import { ZodError } from 'zod'

import { ERROR_CODES } from '../constants/errorCodes.js'
import { HTTP_STATUS } from '../constants/httpStatus.js'
import { config } from '../config/index.js'
import { ApiError } from '../utils/ApiError.js'
import { createContextLogger } from '../utils/logger.js'

const log = createContextLogger('error')

/**
 * Converts a raw error into an `ApiError`.
 *
 * Anything not recognised becomes a non-operational 500, which is the safe
 * default: unknown errors are treated as bugs and their messages are hidden.
 *
 * @param {unknown} error
 * @returns {ApiError}
 */
function normaliseError(error) {
  if (error instanceof ApiError) return error

  // --- Zod (request/config validation) -------------------------------------
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    }))
    return ApiError.validation('The submitted data failed validation.', details)
  }

  // --- Mongoose schema validation ------------------------------------------
  if (error instanceof mongoose.Error.ValidationError) {
    const details = Object.values(error.errors).map((fieldError) => ({
      field: fieldError.path,
      message: fieldError.message,
    }))
    return ApiError.validation('The submitted data failed validation.', details)
  }

  // --- Mongoose cast failure (e.g. malformed ObjectId) ---------------------
  if (error instanceof mongoose.Error.CastError) {
    return ApiError.badRequest(`Invalid value for "${error.path}".`, {
      details: [{ field: error.path, message: `Expected a valid ${error.kind}.` }],
    })
  }

  // --- MongoDB duplicate key ------------------------------------------------
  if (error?.code === 11000) {
    const fields = Object.keys(error.keyValue ?? {})
    const label = fields.length ? fields.join(', ') : 'field'
    return new ApiError(HTTP_STATUS.CONFLICT, `A record with this ${label} already exists.`, {
      code: ERROR_CODES.DUPLICATE_KEY,
      details: error.keyValue ?? null,
    })
  }

  // --- Malformed JSON body (raised by express.json) ------------------------
  if (error?.type === 'entity.parse.failed') {
    return ApiError.badRequest('The request body is not valid JSON.', {
      code: ERROR_CODES.MALFORMED_JSON,
    })
  }

  // --- Body larger than the configured limit -------------------------------
  if (error?.type === 'entity.too.large') {
    // The mail routes run a larger parser than the rest of the API, so the limit
    // quoted here has to match the one that actually rejected this request —
    // otherwise the message tells the user to get under a limit they already were.
    const limit = error.limit
      ? `${Math.round(error.limit / 1024)}kb`
      : config.server.bodyLimit

    return new ApiError(
      HTTP_STATUS.PAYLOAD_TOO_LARGE,
      `The request body exceeds the ${limit} limit.`,
      { code: ERROR_CODES.PAYLOAD_TOO_LARGE },
    )
  }

  // --- Rejected by the CORS policy -----------------------------------------
  if (error?.code === ERROR_CODES.CORS_REJECTED) {
    return ApiError.forbidden(error.message, { code: ERROR_CODES.CORS_REJECTED })
  }

  // --- Anything else is treated as a bug -----------------------------------
  const fallback = ApiError.internal(error?.message ?? 'An unexpected error occurred.', {
    cause: error instanceof Error ? error : undefined,
  })
  fallback.isOperational = false
  if (error instanceof Error) fallback.stack = error.stack
  return fallback
}

/** @type {import('express').ErrorRequestHandler} */
export function errorHandler(error, req, res, next) {
  const apiError = normaliseError(error)

  const logPayload = {
    requestId: req.id ?? null,
    method: req.method,
    url: req.originalUrl,
    statusCode: apiError.statusCode,
    code: apiError.code,
    isOperational: apiError.isOperational,
  }

  // Server-side faults and genuine bugs warrant a stack trace; a client sending
  // bad input does not, or the logs fill with noise nobody can act on.
  if (apiError.statusCode >= HTTP_STATUS.INTERNAL_SERVER_ERROR || !apiError.isOperational) {
    log.error(apiError.message, { ...logPayload, stack: apiError.stack })
  } else {
    log.warn(apiError.message, logPayload)
  }

  // A non-operational error in production may carry internal detail in its
  // message (file paths, driver internals), so it is replaced wholesale.
  const exposeMessage = apiError.isOperational || !config.app.isProduction
  const message = exposeMessage ? apiError.message : 'An unexpected error occurred.'

  const body = {
    success: false,
    message,
    code: apiError.code,
    timestamp: new Date().toISOString(),
    requestId: req.id ?? null,
  }

  if (apiError.details) body.errors = apiError.details

  // Stack traces are a debugging aid, never a production response.
  if (!config.app.isProduction && apiError.stack) {
    body.stack = apiError.stack.split('\n').map((line) => line.trim())
  }

  // If headers were already flushed (e.g. a stream failed mid-response), the
  // only correct action is to hand off to Express, which destroys the socket.
  if (res.headersSent) {
    next(error)
    return
  }

  res.status(apiError.statusCode).json(body)
}

export default errorHandler
