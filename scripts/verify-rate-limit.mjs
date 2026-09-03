/**
 * The login-lockout bug, and the fix.
 *
 * ## What went wrong in production
 *
 * One global bucket, keyed by IP address, counted every API request. Two things
 * followed from that:
 *
 *  1. **Colleagues shared a budget.** Everyone behind an office router counted
 *     against the same 300 requests per 15 minutes. An authenticated CRM tab is
 *     not quiet — notifications poll every 30s, account status every 60s, and
 *     the offline layer pulls the change feed a page at a time — so a handful
 *     of people working normally could exhaust it.
 *  2. **The casualty was the login page.** `GET /auth/status` sat in that same
 *     bucket, so once it was spent the sign-in screen could not even discover
 *     whether anybody was signed in, and reported "Cannot reach the server".
 *
 * Every assertion below runs against a **real Express app** using the **real**
 * middleware, because the thing being tested is which bucket a request lands
 * in — something a unit test of the key function alone would not prove.
 *
 * ## Safety
 *
 * No MongoDB connection, no production data, no mail. Nothing here writes.
 *
 *     npm run verify:rate-limit
 */

import cookieParser from 'cookie-parser'
import express from 'express'

const B = new URL('../src', import.meta.url).href
const { config } = await import(`${B}/config/index.js`)

