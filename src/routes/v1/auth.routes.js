/**
 * Authentication routes.
 *
 * Mounted at `${API_PREFIX}/v1/auth`, so with the default prefix:
 *   GET  /api/v1/auth/login
 *   GET  /api/v1/auth/callback
 *   POST /api/v1/auth/logout
 *   GET  /api/v1/auth/profile
 *   GET  /api/v1/auth/status
 */

import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { callback, login, logout, profile, status } from '../../controllers/auth.controller.js'
import { loadSession, requireAuth } from '../../middlewares/authenticate.js'
import { ERROR_CODES } from '../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../constants/httpStatus.js'
import microsoftAdminRoutes from '../../modules/auth-microsoft-admin/routes/adminAuth.routes.js'
import googleAuthRoutes from '../../modules/auth-google/routes/googleAuth.routes.js'

const router = Router()

/**
 * Stricter limiter for the sign-in entry points.
 *
 * The global limiter (300 requests / 15 minutes) is far too permissive here.
 * `/login` creates a database record on every call, so an unthrottled caller
 * could flood the AuthFlow collection, and `/callback` is a natural target for
 * code-guessing attempts.
 */
const authFlowLimiter = rateLimit({
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

// --- Browser-navigation endpoints (respond with redirects) -----------------
//
// `loadSession` on `/login` is what lets it tell a signed-in caller — who is
// connecting a mailbox — apart from an anonymous one. It never rejects, so an
// anonymous sign-in attempt is unaffected.
router.get('/login', authFlowLimiter, loadSession, login)
router.get('/callback', authFlowLimiter, loadSession, callback)

/**
 * Phase 13.1 — Google sign-in.
 *
 * Mounted as a sub-router with its own handlers, models and rate limiter. The
 * two Microsoft routes above are unchanged and keep authorising mailboxes;
 * these authenticate CRM users. Registered on a distinct path prefix, so
 * neither can shadow the other.
 */
router.use('/google', googleAuthRoutes)

/**
 * Phase 14.8B — administrator sign-in with Microsoft.
 *
 * A sibling of `/google` rather than a replacement for the legacy
 * `/login` + `/callback` pair above. Those remain exactly as they were and
 * remain gated by `MICROSOFT_ALLOW_SIGN_IN`; this flow cannot create a CRM user
 * and so is not subject to the Phase 13.2 defect that flag exists to prevent.
 */
router.use('/microsoft/admin', microsoftAdminRoutes)

// --- JSON endpoints -------------------------------------------------------

// `loadSession` rather than `requireAuth`: reporting "not signed in" is a
// successful response that the web client needs on first load.
router.get('/status', loadSession, status)

// Idempotent by design, so an already-anonymous caller still gets a 200.
router.post('/logout', loadSession, logout)

router.get('/profile', requireAuth, profile)

export default router
