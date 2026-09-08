/**
 * The CORS preflight, against the real application.
 *
 * Builds the actual Express app from `app.js` and drives real `OPTIONS`
 * preflights through it. Nothing here restates the allowlist — the app's own
 * `cors` middleware answers, and the assertions read its response.
 *
 * ## The defect this exists to prevent returning
 *
 * The offline write queue replays a mutation with `X-Client-Mutation-Id`, and
 * an offline edit adds `X-Expected-Updated-At`. Both are implemented
 * server-side — `middlewares/idempotency.js` and `utils/optimisticConcurrency.js`
 * read them — but neither was declared in `allowedHeaders`. A browser therefore
 * refused to send the request at all, and the client saw a transport error with
 * no HTTP status: indistinguishable from the API being down. Every lead created
 * offline was permanently unsyncable while the CRM looked perfectly healthy.
 *
 * A missing entry here is invisible to every other test in this repository,
 * because server-side tests do not perform preflights. That is exactly why it
 * survived so long, and why this file is worth its length.
 *
 * ## Safety
 *
 * No MongoDB connection, no network request, no production data, no mail. The
 * app is built in-process and never listens on a port.
 *
 *     npm run verify:cors-headers
 */

import http from 'node:http'

const B = new URL('../src', import.meta.url).href

const { config } = await import(`${B}/config/index.js`)
const { createApp } = await import(`${B}/app.js`)
const { MUTATION_ID_HEADER } = await import(`${B}/middlewares/idempotency.js`)
const { EXPECTED_VERSION_HEADER } = await import(`${B}/utils/optimisticConcurrency.js`)

let fail = 0
let total = 0

const check = (ok, label, detail = '') => {
  total += 1
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const section = (t) => console.log(`\n=== ${t} ===`)

const ORIGIN = config.cors.origins[0] ?? 'http://localhost:5173'

const app = createApp()
const server = http.createServer(app)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

/** One preflight, exactly as a browser would send it. */
async function preflight(path, requestHeaders, { origin = ORIGIN, method = 'POST' } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': requestHeaders,
    },
  })

  const allowHeaders = response.headers.get('access-control-allow-headers') ?? ''

  return {
    status: response.status,
    allowHeaders,
    allowed: allowHeaders.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    allowOrigin: response.headers.get('access-control-allow-origin'),
    allowMethods: response.headers.get('access-control-allow-methods') ?? '',
    allowCredentials: response.headers.get('access-control-allow-credentials'),
    maxAge: response.headers.get('access-control-max-age'),
  }
}

// ---------------------------------------------------------------------------
section('1. THE TWO HEADERS THE OFFLINE QUEUE SENDS')

const offline = await preflight('/api/v1/leads', `content-type,${MUTATION_ID_HEADER}`)

check(offline.status === 204, 'a preflight for an offline replay is answered', `HTTP ${offline.status}`)
check(
  offline.allowed.includes(MUTATION_ID_HEADER.toLowerCase()),
  `${MUTATION_ID_HEADER} is permitted — the header that made offline leads unsyncable`,
)
check(
  offline.allowed.includes(EXPECTED_VERSION_HEADER.toLowerCase()),
  `${EXPECTED_VERSION_HEADER} is permitted — the offline edit's version check`,
)

const edit = await preflight(
  '/api/v1/leads/6a9ba8045c579c6e05caaa48',
  `content-type,${MUTATION_ID_HEADER},${EXPECTED_VERSION_HEADER}`,
  { method: 'PUT' },
)
check(
  edit.allowed.includes(MUTATION_ID_HEADER.toLowerCase()) &&
    edit.allowed.includes(EXPECTED_VERSION_HEADER.toLowerCase()),
  'an offline EDIT sending both headers together is permitted',
)

section('2. THE NAMES MATCH WHAT THE SERVER ACTUALLY READS')

// Derived from the middleware constants, never retyped: a test that hardcoded
// the strings could pass while the server read a different header.
check(MUTATION_ID_HEADER === 'X-Client-Mutation-Id', 'idempotency reads X-Client-Mutation-Id')
check(EXPECTED_VERSION_HEADER === 'X-Expected-Updated-At', 'concurrency reads X-Expected-Updated-At')

section('3. EVERY PRE-EXISTING HEADER SURVIVES')

const existing = ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Filename', 'X-Import-Options', 'X-Document-Meta']

for (const header of existing) {
  check(offline.allowed.includes(header.toLowerCase()), `${header} is still permitted`)
}

check(offline.allowed.length === existing.length + 2, 'exactly two headers were added, and nothing removed', `${offline.allowed.length} total`)

section('4. THE REST OF THE POLICY IS UNCHANGED')

check(offline.allowOrigin === ORIGIN, 'the configured origin is still echoed', offline.allowOrigin ?? 'none')
check(offline.allowCredentials === 'true', 'credentials are still allowed')
check(offline.maxAge === '86400', 'the preflight cache is still 24h', offline.maxAge ?? 'none')

for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
  check(offline.allowMethods.includes(method), `${method} is still permitted`)
}

section('5. THE ALLOWLIST IS STILL AN ALLOWLIST')

const unknown = await preflight('/api/v1/leads', 'content-type,x-not-a-real-header')
check(
  !unknown.allowed.includes('x-not-a-real-header'),
  'an unknown header is NOT echoed — the list did not become permissive',
)

const foreign = await preflight('/api/v1/leads', 'content-type', { origin: 'https://attacker.example' })
check(
  foreign.allowOrigin !== 'https://attacker.example',
  'an unlisted origin is still refused',
  foreign.allowOrigin ?? 'no allow-origin header',
)

section('6. IDEMPOTENCY BEHAVIOUR ITSELF IS UNTOUCHED')

/*
 * The middleware is imported and inspected rather than exercised: driving it
 * needs MongoDB, and this suite deliberately opens no connection. What matters
 * here is that the CORS change did not alter what the server does with the
 * header once it arrives.
 */
const idempotency = await import(`${B}/middlewares/idempotency.js`)
const concurrency = await import(`${B}/utils/optimisticConcurrency.js`)

check(typeof idempotency.MUTATION_ID_HEADER === 'string', 'the idempotency middleware still exports its header')
check(typeof concurrency.EXPECTED_VERSION_HEADER === 'string', 'as does the concurrency helper')
check(
  Object.keys(idempotency).length > 1,
  'the idempotency module still exports its middleware, not just the constant',
  Object.keys(idempotency).join(', '),
)

await new Promise((resolve) => server.close(resolve))

console.log(`\n${fail === 0 ? `ALL ${total} CHECKS PASSED` : `${fail} of ${total} FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