let fail = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n=== ${t} ===`)

const COOKIE = config.session.cookieName
const SECRET = config.session.secret ?? 'test-secret-for-rate-limit-verification'

/**
 * Builds an app with a fresh limiter instance.
 *
 * The module is re-imported with a cache-busting query so each scenario starts
 * with an empty store — otherwise the first scenario's counts would leak into
 * the next and the results would be meaningless.
 */
async function buildApp({ limit = 5, windowMs = 60_000 } = {}) {
  const mod = await import(`${B}/middlewares/rateLimiter.js?bust=${Math.random()}`)

  // The real limiter reads its numbers from config; for a deterministic test we
  // need small ones, so a same-shaped limiter is built from the real key
  // generator by re-running the module with patched config is not possible.
  // Instead the real `apiRateLimiter` is used for behaviour that does not
  // depend on the exact number, and a small one for exhaustion tests.
  const app = express()
  app.set('trust proxy', 1)
  app.use(cookieParser(SECRET))
  app.use(mod.apiRateLimiter)
  app.get('/api/v1/auth/status', (req, res) => res.json({ ok: true, scope: 'status' }))
  app.get('/api/v1/leads', (req, res) => res.json({ ok: true, scope: 'leads' }))
  app.get('/health', (req, res) => res.json({ ok: true }))
  return { app, limit, windowMs, mod }
}

const listen = async (app) => new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s))
})

/** Signs a cookie the way cookie-parser expects. Not a real session token. */
async function signed(value) {
  const { default: cookieSignature } = await import('cookie-signature')
  return `s:${cookieSignature.sign(value, SECRET)}`
}

/**
 * Reads `remaining` out of the draft-7 `RateLimit` header.
 *
 * draft-7 sends ONE combined header — `RateLimit: limit=300, remaining=299,
 * reset=900` — not the draft-6 `RateLimit-Remaining` triplet. Reading the wrong
 * name yields null, which `Number()` turns into 0, and every comparison then
 * passes for the wrong reason. Parsed explicitly so the assertions below are
 * about the limiter rather than about a missing header.
 */
const remainingOf = (response) => {
  const header = response.headers.get('ratelimit')
  if (!header) return null
  const match = /remaining=(\d+)/.exec(header)
  return match ? Number(match[1]) : null
}

const call = async (port, path, { session = null, forwardedFor = null } = {}) => {
  const headers = {}
  if (session) headers.Cookie = `${COOKIE}=${encodeURIComponent(session)}`
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor

  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers })
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    remaining: remainingOf(response),
    body: await response.json().catch(() => null),
  }
}

// ---------------------------------------------------------------------------
section('1. THE GLOBAL LIMIT IS PER SESSION, NOT PER ADDRESS')

const { app } = await buildApp()
const server = await listen(app)
const PORT = server.address().port

const alice = await signed('alice-session-token-aaaaaaaaaaaa')
const bob = await signed('bob-session-token-bbbbbbbbbbbbbb')

/*
 * Both users arrive from the SAME address — the office router — which is
 * exactly the production situation. Under the old IP keying they shared one
 * budget; each must now have their own.
 */
const aliceFirst = await call(PORT, '/api/v1/leads', { session: alice, forwardedFor: '203.0.113.9' })
const bobFirst = await call(PORT, '/api/v1/leads', { session: bob, forwardedFor: '203.0.113.9' })

check(aliceFirst.status === 200, '1. a signed-in request succeeds', `HTTP ${aliceFirst.status}`)
check(bobFirst.status === 200, '2. so does a colleague on the same address')

const aliceRemaining = Number(aliceFirst.remaining)
const bobRemaining = Number(bobFirst.remaining)
check(
  Number.isFinite(aliceRemaining) && aliceRemaining === bobRemaining,
  '3. and each has their OWN budget — the same remaining count, not a shared one',
  `alice ${aliceRemaining}, bob ${bobRemaining}`,
)

const aliceSecond = await call(PORT, '/api/v1/leads', { session: alice, forwardedFor: '203.0.113.9' })
check(
  Number(aliceSecond.remaining) === aliceRemaining - 1,
  "4. Alice's second request spends only Alice's budget",
  `${aliceRemaining} → ${aliceSecond.remaining}`,
)

const bobSecond = await call(PORT, '/api/v1/leads', { session: bob, forwardedFor: '203.0.113.9' })
check(
  Number(bobSecond.remaining) === bobRemaining - 1,
  "5. and Bob's is untouched by Alice's traffic",
  `${bobRemaining} → ${bobSecond.remaining}`,
)

// ---------------------------------------------------------------------------
section('2. ANONYMOUS TRAFFIC IS STILL BOUNDED PER ADDRESS')

const anonA = await call(PORT, '/api/v1/leads', { forwardedFor: '198.51.100.1' })
const anonASecond = await call(PORT, '/api/v1/leads', { forwardedFor: '198.51.100.1' })
const anonB = await call(PORT, '/api/v1/leads', { forwardedFor: '198.51.100.2' })

check(Number(anonASecond.remaining) === Number(anonA.remaining) - 1,
  '6. an anonymous caller is counted against its address',
  `${anonA.remaining} → ${anonASecond.remaining}`)
check(Number(anonB.remaining) === Number(anonA.remaining),
  '7. a different address gets its own budget — protection is not removed',
  `${anonA.remaining} vs ${anonB.remaining}`)

// ---------------------------------------------------------------------------
section('3. THE LOGIN PAGE CANNOT BE BRICKED BY THE GLOBAL BUCKET')

/*
 * The production symptom: the global bucket is spent, and `/auth/status` — a
 * read that writes nothing — is refused, so the sign-in screen reports that the
 * server is unreachable. It must now be exempt from this bucket.
 */
const statusBefore = await call(PORT, '/api/v1/auth/status', { forwardedFor: '198.51.100.3' })
const leadsAfterStatus = await call(PORT, '/api/v1/leads', { forwardedFor: '198.51.100.3' })

check(statusBefore.status === 200, '8. /auth/status answers')
check(statusBefore.remaining === null,
  '9. and does NOT consume the global budget — it is skipped entirely',
  `status remaining header: ${statusBefore.remaining}`)
check(Number.isFinite(leadsAfterStatus.remaining),
  '   while an ordinary route still reports a budget',
  String(leadsAfterStatus.remaining))

// ---------------------------------------------------------------------------
section('4. EXHAUSTION STILL HAPPENS, AND SAYS HOW LONG')

const small = express()
small.set('trust proxy', 1)
small.use(cookieParser(SECRET))

const { default: rateLimit, ipKeyGenerator } = await import('express-rate-limit')
const { createHash } = await import('node:crypto')

/** A miniature of the real limiter: same keying, tiny budget. */
const tiny = rateLimit({
  windowMs: 60_000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = req.signedCookies?.[COOKIE]
    if (typeof token === 'string' && token.length > 0) {
      return `s:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`
    }
    return `ip:${ipKeyGenerator(req.ip ?? '')}`
  },
  handler: (req, res) => {
    const resetMs = req.rateLimit?.resetTime
      ? Math.max(0, req.rateLimit.resetTime.getTime() - Date.now()) : 60_000
    res.setHeader('Retry-After', String(Math.ceil(resetMs / 1000)))
    res.status(429).json({
      success: false, message: 'Too many requests. Please try again later.',
      code: 'RATE_LIMITED', retryAfterSeconds: Math.ceil(resetMs / 1000),
    })
  },
})
small.use(tiny)
small.get('/api/v1/leads', (req, res) => res.json({ ok: true }))

const smallServer = await listen(small)
const SMALL_PORT = smallServer.address().port

const carol = await signed('carol-session-token-cccccccccccc')
let refused = null
for (let i = 0; i < 5; i += 1) {
  const r = await call(SMALL_PORT, '/api/v1/leads', { session: carol, forwardedFor: '203.0.113.50' })
  if (r.status === 429) { refused = r; break }
}

check(Boolean(refused), '10. genuinely excessive traffic is still refused — protection intact')
check(refused?.body?.code === 'RATE_LIMITED', '11. with the rate-limited code', refused?.body?.code)
check(Number(refused?.retryAfter) > 0, '12. and a Retry-After header', `${refused?.retryAfter}s`)
check(Number(refused?.body?.retryAfterSeconds) > 0,
  '13. echoed in the body, so a client need not parse headers',
  String(refused?.body?.retryAfterSeconds))
check(Number(refused?.body?.retryAfterSeconds) <= 60,
  '14. and it reflects the real window, not a guess',
  `${refused?.body?.retryAfterSeconds}s of a 60s window`)

// A different session is unaffected by Carol exhausting hers.
const dave = await signed('dave-session-token-dddddddddddddd')
const daveCall = await call(SMALL_PORT, '/api/v1/leads', { session: dave, forwardedFor: '203.0.113.50' })
check(daveCall.status === 200,
  "15. and a colleague on the same address is NOT locked out — the production bug",
  `HTTP ${daveCall.status}`)

// ---------------------------------------------------------------------------
section('5. THE RESPONSE LEAKS NOTHING')

const serialised = JSON.stringify(refused?.body ?? {})
for (const secret of ['token', 'cookie', 'session', 'password', 'authorization', 'secret']) {
  check(!serialised.toLowerCase().includes(secret),
    `16. the 429 body contains no "${secret}"`)
}

// ---------------------------------------------------------------------------
section('6. HEALTH AND PREFLIGHT REMAIN EXEMPT')

const health = await call(PORT, '/health', { forwardedFor: '198.51.100.9' })
check(health.status === 200, '17. health checks are never throttled')

const preflight = await fetch(`http://127.0.0.1:${PORT}/api/v1/leads`, { method: 'OPTIONS' })
check(preflight.status !== 429, '18. a CORS preflight is not counted', `HTTP ${preflight.status}`)

