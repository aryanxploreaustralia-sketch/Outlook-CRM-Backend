/**
 * Phase 3 — the sync cursor contract, proved through a real Express route.
 *
 * ## The bug this exists to prevent coming back
 *
 * The cursors used to travel as a nested object. Axios serialises a nested
 * `params` object as `cursor[leads]=…`; Express 5 defaults its query parser to
 * `"simple"`, which does not reassemble brackets. The server received a flat
 * key literally named `"cursor[leads]"`, Zod stripped it as unknown, and the
 * schema default supplied an empty cursor set — so every request read from the
 * beginning of the feed while still returning a `nextCursor` the client stored
 * and could never spend. Hydration re-fetched page one until its page limit.
 *
 * The previous suites could not catch it: they called `buildChangeFeed` with a
 * JavaScript object, which is downstream of the seam that was broken. So this
 * file makes real HTTP requests to a real `express()` app with the **default**
 * query parser and the real router, and asserts on what actually arrives.
 *
 * ## Safety
 *
 * Connects with an explicit `dbName` of `test_phase3_cursor_verify` — a
 * SEPARATE database on the same cluster — and refuses to run unless the live
 * connection name carries that suffix. Production is never opened by this
 * process, and the isolated database is dropped at the end.
 *
 *     npm run verify:sync-cursor
 */

import express from 'express'
import mongoose from 'mongoose'

const B = new URL('../src', import.meta.url).href
const { config } = await import(`${B}/config/index.js`)

const SUFFIX = '_phase3_cursor_verify'
const TEST_DB = `test${SUFFIX}`

await mongoose.connect(config.database.uri, { ...config.database.options, dbName: TEST_DB })

if (!mongoose.connection.name.endsWith(SUFFIX)) {
  await mongoose.disconnect()
  throw new Error(`Refusing to run: expected an isolated database, got "${mongoose.connection.name}".`)
}
console.log(`Isolated database: ${mongoose.connection.name}\n`)

const { Lead } = await import(`${B}/models/lead.model.js`)
const { Contact } = await import(`${B}/models/contact.model.js`)
const { Company } = await import(`${B}/models/company.model.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)
const { errorHandler } = await import(`${B}/middlewares/errorHandler.js`)
const syncRoutes = (await import(`${B}/modules/sync/routes/sync.routes.js`)).default
const { cursorParam } = await import(`${B}/modules/sync/controllers/sync.controller.js`)

let fail = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n=== ${t} ===`)

const ALICE = new mongoose.Types.ObjectId()

// ---------------------------------------------------------------------------
// A real Express application. No `app.set('query parser', …)` anywhere: this
// runs on the framework default, which is the whole point.
// ---------------------------------------------------------------------------
let authContext = {
  isAuthenticated: true,
  user: { _id: ALICE, id: String(ALICE), role: ROLES.SALES },
  session: { id: 'test-session' },
}

const app = express()

/** A probe on the same app, to observe raw parsing at the seam itself. */
app.get('/probe', (req, res) => res.json({ query: req.query }))

app.use((req, _res, next) => {
  // `requireAuth` loads a session only when `req.auth` is absent, so presetting
  // it exercises the real guard without a signed cookie. An unauthenticated
  // context below exercises the reject path.
  if (authContext) req.auth = authContext
  next()
})
app.use('/api/v1/sync', syncRoutes)
app.use(errorHandler)

const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s))
})
const PORT = server.address().port
const url = (path) => `http://127.0.0.1:${PORT}${path}`
const get = async (path) => {
  const response = await fetch(url(path))
  return { status: response.status, body: await response.json().catch(() => null) }
}

// ---------------------------------------------------------------------------
section('1. THE ACTUAL EXPRESS QUERY PARSER — the seam that broke')

check(app.get('query parser') === 'simple',
  'the app runs on the Express default query parser', String(app.get('query parser')))

const flatProbe = await get('/probe?cursorLeads=ABC&limit=250')
check(flatProbe.body?.query?.cursorLeads === 'ABC',
  'FLAT: ?cursorLeads=ABC arrives as req.query.cursorLeads === "ABC"',
  JSON.stringify(flatProbe.body?.query))

const nestedProbe = await get('/probe?cursor%5Bleads%5D=ABC&limit=250')
check(nestedProbe.body?.query?.cursor === undefined,
  'NESTED: ?cursor[leads]=ABC does NOT produce req.query.cursor (the bug)',
  JSON.stringify(nestedProbe.body?.query))
