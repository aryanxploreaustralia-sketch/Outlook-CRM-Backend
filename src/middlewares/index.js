/**
 * Middleware barrel.
 *
 * Gives `app.js` one import site for the whole middleware layer and keeps the
 * individual file paths an internal detail.
 */

export {
  loadSession,
  requireAuth,
  requireMailbox,
  requireOutlookConnection,
} from './authenticate.js'
export { errorHandler } from './errorHandler.js'
export { httpLogger } from './httpLogger.js'
export { notFoundHandler } from './notFoundHandler.js'
export { apiRateLimiter, authStatusLimiter } from './rateLimiter.js'
export { requestContext } from './requestContext.js'
