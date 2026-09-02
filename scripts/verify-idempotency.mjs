/**
 * Phase 5 — proves a retried mutation cannot duplicate a record.
 *
 * ## What is exercised
 *
 * The real `idempotent()` middleware, on a real `express()` app, against a real
 * MongoDB — including the real `PUT /v1/companies/:id` route, so the replay
 * path is tested through an actual CRM controller rather than a stand-in.
 *
 * The scenario that matters: the server writes the record and the response is
 * lost. The client cannot tell that from "never received", so it retries. With
 * a stable `X-Client-Mutation-Id` the second call must return the first call's
 * response and write nothing.
 *
 * ## Safety
 *
 * Connects with an explicit `dbName` of `test_phase5_idempotency` and refuses
 * to run unless the live connection carries that suffix. Production is never
 * opened; the isolated database is dropped at the end. No mail is sent — no
 * route touched here can send any.
 *
 *     npm run verify:idempotency
 */

import express from 'express'
import mongoose from 'mongoose'

const B = new URL('../src', import.meta.url).href
const { config } = await import(`${B}/config/index.js`)

const SUFFIX = '_phase5_idempotency'
const TEST_DB = `test${SUFFIX}`

await mongoose.connect(config.database.uri, { ...config.database.options, dbName: TEST_DB })
if (!mongoose.connection.name.endsWith(SUFFIX)) {
  await mongoose.disconnect()
  throw new Error(`Refusing to run: expected an isolated database, got "${mongoose.connection.name}".`)
}
console.log(`Isolated database: ${mongoose.connection.name}\n`)

const { Company } = await import(`${B}/models/company.model.js`)
const { MutationReceipt } = await import(`${B}/models/mutationReceipt.model.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)
const { errorHandler } = await import(`${B}/middlewares/errorHandler.js`)
const { idempotent, MUTATION_ID_HEADER } = await import(`${B}/middlewares/idempotency.js`)
const { companyRouter } = await import(`${B}/modules/leads/routes/lead.routes.js`)

let fail = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n=== ${t} ===`)

const OWNER = new mongoose.Types.ObjectId()
const OTHER = new mongoose.Types.ObjectId()

let authUser = { _id: OWNER, id: String(OWNER), role: ROLES.SALES }

// ---------------------------------------------------------------------------
// A real app. `requireAuth` skips session loading when `req.auth` is preset,
// so the real guards run without a signed cookie.
// ---------------------------------------------------------------------------
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.auth = { isAuthenticated: true, user: authUser, session: { id: 'test' } }
  next()
})

/** A counting handler, so "did the work actually run again?" is observable. */
let handlerRuns = 0
app.post('/probe', idempotent(), (req, res) => {
  handlerRuns += 1
  res.status(201).json({ success: true, data: { id: `made-${handlerRuns}`, runs: handlerRuns } })
})

let failRuns = 0
app.post('/probe-fail', idempotent(), (req, res) => {
  failRuns += 1
  res.status(422).json({ success: false, message: 'not acceptable' })
})

app.use('/api/v1/companies', companyRouter)
app.use(errorHandler)

const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const PORT = server.address().port

const call = async (path, { key, body = {}, method = 'POST' } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { [MUTATION_ID_HEADER]: key } : {}),
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    replay: response.headers.get('X-Idempotent-Replay') === 'true',
    body: await response.json().catch(() => null),
  }
}

/** The receipt is written after the response is sent; give it a moment to land. */
const settle = () => new Promise((r) => setTimeout(r, 120))

// ---------------------------------------------------------------------------
section('1. WITHOUT A KEY — existing behaviour is untouched')

handlerRuns = 0
const a1 = await call('/probe')
const a2 = await call('/probe')
check(a1.status === 201 && a2.status === 201, '1. both calls succeeded')
check(handlerRuns === 2, '   the handler ran twice — no key, no deduplication', String(handlerRuns))
check(a1.body.data.id !== a2.body.data.id, '   and produced two different records')
check(await MutationReceipt.countDocuments({}) === 0, '   no receipt was stored')

// ---------------------------------------------------------------------------
section('2. WITH A KEY — a retry replays instead of repeating')

handlerRuns = 0
const key = 'mut-0001'
const first = await call('/probe', { key })
await settle()
const second = await call('/probe', { key })

check(first.status === 201, '2. the first call ran', `HTTP ${first.status}`)
check(handlerRuns === 1, '   the handler ran exactly once', String(handlerRuns))
check(second.status === 201, '   the retry returned the original status')
check(JSON.stringify(second.body) === JSON.stringify(first.body),
  '   the retry returned the original body byte for byte')
check(second.replay === true, '   and was marked as a replay')

const third = await call('/probe', { key })
check(handlerRuns === 1, '   a third attempt still did not re-run the handler', String(handlerRuns))
check(third.body.data.id === first.body.data.id, '   and returned the same record id')

// ---------------------------------------------------------------------------
section('3. CONCURRENT RETRIES — the unique index decides')

handlerRuns = 0
const raceKey = 'mut-race'
const results = await Promise.all([
  call('/probe', { key: raceKey }),
  call('/probe', { key: raceKey }),
  call('/probe', { key: raceKey }),
])
await settle()