check(nestedProbe.body?.query?.['cursor[leads]'] === 'ABC',
  '   it arrives as the flat key "cursor[leads]", which Zod then strips')

check(cursorParam('leads') === 'cursorLeads' &&
      cursorParam('contacts') === 'cursorContacts' &&
      cursorParam('companies') === 'cursorCompanies',
  'the server derives the parameter names from SYNC_ENTITIES')

// ---------------------------------------------------------------------------
section('2. AUTHENTICATION AND PERMISSION ARE REALLY ENFORCED')

authContext = { isAuthenticated: false, user: null, session: null }
const anon = await get('/api/v1/sync/changes?limit=1')
check(anon.status === 401, 'an unauthenticated request is refused', `HTTP ${anon.status}`)

authContext = {
  isAuthenticated: true,
  user: { _id: ALICE, id: String(ALICE), role: ROLES.VIEWER },
  session: { id: 'test-session' },
}
const viewer = await get('/api/v1/sync/changes?limit=1')
check([200, 403].includes(viewer.status),
  'a viewer is resolved through the real permission guard', `HTTP ${viewer.status}`)

authContext = {
  isAuthenticated: true,
  user: { _id: ALICE, id: String(ALICE), role: ROLES.SALES },
  session: { id: 'test-session' },
}
const authed = await get('/api/v1/sync/changes?limit=1&entities=leads')
check(authed.status === 200, 'an authenticated sales user is admitted', `HTTP ${authed.status}`)

// ---------------------------------------------------------------------------
section('3. SEEDING 620 LEADS on the isolated database')

await Promise.all([Lead.syncIndexes(), Contact.syncIndexes(), Company.syncIndexes()])

await Lead.insertMany(Array.from({ length: 620 }, (_, i) => ({
  owner: ALICE,
  reference: `CUR${String(i + 1).padStart(5, '0')}`,
  market: 'AU',
  contactPerson: `Person ${i + 1}`,
  stage: 'active',
})))
check(await Lead.countDocuments({ owner: ALICE }) === 620, '620 leads seeded')

await Contact.insertMany(Array.from({ length: 30 }, (_, i) => ({
  owner: ALICE, displayName: `Contact ${i + 1}`, primaryEmail: `c${i + 1}@example.invalid`,
})))
await Company.insertMany(Array.from({ length: 20 }, (_, i) => ({
  owner: ALICE, companyName: `Company ${i + 1}`, matchKey: `company${i + 1}`,
})))
check(await Contact.countDocuments({ owner: ALICE }) === 30, '30 contacts seeded')
check(await Company.countDocuments({ owner: ALICE }) === 20, '20 companies seeded')

// ---------------------------------------------------------------------------
section('4. 620 RECORDS OVER REAL HTTP — 250 / 250 / 120')

const pageSizes = []
const seen = []
const cursorsUsed = []
let cursor = null
let requests = 0
let lastHasMore = null

for (let i = 0; i < 10; i += 1) {
  const query = new URLSearchParams({ entities: 'leads', limit: '250' })
  if (cursor) query.set(cursorParam('leads'), cursor)
  cursorsUsed.push(cursor)

  const { status, body } = await get(`/api/v1/sync/changes?${query}`)
  requests += 1
  if (status !== 200) { check(false, `page ${i + 1} returned HTTP ${status}`); break }

  const page = body.data.entities.leads
  pageSizes.push(page.records.length)
  seen.push(page.records.map((r) => r.id ?? r._id))
  lastHasMore = page.hasMore
  cursor = page.nextCursor

  if (!page.hasMore) break
}

check(requests === 3, 'exactly 3 requests were needed', String(requests))
check(JSON.stringify(pageSizes) === JSON.stringify([250, 250, 120]),
  'page sizes are 250 / 250 / 120', JSON.stringify(pageSizes))

const flat = seen.flat().map(String)
check(flat.length === 620, 'total records returned is 620', String(flat.length))
check(new Set(flat).size === 620, 'no duplicates across the three pages',
  `${new Set(flat).size} unique`)

const seededIds = (await Lead.find({ owner: ALICE }).select('_id').lean()).map((r) => String(r._id))
check(seededIds.every((id) => flat.includes(id)), 'no records were skipped')

check(cursorsUsed[0] === null, 'page 1 was requested with no cursor')
check(typeof cursorsUsed[1] === 'string' && cursorsUsed[1].length > 0,
  'the cursor from page 1 was sent to page 2')
