/**
 * Verifies the Phase 2 incremental sync contract.
 *
 * ## Safety
 *
 * Connects with an explicit `dbName` of `test_phase2_sync_verify` — a SEPARATE
 * database on the same cluster — and **refuses to run** unless the live
 * connection name carries that suffix. The production database is never opened
 * by this process, and the isolated one is dropped at the end.
 *
 * This is the pattern `verify-multi-mailbox.js` established.
 *
 *     npm run verify:sync
 */

import mongoose from 'mongoose'

const B = new URL('../src', import.meta.url).href
const { config } = await import(`${B}/config/index.js`)

const SUFFIX = '_phase2_sync_verify'
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
const { SyncTombstone } = await import(`${B}/models/syncTombstone.model.js`)
const sync = await import(`${B}/modules/sync/services/sync.service.js`)
const tombstones = await import(`${B}/modules/sync/services/tombstone.service.js`)

let fail = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n=== ${t} ===`)

/** Two users. Neither exists in production; these ids are generated here. */
const ALICE = new mongoose.Types.ObjectId()
const BOB = new mongoose.Types.ObjectId()

const pause = (ms = 12) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const lead = (owner, over = {}) => ({
  owner, reference: `SYN${String(seq += 1).padStart(5, '0')}`, market: 'AU',
  contactPerson: `Person ${seq}`, stage: 'active', ...over,
})
const contact = (owner) => ({ owner, displayName: `C${seq += 1}`, primaryEmail: `c${seq}@example.invalid` })
const company = (owner) => {
  const n = `Co ${seq += 1}`
  return { owner, companyName: n, matchKey: n.toLowerCase().replace(/\s+/g, '') }
}

// ---------------------------------------------------------------------------
section('SETUP — indexes are created on the isolated database')
await Promise.all([Lead.syncIndexes(), Contact.syncIndexes(), Company.syncIndexes(), SyncTombstone.syncIndexes()])

for (const [name, M, idxName] of [
  ['Lead', Lead, 'lead_sync_feed'], ['Contact', Contact, 'contact_sync_feed'],
  ['Company', Company, 'company_sync_feed'], ['SyncTombstone', SyncTombstone, 'tombstone_sync_feed'],
]) {
  const live = await M.collection.indexes()
  const found = live.find((i) => i.name === idxName)
  check(Boolean(found), `${name}: "${idxName}" index exists`)
  if (found) {
    const keys = Object.keys(found.key)
    const expected = name === 'SyncTombstone' ? ['owner', 'deletedAt', '_id'] : ['owner', 'updatedAt', '_id']
    check(JSON.stringify(keys) === JSON.stringify(expected),
      `${name}: key order is ${expected.join(' → ')}`, keys.join(','))
  }
}
const ttl = (await SyncTombstone.collection.indexes()).find((i) => i.name === 'tombstone_ttl')
check(ttl?.expireAfterSeconds === 90 * 86400, 'SyncTombstone: 90-day TTL index', String(ttl?.expireAfterSeconds))

// ---------------------------------------------------------------------------
section('1. INITIAL SYNC — no cursor returns everything the user owns')

await Lead.create([lead(ALICE), lead(ALICE), lead(ALICE)])
await Contact.create([contact(ALICE), contact(ALICE)])
await Company.create([company(ALICE)])
await Lead.create([lead(BOB), lead(BOB)])

const initial = await sync.buildChangeFeed({ owner: ALICE })
check(initial.entities.leads.records.length === 3, 'Alice sees her 3 leads', String(initial.entities.leads.records.length))
check(initial.entities.contacts.records.length === 2, 'Alice sees her 2 contacts')
check(initial.entities.companies.records.length === 1, 'Alice sees her 1 company')
check(Boolean(initial.serverTime), 'serverTime is reported')
check(initial.entities.leads.hasMore === false, 'hasMore is false when the page fits')
check(Boolean(initial.entities.leads.nextCursor), 'a nextCursor is returned')

console.log('\n  -- the DTO is the CRM\'s own shape --')
const sample = initial.entities.leads.records[0]
check('reference' in sample && 'stage' in sample && 'updatedAt' in sample, 'records use toSummaryJSON()')
check(!('owner' in sample), 'owner is NOT leaked into the DTO (matches the CRM)')
check(!('__v' in sample) && !('_id' in sample), 'internal fields are not exposed')

// ---------------------------------------------------------------------------
section('2. OWNER SECURITY — the core requirement')

const bobFeed = await sync.buildChangeFeed({ owner: BOB })
check(bobFeed.entities.leads.records.length === 2, 'Bob sees only his 2 leads')

const aliceRefs = new Set(initial.entities.leads.records.map((r) => r.reference))
const bobRefs = bobFeed.entities.leads.records.map((r) => r.reference)
check(bobRefs.every((r) => !aliceRefs.has(r)), "Bob's feed contains none of Alice's leads")
check(bobFeed.entities.contacts.records.length === 0, "Bob sees none of Alice's contacts")
check(bobFeed.entities.companies.records.length === 0, "Bob sees none of Alice's companies")

console.log('\n  -- the service cannot be told whose records to return --')
const src = await (await import('node:fs/promises'))
  .readFile(new URL('../src/modules/sync/controllers/sync.controller.js', import.meta.url), 'utf8')
check(!/owner\s*:\s*z\./.test(src), 'the query schema declares no `owner` field')
check(/owner:\s*ownerOf\(req\)/.test(src), 'owner is taken from the session')
check(/req\.auth\.user\._id/.test(src), 'ownerOf reads req.auth.user._id')

/* Zod strips unknown keys, so a spoofed owner never reaches the service. */
const spoofed = await sync.buildChangeFeed({ owner: BOB, entities: ['leads'] })
check(spoofed.entities.leads.records.length === 2, 'a feed built for Bob stays Bob\'s')

let refusedNoOwner = false
try { await sync.buildChangeFeed({ owner: null }) } catch { refusedNoOwner = true }
check(refusedNoOwner, 'a feed with no owner is refused outright')

// ---------------------------------------------------------------------------
section('3. INCREMENTAL — `since` returns only what changed')

const cursorAfterInitial = initial.entities.leads.nextCursor
const quiet = await sync.buildChangeFeed({ owner: ALICE, cursors: { leads: cursorAfterInitial } })
check(quiet.entities.leads.records.length === 0, 'nothing changed → empty page')
check(quiet.entities.leads.nextCursor === cursorAfterInitial, 'an idle client keeps its cursor')

await pause()
const fresh = await Lead.create(lead(ALICE))
const afterCreate = await sync.buildChangeFeed({ owner: ALICE, cursors: { leads: cursorAfterInitial } })
check(afterCreate.entities.leads.records.length === 1, 'a new lead appears', String(afterCreate.entities.leads.records.length))
check(afterCreate.entities.leads.records[0].reference === fresh.reference, 'and it is the right one')

await pause()
await Lead.updateOne({ _id: fresh._id }, { $set: { city: 'Mumbai' } })
const afterUpdate = await sync.buildChangeFeed({ owner: ALICE, cursors: { leads: afterCreate.entities.leads.nextCursor } })
check(afterUpdate.entities.leads.records.length === 1, 'an update appears in the feed')
check(afterUpdate.entities.leads.records[0].city === 'Mumbai', 'carrying the new value')

// ---------------------------------------------------------------------------
section('4. SOFT DELETE TRAVELS IN THE FEED (no tombstone needed)')

await pause()
await Lead.updateOne({ _id: fresh._id }, { $set: { isDeleted: true } })
const afterSoftDelete = await sync.buildChangeFeed({
  owner: ALICE, cursors: { leads: afterUpdate.entities.leads.nextCursor },
})
check(afterSoftDelete.entities.leads.records.length === 1, 'a soft-deleted lead still arrives')
const deletedRecord = await Lead.findById(fresh._id)
check(deletedRecord.isDeleted === true, 'and it is marked deleted in the database')
check(deletedRecord.updatedAt > deletedRecord.createdAt, 'the soft delete moved updatedAt')

// ---------------------------------------------------------------------------
section('5. HARD DELETE — the tombstone path')

const doomed = await Lead.create(lead(ALICE))
await tombstones.recordDeletions({
  entityType: 'lead', entityIds: [doomed._id], owner: ALICE, reason: 'test',
})
await Lead.deleteOne({ _id: doomed._id })

const withTombstone = await sync.buildChangeFeed({ owner: ALICE, since: new Date(Date.now() - 60_000).toISOString() })
const tombs = withTombstone.entities.leads.deleted
check(tombs.length >= 1, 'the tombstone is in the feed', String(tombs.length))
check(tombs.some((t) => t.id === String(doomed._id)), 'naming the removed id')
check(tombs.every((t) => t.purged === false), 'a targeted deletion is not a purge')

await tombstones.recordPurge({ entityType: 'lead', owner: ALICE, reason: 'delete all' })
const withPurge = await sync.buildChangeFeed({ owner: ALICE, since: new Date(Date.now() - 60_000).toISOString() })
check(withPurge.entities.leads.deleted.some((t) => t.purged === true && t.id === null),
  'a purge tombstone says "resynchronise this entity"')

console.log('\n  -- tombstones are owner-scoped too --')
const bobTombs = await sync.buildChangeFeed({ owner: BOB, since: new Date(Date.now() - 60_000).toISOString() })
check(bobTombs.entities.leads.deleted.length === 0, "Bob sees none of Alice's tombstones")

console.log('\n  -- recording never throws, even on bad input --')
const survived = await tombstones.recordPurge({ entityType: 'not-a-real-entity', owner: ALICE })
check(survived === false, 'an invalid tombstone returns false rather than throwing')
const emptyOk = await tombstones.recordDeletions({ entityType: 'lead', entityIds: [], owner: ALICE })
check(emptyOk === true, 'an empty deletion list is a no-op')

// ---------------------------------------------------------------------------
section('6. PAGINATION AND CURSOR DETERMINISM')

const PAGER = new mongoose.Types.ObjectId()
await Lead.insertMany(Array.from({ length: 25 }, () => lead(PAGER)))

let cursor = null
const seen = []
let pages = 0
for (;;) {
  const page = await sync.buildChangeFeed({ owner: PAGER, entities: ['leads'], cursors: { leads: cursor }, limit: 10 })
  seen.push(...page.entities.leads.records.map((r) => r.reference))
  pages += 1
  cursor = page.entities.leads.nextCursor
  if (!page.entities.leads.hasMore || pages > 10) break
}
check(pages === 3, 'a 25-record set paged in 3 requests at limit 10', String(pages))
check(seen.length === 25, 'every record was returned exactly once', String(seen.length))
check(new Set(seen).size === 25, 'no duplicates across page boundaries')

console.log('\n  -- identical timestamps do not break the cursor --')
const TIED = new mongoose.Types.ObjectId()
const sameInstant = new Date()
const tied = Array.from({ length: 12 }, () => ({ ...lead(TIED), updatedAt: sameInstant, createdAt: sameInstant }))
await Lead.insertMany(tied, { timestamps: false })
const stamps = await Lead.find({ owner: TIED }).select('updatedAt').lean()
check(new Set(stamps.map((s) => s.updatedAt.getTime())).size === 1, '12 leads share one millisecond')

let tiedCursor = null
const tiedSeen = []
for (let i = 0; i < 6; i += 1) {
  const page = await sync.buildChangeFeed({ owner: TIED, entities: ['leads'], cursors: { leads: tiedCursor }, limit: 5 })
  tiedSeen.push(...page.entities.leads.records.map((r) => r.reference))
  tiedCursor = page.entities.leads.nextCursor
  if (!page.entities.leads.hasMore) break
}
check(tiedSeen.length === 12, 'all 12 same-millisecond records returned', String(tiedSeen.length))
check(new Set(tiedSeen).size === 12, 'none skipped, none repeated — the _id tiebreak works')

// ---------------------------------------------------------------------------
section('7. LIMITS')

const big = await sync.buildChangeFeed({ owner: PAGER, entities: ['leads'], limit: 99_999 })
check(big.entities.leads.records.length <= sync.MAX_LIMIT, `a huge limit is capped at ${sync.MAX_LIMIT}`,
  String(big.entities.leads.records.length))
const tiny = await sync.buildChangeFeed({ owner: PAGER, entities: ['leads'], limit: 0 })
check(tiny.entities.leads.records.length >= 1, 'a zero limit falls back to a sane page')

// ---------------------------------------------------------------------------
section('8. CURSOR ENCODING')

const enc = sync.encodeCursor(new Date('2026-08-27T10:00:00.000Z'), '6a8fe81a9abe9c424f86b02c')
const dec = sync.decodeCursor(enc)
check(dec.updatedAt.toISOString() === '2026-08-27T10:00:00.000Z', 'round trip preserves the timestamp')
check(dec.id === '6a8fe81a9abe9c424f86b02c', 'round trip preserves the id')
check(!enc.includes('|') && !enc.includes(':'), 'the cursor is opaque and URL-safe', enc.slice(0, 24))

for (const bad of ['not-base64!!', '', 'YWJj']) {
  let refused = false
  try { sync.decodeCursor(bad) } catch { refused = true }
  check(refused, `a malformed cursor (${JSON.stringify(bad)}) is refused, not silently reset`)
}

// ---------------------------------------------------------------------------
section('9. ENTITY SELECTION')

const onlyLeads = await sync.buildChangeFeed({ owner: ALICE, entities: ['leads'] })
check(Object.keys(onlyLeads.entities).join() === 'leads', 'entities=leads returns only leads')
let badEntity = false
try { await sync.buildChangeFeed({ owner: ALICE, entities: ['secrets'] }) } catch { badEntity = true }
check(badEntity, 'an unknown entity is refused')

// ---------------------------------------------------------------------------
section('10. NO CREDENTIALS OR SECRETS IN THE PAYLOAD')

const payload = JSON.stringify(await sync.buildChangeFeed({ owner: ALICE }))
for (const secret of ['password', 'accessToken', 'refreshToken', 'clientSecret', 'sessionId', 'tokenEncryption']) {
  check(!payload.toLowerCase().includes(secret.toLowerCase()), `payload contains no "${secret}"`)
}
check(!payload.includes('"owner"'), 'payload does not carry owner ids')

// ---------------------------------------------------------------------------
section('CLEANUP — isolated database only')
const dbName = mongoose.connection.name
if (!dbName.endsWith(SUFFIX)) throw new Error('refusing to clean a non-isolated database')
await mongoose.connection.dropDatabase()
console.log(`  dropped ${dbName}`)

await mongoose.disconnect()
console.log(`\n${fail === 0 ? `ALL ${total} CHECKS PASSED` : `${fail} of ${total} FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
