/**
 * Administrator sign-in routes.
 *
 * Mounted at `${API_PREFIX}/v1/auth/microsoft/admin`.
 *
 * Unauthenticated by necessity — these are how somebody becomes authenticated.
 * The protection is the flow itself: `state` is generated server-side, stored
 * before the redirect, consumed atomically, and checked for the right purpose,
 * so a callback can only succeed for a flow this server started.
 *
 * Rate-limited on the same reasoning as the Google routes: an unauthenticated
 * endpoint that performs a token exchange is one an attacker can make this
 * server do work for.
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { adminCallback, adminLogin } from '../controllers/adminAuth.controller.js'

const router = Router()

const flowLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many sign-in attempts. Please wait a few minutes.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

/** Starts the flow. Redirects to Microsoft. */
router.get('/login', flowLimiter, adminLogin)

/** Where Microsoft returns. Creates a session only for an administrator. */
router.get('/callback', flowLimiter, adminCallback)

export default router