check(typeof cursorsUsed[2] === 'string' && cursorsUsed[2] !== cursorsUsed[1],
  'the cursor from page 2 was sent to page 3, and differed')
check(lastHasMore === false, 'final hasMore === false')

// ---------------------------------------------------------------------------
section('5. REGRESSION — the old nested representation must not work')

const validCursor = cursorsUsed[1]
const nested = await get(
  `/api/v1/sync/changes?entities=leads&limit=250&cursor%5Bleads%5D=${encodeURIComponent(validCursor)}`,
)
const nestedFirst = String(nested.body.data.entities.leads.records[0].id)
const flatAgain = await get(
  `/api/v1/sync/changes?entities=leads&limit=250&${cursorParam('leads')}=${encodeURIComponent(validCursor)}`,
)
const flatFirst = String(flatAgain.body.data.entities.leads.records[0].id)

check(nestedFirst === flat[0],
  'the nested form is ignored and restarts at page 1 — the original bug, reproduced')
check(flatFirst === flat[250],
  'the flat form advances to page 2, as it must')
check(nestedFirst !== flatFirst,
  'the two representations are observably different, so a revert fails this test')

// ---------------------------------------------------------------------------
section('6. MULTI-ENTITY — cursors stay independent')

const all1 = await get('/api/v1/sync/changes?limit=250')
const e1 = all1.body.data.entities
check(e1.leads.records.length === 250, 'leads page 1 is 250', String(e1.leads.records.length))
check(e1.contacts.records.length === 30, 'contacts complete in one page', String(e1.contacts.records.length))
check(e1.companies.records.length === 20, 'companies complete in one page', String(e1.companies.records.length))
check(e1.leads.hasMore === true, 'leads has more')
check(e1.contacts.hasMore === false, 'contacts does not')
check(e1.companies.hasMore === false, 'companies does not')

const distinct = new Set([e1.leads.nextCursor, e1.contacts.nextCursor, e1.companies.nextCursor])
check(distinct.size === 3, 'each entity produced its own distinct cursor', `${distinct.size} distinct`)
check(e1.leads.nextCursor !== e1.contacts.nextCursor, 'the lead cursor is not the contact cursor')
check(e1.contacts.nextCursor !== e1.companies.nextCursor, 'the contact cursor is not the company cursor')

const q2 = new URLSearchParams({ limit: '250' })
q2.set(cursorParam('leads'), e1.leads.nextCursor)
q2.set(cursorParam('contacts'), e1.contacts.nextCursor)
q2.set(cursorParam('companies'), e1.companies.nextCursor)
const all2 = await get(`/api/v1/sync/changes?${q2}`)
const e2 = all2.body.data.entities

check(e2.leads.records.length === 250, 'leads advanced to its own page 2', String(e2.leads.records.length))
check(e2.contacts.records.length === 0, 'the quiet contacts entity returned nothing',
  String(e2.contacts.records.length))
check(e2.companies.records.length === 0, 'the quiet companies entity returned nothing',
  String(e2.companies.records.length))
check(e2.contacts.nextCursor === e1.contacts.nextCursor,
  'an idle entity keeps its place rather than losing it')
check(e2.companies.nextCursor === e1.companies.nextCursor,
  'the same for companies')

const leadIds1 = e1.leads.records.map((r) => String(r.id))
const leadIds2 = e2.leads.records.map((r) => String(r.id))
check(leadIds1.every((id) => !leadIds2.includes(id)),
  'no lead appeared on both pages while the other entities idled')

// ---------------------------------------------------------------------------
section('7. THE CURSOR REACHES THE SERVICE, NOT JUST THE SCHEMA')

const malformed = await get(`/api/v1/sync/changes?entities=leads&${cursorParam('leads')}=not-a-cursor`)
check(malformed.status >= 400,
  'a malformed flat cursor is refused by the service, proving it was forwarded',
  `HTTP ${malformed.status}`)

const empty = await get(`/api/v1/sync/changes?entities=leads&limit=250&${cursorParam('leads')}=`)
check(empty.status === 200 && empty.body.data.entities.leads.records.length === 250,
  'an empty cursor means "from the beginning" rather than an error')

// ---------------------------------------------------------------------------
section('CLEANUP — isolated database only')
server.close()
await mongoose.connection.dropDatabase()
console.log(`  dropped ${TEST_DB}`)
await mongoose.disconnect()

console.log(`\n${fail === 0 ? `ALL ${total} CHECKS PASSED` : `${fail} of ${total} CHECKS FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