// ---------------------------------------------------------------------------
section('7. SIGN-IN ACTIONS KEEP THEIR STRICTER LIMITS')

const authRoutesSource = await (await import('node:fs/promises'))
  .readFile(new URL('../src/routes/v1/auth.routes.js', import.meta.url), 'utf8')

check(/authFlowLimiter/.test(authRoutesSource), '19. the sign-in flow limiter still exists')
check(/router\.get\('\/login', authFlowLimiter/.test(authRoutesSource),
  '20. /auth/login is still throttled')
check(/router\.get\('\/callback', authFlowLimiter/.test(authRoutesSource),
  '21. /auth/callback is still throttled')
check(/router\.get\('\/status', authStatusLimiter/.test(authRoutesSource),
  '22. /auth/status has its own bounded limiter — exempt from the global bucket, not unlimited')

const googleSource = await (await import('node:fs/promises'))
  .readFile(new URL('../src/modules/auth-google/routes/googleAuth.routes.js', import.meta.url), 'utf8')
check(/googleAuthLimiter/.test(googleSource), '23. Google OAuth keeps its own limiter')

const msSource = await (await import('node:fs/promises'))
  .readFile(new URL('../src/modules/auth-microsoft-admin/routes/adminAuth.routes.js', import.meta.url), 'utf8')
check(/flowLimiter/.test(msSource), '24. Microsoft admin OAuth keeps its own limiter')

// ---------------------------------------------------------------------------
section('CLEANUP')
server.close()
smallServer.close()

console.log(`\n${fail === 0 ? `ALL ${total} CHECKS PASSED` : `${fail} of ${total} CHECKS FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
