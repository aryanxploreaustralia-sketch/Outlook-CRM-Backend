/**
 * HTTP status codes used across the API.
 *
 * Named constants keep call sites self-documenting: `HTTP_STATUS.CONFLICT`
 * states intent in a way that a bare `409` does not.
 */

export const HTTP_STATUS = Object.freeze({
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,

  // 302 is used for OAuth redirects: the browser must issue a fresh GET to the
  // new location, which 307/308 would forbid by preserving the original method.
  FOUND: 302,
  SEE_OTHER: 303,
  NOT_MODIFIED: 304,

  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,

  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
})

export default HTTP_STATUS
