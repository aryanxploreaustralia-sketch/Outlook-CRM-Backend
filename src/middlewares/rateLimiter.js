/**
 * Request rate limiting.
 *
 * Uses the default in-memory store, which is correct for a single process. When
 * the API is scaled to multiple instances this must be swapped for the Redis
 * store so the limit is shared — Redis is already planned for BullMQ, so the
 * dependency will be available.
 */

import rateLimit from 'express-rate-limit'

import { ERROR_CODES } from '../constants/errorCodes.js'
import { HTTP_STATUS } from '../constants/httpStatus.js'
import { config } from '../config/index.js'
import { createContextLogger } from '../utils/logger.js'

const log = createContextLogger('rate-limit')

export const apiRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,

  // Return the modern `RateLimit-*` headers, not the legacy `X-RateLimit-*`.
  standardHeaders: 'draft-7',
  legacyHeaders: false,

  // Health checks must never be throttled, or a monitoring probe could trip the
  // limiter and make a healthy service look down.
  skip: (req) => req.path.endsWith('/health'),

  handler: (req, res) => {
    log.warn('Rate limit exceeded', { requestId: req.id, ip: req.ip, url: req.originalUrl })

    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many requests. Please try again later.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    })
  },
})

export default apiRateLimiter
