/**
 * Stable, machine-readable error codes.
 *
 * HTTP status alone is too coarse for a client to branch on: several distinct
 * failures all return 400. These codes are part of the API contract and must
 * not be renamed once published — clients match on them.
 */

export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  MALFORMED_JSON: 'MALFORMED_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',

  NOT_FOUND: 'NOT_FOUND',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  DUPLICATE_KEY: 'DUPLICATE_KEY',

  RATE_LIMITED: 'RATE_LIMITED',
  CORS_REJECTED: 'CORS_REJECTED',

  DATABASE_ERROR: 'DATABASE_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
})

export default ERROR_CODES
