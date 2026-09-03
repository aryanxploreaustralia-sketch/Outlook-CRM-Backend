/**
 * Request rate limiting.
 *
 * Uses the default in-memory store, which is correct for a single process. When
 * the API is scaled to multiple instances this must be swapped for the Redis
 * store so the limit is shared — Redis is already planned for BullMQ, so the
 * dependency will be available.
 *
 * ## Why the key is the session, not the address
 *
 * Keying purely on `req.ip` had two failure modes, and production hit both.
 *
 * **An office shares one address.** Every consultant behind the same router
 * counted against a single 300-request budget. The CRM is not a lightly-used
 * site: one authenticated tab polls notifications every 30s and account status
 * every 60s, and the offline layer pulls the change feed a page at a time. A
 * handful of colleagues working normally could exhaust a shared bucket without
 * anyone doing anything unusual — and the request that then got refused was
 * often `GET /auth/status` on somebody's login page, which made the CRM look
 * completely down.
 *
 * **The proxy hop count is a guess.** `trust proxy` is set to 1 in `app.js`. If
 * the deployment ever puts two proxies in front of Node, `req.ip` resolves to
 * the *inner proxy's* address — identical for every visitor — and the entire
 * deployment collapses into one bucket. Keying on the session removes that
 * whole class of failure rather than betting on the topology being right.
 *
 * So: a request carrying a session cookie is counted against **that session**;
 * anything else falls back to the address. Signed-in users get an independent
 * budget each, and anonymous traffic is still bounded per address, which is
 * what actually protects the sign-in surface.
 *
 * The cookie value is a session token, so it is **hashed** before it is used as
 * a key. The key never leaves this process, but a raw token sitting in a store
 * — or in a log line describing the store — is a credential in a place it has
 * no reason to be.
 */

import { createHash } from 'node:crypto'

import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

import { ERROR_CODES } from '../constants/errorCodes.js'
import { HTTP_STATUS } from '../constants/httpStatus.js'
import { config } from '../config/index.js'
import { createContextLogger } from '../utils/logger.js'

const log = createContextLogger('rate-limit')

/**
 * Routes that must never be refused by the *global* bucket.
 *
 * `GET /auth/status` is how the application discovers whether anybody is signed
 * in. It reads a session and writes nothing. Refusing it does not protect
 * anything — it just renders the login page unusable and reports "Cannot reach
 * the server", which is precisely the production symptom this file addresses.
 *
 * It is not left unprotected: `authStatusLimiter` below gives it a bucket of
 * its own, generous enough for real navigation and still bounded.
 *
 * The sign-in *actions* — `/auth/login`, `/auth/callback`, the Google and
 * Microsoft flows — keep their own much stricter limiters, which is where
 * brute-force protection actually belongs.
 */
const GLOBAL_EXEMPT = [
  '/v1/auth/status',
  '/health',
]

const isExempt = (req) => GLOBAL_EXEMPT.some((path) => req.path.endsWith(path))

/**
 * The bucket a request counts against.
 *
 * @returns {string} `s:<hash>` for a session, or the normalised address.
 */
function keyFor(req) {
  const token = req.signedCookies?.[config.session.cookieName]

  if (typeof token === 'string' && token.length > 0) {
    // Truncated: 160 bits is far beyond what a bucket key needs, and a shorter
    // key keeps the store small. Collisions here cost a shared budget, not
    // access to anything.
    return `s:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`
  }

  /*
   * `ipKeyGenerator` rather than `req.ip` directly: it normalises IPv6 to a
   * /56 subnet, so a single visitor cannot walk through the enormous address
   * space a v6 allocation gives them and get a fresh budget per request.
   */
  return `ip:${ipKeyGenerator(req.ip ?? '')}`
}

/** Shared 429 body, so every limiter answers in the same shape. */
function refuse(req, res, message) {
  /*
   * `Retry-After` is what lets the client say "try again in 4 minutes" instead
   * of guessing. express-rate-limit sets it, and it is stated here so the value
   * the client reads is never absent.
   */
  const resetMs = req.rateLimit?.resetTime
    ? Math.max(0, req.rateLimit.resetTime.getTime() - Date.now())
    : config.rateLimit.windowMs

  const retryAfterSeconds = Math.ceil(resetMs / 1000)
  res.setHeader('Retry-After', String(retryAfterSeconds))

  /*
   * Logged with the *kind* of key, never the key itself — a session hash is
   * still a session identifier. `forwardedHops` is the diagnostic that shows
   * whether `trust proxy` matches the real topology: if addresses are being
   * used as keys and this is consistently greater than 1, `req.ip` is resolving
   * to a proxy and the trust setting needs revisiting.
   */
  log.warn('Rate limit exceeded', {
    requestId: req.id,
    method: req.method,
    url: req.originalUrl,
    keyKind: req.signedCookies?.[config.session.cookieName] ? 'session' : 'address',
    forwardedHops: (req.get('x-forwarded-for') ?? '').split(',').filter(Boolean).length,
    limit: req.rateLimit?.limit ?? null,
    retryAfterSeconds,
  })

  res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
    success: false,
    message,
    code: ERROR_CODES.RATE_LIMITED,
    retryAfterSeconds,
    timestamp: new Date().toISOString(),
    requestId: req.id ?? null,
  })
}

export const apiRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,

  // Return the modern `RateLimit-*` headers, not the legacy `X-RateLimit-*`.
  standardHeaders: 'draft-7',
  legacyHeaders: false,

  keyGenerator: keyFor,

  // Health checks must never be throttled, or a monitoring probe could trip the
  // limiter and make a healthy service look down.
  //
  // CORS preflights are exempt for a related reason. When the browser app and
  // the API are on different origins — which is the deployed arrangement, since
  // the two sit on separate subdomains — the browser sends an OPTIONS request
  // ahead of most calls. Counting those halves the effective limit for every
  // user, and the request that gets rejected is the preflight, so the browser
  // reports a CORS failure rather than a 429 and the cause is invisible.
  // A preflight is answered from headers alone and touches no route.
  skip: (req) => req.method === 'OPTIONS' || isExempt(req),

  handler: (req, res) => refuse(req, res, 'Too many requests. Please try again later.'),
})

/**
 * The session-status endpoint's own bucket.
 *
 * Deliberately generous, because this is a read that the application performs
 * on load and after every sign-in or sign-out, and because refusing it breaks
 * the login page rather than protecting anything. Still bounded, so it cannot
 * be used as an unmetered endpoint.
 *
 * Keyed the same way as the global limiter, so an office does not share it.
 */
export const authStatusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: keyFor,
  skip: (req) => req.method === 'OPTIONS',
  handler: (req, res) =>
    refuse(req, res, 'Too many session checks. Please wait a moment and reload.'),
})

export default apiRateLimiter