check(results.every((r) => r.status === 201), '3. every concurrent attempt succeeded')
check(await MutationReceipt.countDocuments({ clientMutationId: raceKey }) === 1,
  '   exactly one receipt exists',
  String(await MutationReceipt.countDocuments({ clientMutationId: raceKey })))

const afterRace = await call('/probe', { key: raceKey })
check(afterRace.replay === true, '   and a later retry replays')

// ---------------------------------------------------------------------------
section('4. FAILURES ARE NOT MADE PERMANENT')

failRuns = 0
const failKey = 'mut-fail'
const bad1 = await call('/probe-fail', { key: failKey })
await settle()
const bad2 = await call('/probe-fail', { key: failKey })

check(bad1.status === 422 && bad2.status === 422, '4. both attempts returned 422')
check(failRuns === 2, '   the handler ran both times — a rejection is not a completed mutation',
  String(failRuns))
check(await MutationReceipt.countDocuments({ clientMutationId: failKey }) === 0,
  '   and no receipt was stored, so a corrected retry can still succeed')

// ---------------------------------------------------------------------------
section('5. A KEY REUSED ON A DIFFERENT ENDPOINT IS REFUSED')

const reuseKey = 'mut-reuse'
await call('/probe', { key: reuseKey })
await settle()
const reused = await call('/probe-fail', { key: reuseKey })
check(reused.status === 409, '5. reusing a key for a different request is refused', `HTTP ${reused.status}`)
check(reused.body?.code === 'IDEMPOTENCY_KEY_REUSED', '   with an explicit code')

// ---------------------------------------------------------------------------
section('6. RECEIPTS ARE OWNER-SCOPED')

const sharedKey = 'mut-shared'
handlerRuns = 0
authUser = { _id: OWNER, id: String(OWNER), role: ROLES.SALES }
const mine = await call('/probe', { key: sharedKey })
await settle()

authUser = { _id: OTHER, id: String(OTHER), role: ROLES.SALES }
const theirs = await call('/probe', { key: sharedKey })
await settle()

check(handlerRuns === 2, '6. the same key from a different user ran its own mutation',
  String(handlerRuns))
check(theirs.body.data.id !== mine.body.data.id,
  "   and produced a different record — no reply leaked from another user's receipt")
check(theirs.replay === false, '   the second user did not get a replay')
check(await MutationReceipt.countDocuments({ clientMutationId: sharedKey }) === 2,
  '   two receipts exist, one per owner')

authUser = { _id: OWNER, id: String(OWNER), role: ROLES.SALES }

// ---------------------------------------------------------------------------
section('7. THROUGH A REAL CRM ROUTE — PUT /v1/companies/:id')

const company = await Company.create({
  owner: OWNER, companyName: 'Idempotency Test Co', matchKey: 'idempotencytestco', city: 'Mumbai',
})

const editKey = 'mut-company-edit'
const edit1 = await call(`/api/v1/companies/${company._id}`, {
  key: editKey, method: 'PUT', body: { city: 'Pune' },
})
await settle()

check(edit1.status === 200, '7. the real route accepted the edit', `HTTP ${edit1.status}`)
check(edit1.body?.data?.company?.city === 'Pune', '   the city was changed')

// Change it underneath, then replay: the replay must not re-apply the edit.
await Company.updateOne({ _id: company._id }, { $set: { city: 'Chennai' } })

const edit2 = await call(`/api/v1/companies/${company._id}`, {
  key: editKey, method: 'PUT', body: { city: 'Pune' },
})

check(edit2.replay === true, '   the retry was served from the receipt')
check(JSON.stringify(edit2.body) === JSON.stringify(edit1.body), '   with the original body')

const stored = await Company.findById(company._id).lean()
check(stored.city === 'Chennai',
  '   and the database was NOT written again — the replay changed nothing', stored.city)

check(await Company.countDocuments({ owner: OWNER }) === 1,
  '   exactly one company exists', String(await Company.countDocuments({ owner: OWNER })))

// ---------------------------------------------------------------------------
section('8. THE RECEIPT CARRIES NO CREDENTIALS')

const receipts = await MutationReceipt.find({}).lean()
const serialised = JSON.stringify(receipts)
for (const secret of ['password', 'accessToken', 'refreshToken', 'clientSecret', 'sessionId']) {
  check(!serialised.includes(secret), `8. no "${secret}" in any stored receipt`)
}

// ---------------------------------------------------------------------------
section('9. INDEXES')

await MutationReceipt.syncIndexes()
const indexes = await MutationReceipt.collection.indexes()
const unique = indexes.find((i) => i.name === 'receipt_key')
check(Boolean(unique), '9. the (owner, clientMutationId) index exists')
check(unique?.unique === true, '   and is unique — this is what settles a concurrent race')
const ttl = indexes.find((i) => i.name === 'receipt_ttl')
check(Boolean(ttl) && typeof ttl.expireAfterSeconds === 'number',
  '   a TTL index bounds the collection', `${ttl?.expireAfterSeconds}s`)

// ---------------------------------------------------------------------------
section('CLEANUP — isolated database only')
server.close()
await mongoose.connection.dropDatabase()
console.log(`  dropped ${TEST_DB}`)
await mongoose.disconnect()

console.log(`\n${fail === 0 ? `ALL ${total} CHECKS PASSED` : `${fail} of ${total} CHECKS FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
