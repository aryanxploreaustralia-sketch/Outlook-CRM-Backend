/**
 * The public health endpoint discloses nothing but its status.
 *
 * Mounts the real application (`createApp`) on an ephemeral local port and
 * calls `GET /api/v1/health` over HTTP, so the route, the middleware stack
 * (CORS, rate limiter, error handler) and the controller are all exercised as
 * a monitor would reach them. The database state is simulated by setting the
 * mongoose connection's ready state; no connection is ever opened.
 *
 * Nothing here touches a database.
 *
 *     node scripts/test-health-endpoint.mjs
 */

import http from 'node:http'

const B = new URL('../src', import.meta.url).href
const { default: mongoose } = await import('mongoose')
const { createApp } = await import(`${B}/app.js`)
const { config } = await import(`${B}/config/index.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

const server = http.createServer(createApp())
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const PATH = `${config.server.apiPrefix}/v1/health`

const get = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let raw = ''
        res.on('data', (chunk) => (raw += chunk))
        res.on('end', () => resolve({ status: res.statusCode, raw, headers: res.headers }))
      })
      .on('error', reject)
  })

/** Makes the connection look like one to a real cluster, so a leak would show. */
const connection = mongoose.connection
const setReadyState = (state) => {
  try {
    connection.readyState = state
  } catch {
    Object.defineProperty(connection, 'readyState', { value: state, configurable: true, writable: true })
  }
}
for (const [key, value] of [
  ['name', 'secret_db_name'],
  ['host', 'ac-leak-shard-00-01.leakcluster.mongodb.net'],
]) {
  try {
    Object.defineProperty(connection, key, { value, configurable: true, writable: true })
  } catch {
    // Not overridable in this mongoose version; the key check below still holds.
  }
}

const FORBIDDEN_KEYS = [
  'environment', 'database', 'dependencies', 'name', 'host', 'pid', 'memory', 'memoryMb',
  'node', 'nodeVersion', 'runtime', 'uptime', 'uptimeSeconds', 'version', 'service', 'stack',
]
const FORBIDDEN_TEXT = [
  'secret_db_name', 'leakcluster', 'mongodb', config.app.env, process.version, String(process.pid),
]

const assertMinimal = (label, body, raw) => {
  check(`${label}: the body has exactly one key, "status"`, JSON.stringify(Object.keys(body)) === '["status"]', raw)
  const allKeys = JSON.stringify(body).match(/"([^"]+)":/g)?.map((k) => k.slice(1, -2)) ?? []
  const leakedKeys = FORBIDDEN_KEYS.filter((key) => allKeys.includes(key))
  check(`${label}: no infrastructure keys`, leakedKeys.length === 0, leakedKeys.join(', '))
  const leakedText = FORBIDDEN_TEXT.filter((text) => text && raw.toLowerCase().includes(String(text).toLowerCase()))
  check(`${label}: no infrastructure values (db name, cluster, env, node version, pid)`, leakedText.length === 0, leakedText.join(', '))
}

// --- healthy ---------------------------------------------------------------
console.log('\n=== Healthy ===')
setReadyState(1)
const healthy = await get(PATH)
console.log(`  response: HTTP ${healthy.status} ${healthy.raw}`)
const healthyBody = JSON.parse(healthy.raw)
check('1. returns 200 when the database is connected', healthy.status === 200)
check('2. status is "ok"', healthyBody.status === 'ok')
check('   served as JSON', String(healthy.headers['content-type']).includes('application/json'))
assertMinimal('3. healthy', healthyBody, healthy.raw)

// --- degraded --------------------------------------------------------------
console.log('\n=== Degraded ===')
setReadyState(0)
const degraded = await get(PATH)
console.log(`  response: HTTP ${degraded.status} ${degraded.raw}`)
const degradedBody = JSON.parse(degraded.raw)
check('4. still reports an unhealthy backend: 503', degraded.status === 503)
check('   status is "degraded"', degradedBody.status === 'degraded')
assertMinimal('   degraded', degradedBody, degraded.raw)

// --- unchanged surroundings -------------------------------------------------
console.log('\n=== Unchanged ===')
let limited = 0
for (let i = 0; i < 5; i += 1) {
  const res = await get(PATH)
  if (res.status === 429) limited += 1
}
check('still public and rate-limit exempt (no auth, no 429)', limited === 0)
const leads = await get(`${config.server.apiPrefix}/v1/leads`)
check('5. other API routes still require authentication (401)', leads.status === 401)

setReadyState(0)
await new Promise((resolve) => server.close(resolve))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
