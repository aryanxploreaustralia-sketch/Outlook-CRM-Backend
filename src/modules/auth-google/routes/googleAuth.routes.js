/**
 * Google sign-in routes.
 *
 * Mounted by the existing auth router at `${API_PREFIX}/v1/auth/google`:
 *
 *   GET /api/v1/auth/google           → redirect to Google
 *   GET /api/v1/auth/google/callback  → redeem, verify, open a session
 *
 * ## Why these sit under `/auth` rather than beside it
 *
 * They produce the same outcome the Microsoft routes do — an application
 * session — so they belong in the same namespace. What they deliberately do
 * **not** do is share any handler, model or service with them. `/auth/login`
 * and `/auth/callback` are untouched by this phase and continue to authorise a
 * mailbox; these two authenticate a person. Two neighbouring paths, two
 * independent implementations.
 *
 * Both are public by design: a caller who could already authenticate would have
 * no reason to sign in.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import * as controller from '../controllers/googleAuth.controller.js'

/**
 * Its own limiter, matching the Microsoft flow's budget.
 *
 * A separate instance rather than a shared one: the two providers should not be
 * able to exhaust each other's allowance, or a burst of failed Google attempts
 * would lock out Microsoft sign-in and vice versa. `/google` writes a database
 * row per call and `/google/callback` is a natural target for state-guessing,
 * so both need a ceiling well below the global 300/15min.
 */
const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

const router = Router()

router.get('/', googleAuthLimiter, controller.start)
router.get('/callback', googleAuthLimiter, controller.callback)

export default router
