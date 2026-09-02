/**
 * Proves the tombstone step cannot break a destructive operation.
 *
 * ## Safety
 *
 * Connects with an explicit `dbName` of `test_phase2_destructive_verify` — a
 * SEPARATE database — and refuses to run unless the live connection name
 * carries that suffix. Production is never opened. The isolated database is
 * dropped at the end.
 *
 * Every "destructive" operation below runs against records this script created
 * seconds earlier, in that isolated database.
 *
 *     npm run verify:sync-destructive
 */

import mongoose from 'mongoose'

const B = new URL('../src', import.meta.url).href
const { config } = await import(`${B}/config/index.js`)

const SUFFIX = '_phase2_destructive_verify'
await mongoose.connect(config.database.uri, { ...config.database.options, dbName: `test${SUFFIX}` })

if (!mongoose.connection.name.endsWith(SUFFIX)) {
  await mongoose.disconnect()
  throw new Error(`Refusing to run: expected an isolated database, got "${mongoose.connection.name}".`)
}
console.log(`Isolated database: ${mongoose.connection.name}\n`)

const { Lead } = await import(`${B}/models/lead.model.js`)
const { SyncTombstone } = await import(`${B}/models/syncTombstone.model.js`)
const { rollbackImport } = await import(`${B}/modules/leads/services/leadImport.service.js`)
const tombstoneService = await import(`${B}/modules/sync/services/tombstone.service.js`)

let fail = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n=== ${t} ===`)

await Promise.all([Lead.syncIndexes(), SyncTombstone.syncIndexes()])

let seq = 0
const makeLeads = async (owner, importJob, n) => {
  const rows = Array.from({ length: n }, () => ({
    owner, importJob, reference: `RB${String(seq += 1).padStart(5, '0')}`,
    market: 'AU', contactPerson: `P${seq}`, stage: 'active',
  }))
  return Lead.insertMany(rows)
}
const reset = async () => { await Lead.deleteMany({}); await SyncTombstone.deleteMany({}) }

// ---------------------------------------------------------------------------
section('1. HAPPY PATH — tombstone written, then the delete')

const OWNER = new mongoose.Types.ObjectId()
const JOB = new mongoose.Types.ObjectId()
await makeLeads(OWNER, JOB, 5)

const result = await rollbackImport({ owner: OWNER, importJob: JOB })
check(result.leads === 5, '5 leads deleted', String(result.leads))
check((await Lead.countDocuments({ owner: OWNER, importJob: JOB })) === 0, 'none survive')

const tombs = await SyncTombstone.find({ owner: OWNER }).lean()
check(tombs.length === 5, 'one tombstone per removed lead', String(tombs.length))
check(tombs.every((t) => t.entityType === 'lead'), 'entityType is correct')
check(tombs.every((t) => String(t.owner) === String(OWNER)), 'owner is correct')
check(tombs.every((t) => t.entityId), 'entityId is set on a targeted deletion')
check(tombs.every((t) => t.reason === 'Import rolled back'), 'reason recorded')

console.log('\n  -- the tombstone precedes the delete --')
const src = await (await import('node:fs/promises'))
  .readFile(new URL('../src/modules/leads/services/leadImport.service.js', import.meta.url), 'utf8')
check(src.indexOf('recordRemoval(') < src.indexOf('Lead.deleteMany'), 'recordRemoval runs before deleteMany')

// ---------------------------------------------------------------------------
section('2. TOMBSTONE FAILURE MUST NOT BLOCK THE DELETE')

await reset()
await makeLeads(OWNER, JOB, 4)

/* Break the tombstone collection: every write throws. */
const realCreate = SyncTombstone.create.bind(SyncTombstone)
const realInsertMany = SyncTombstone.insertMany.bind(SyncTombstone)
SyncTombstone.create = async () => { throw new Error('injected: tombstone collection unavailable') }
SyncTombstone.insertMany = async () => { throw new Error('injected: tombstone collection unavailable') }

let threw = null
let broken
try {
  broken = await rollbackImport({ owner: OWNER, importJob: JOB })
} catch (error) { threw = error }

SyncTombstone.create = realCreate
SyncTombstone.insertMany = realInsertMany

check(threw === null, 'the rollback did NOT throw', threw?.message ?? '')
check(broken?.leads === 4, 'all 4 leads were still deleted', String(broken?.leads))
check((await Lead.countDocuments({ owner: OWNER, importJob: JOB })) === 0, 'the deletion completed')

// ---------------------------------------------------------------------------
section('3. ID LOOKUP FAILURE MUST NOT BLOCK THE DELETE')
console.log('  (this is the bug this review found — Lead.find was unguarded)\n')

await reset()
await makeLeads(OWNER, JOB, 3)

const realFind = Lead.find.bind(Lead)
let findCalls = 0
Lead.find = (...args) => {
  findCalls += 1
  // Only the tombstone's id lookup fails; later lookups behave normally.
  if (findCalls === 1) throw new Error('injected: id lookup failed')
  return realFind(...args)
}

threw = null
let survived
try {
  survived = await rollbackImport({ owner: OWNER, importJob: JOB })
} catch (error) { threw = error }

Lead.find = realFind

check(threw === null, 'the rollback did NOT throw', threw?.message ?? '')
check(survived?.leads === 3, 'all 3 leads were still deleted', String(survived?.leads))

const fallback = await SyncTombstone.find({ owner: OWNER }).lean()
check(fallback.length === 1, 'a single fallback tombstone was written', String(fallback.length))
check(fallback[0]?.entityId === null, 'it is a PURGE — "resynchronise leads"')
check(/could not be read/.test(fallback[0]?.reason ?? ''), 'the reason explains why', fallback[0]?.reason)

// ---------------------------------------------------------------------------
section('4. DELETE FAILURE MUST NOT LEAVE MISLEADING TOMBSTONES')
console.log('  (a per-id tombstone for a surviving record would make the client')
console.log('   drop a lead the server still holds, and never resend it)\n')

await reset()
await makeLeads(OWNER, JOB, 3)

const realDeleteMany = Lead.deleteMany.bind(Lead)
Lead.deleteMany = async () => { throw new Error('injected: delete failed') }

threw = null
try {
  await rollbackImport({ owner: OWNER, importJob: JOB })
} catch (error) { threw = error }

Lead.deleteMany = realDeleteMany

check(threw !== null, 'the failure IS surfaced to the caller', threw?.message)
check(threw?.message === 'injected: delete failed', 'the original error is preserved, not swallowed')
check((await Lead.countDocuments({ owner: OWNER, importJob: JOB })) === 3, 'the leads survive')

const after = await SyncTombstone.find({ owner: OWNER }).lean()
const purge = after.filter((t) => t.entityId === null)
check(purge.length === 1, 'a repairing purge tombstone was written', String(purge.length))
check(/rollback failed/.test(purge[0]?.reason ?? ''), 'its reason names the cause', purge[0]?.reason)
console.log('    -> the client resynchronises leads, restoring anything it wrongly dropped')

// ---------------------------------------------------------------------------
section('5. REPEATED ROLLBACKS ARE SAFE')

await reset()
await makeLeads(OWNER, JOB, 3)
const first = await rollbackImport({ owner: OWNER, importJob: JOB })
const second = await rollbackImport({ owner: OWNER, importJob: JOB })

check(first.leads === 3, 'the first rollback removed 3')
check(second.leads === 0, 'the second removed 0 — nothing left')
check(threw !== undefined, 'the second did not throw')
const repeated = await SyncTombstone.find({ owner: OWNER }).lean()
check(repeated.length === 3, 'no duplicate tombstones from the empty second run', String(repeated.length))

// ---------------------------------------------------------------------------
section('6. TOMBSTONES STAY OWNER-SCOPED UNDER FAILURE')

await reset()
const OTHER = new mongoose.Types.ObjectId()
await makeLeads(OWNER, JOB, 2)
await makeLeads(OTHER, JOB, 2)

await rollbackImport({ owner: OWNER, importJob: JOB })
check((await Lead.countDocuments({ owner: OTHER })) === 2, "the other owner's leads are untouched")
check((await SyncTombstone.countDocuments({ owner: OTHER })) === 0, "no tombstone written for the other owner")

// ---------------------------------------------------------------------------
section('7. BULK COLLAPSE — a huge rollback stays one small write')

await reset()
const many = Array.from({ length: 1500 }, () => new mongoose.Types.ObjectId())
await tombstoneService.recordDeletions({
  entityType: 'lead', entityIds: many, owner: OWNER, reason: 'bulk', maxIds: 1000,
})
const collapsed = await SyncTombstone.find({ owner: OWNER }).lean()
check(collapsed.length === 1, '1500 ids collapse to one tombstone', String(collapsed.length))
check(collapsed[0].entityId === null, 'and it is a purge')

// ---------------------------------------------------------------------------
section('8. leadPurge — the other destructive path')

const { purgeLeads } = await import(`${B}/modules/leads/services/leadPurge.service.js`)

await reset()
const PURGE_OWNER = new mongoose.Types.ObjectId()
await makeLeads(PURGE_OWNER, JOB, 6)

const purged = await purgeLeads({ owner: PURGE_OWNER })
check((purged?.deletedLeads ?? purged?.leads ?? 0) === 6, 'purge removed all 6', JSON.stringify(purged?.deletedLeads ?? purged?.leads))
check((await Lead.countDocuments({ owner: PURGE_OWNER })) === 0, 'none survive')

const purgeTombs = await SyncTombstone.find({ owner: PURGE_OWNER }).lean()
check(purgeTombs.length === 1, 'exactly ONE tombstone, not 6', String(purgeTombs.length))
check(purgeTombs[0]?.entityId === null, 'it is a purge — "resynchronise leads"')
console.log('    -> 3,630 leads would still be one row, not 3,630')

console.log('\n  -- a broken tombstone collection must not block "Delete all" --')
await reset()
await makeLeads(PURGE_OWNER, JOB, 4)

const realCreate2 = SyncTombstone.create.bind(SyncTombstone)
SyncTombstone.create = async () => { throw new Error('injected: tombstone write failed') }

let purgeThrew = null
let degraded
try {
  degraded = await purgeLeads({ owner: PURGE_OWNER })
} catch (error) { purgeThrew = error }

SyncTombstone.create = realCreate2

check(purgeThrew === null, 'purgeLeads did NOT throw', purgeThrew?.message ?? '')
check((degraded?.deletedLeads ?? degraded?.leads ?? 0) === 4, 'all 4 leads were still deleted')
check((await Lead.countDocuments({ owner: PURGE_OWNER })) === 0, 'the deletion completed')
console.log('    -> the deletion is invisible to offline clients, and logged as such')

console.log('\n  -- if the delete fails after the purge tombstone, the client self-heals --')
await reset()
await makeLeads(PURGE_OWNER, JOB, 3)

const realDeleteMany2 = Lead.deleteMany.bind(Lead)
let deleteCalls = 0
Lead.deleteMany = async (...args) => {
  deleteCalls += 1
  // Only the lead deletion fails; the cascade deletions behave normally.
  if (args[0] && Object.keys(args[0]).length === 1 && args[0].owner) {
    throw new Error('injected: purge delete failed')
  }
  return realDeleteMany2(...args)
}

purgeThrew = null
try { await purgeLeads({ owner: PURGE_OWNER }) } catch (error) { purgeThrew = error }
Lead.deleteMany = realDeleteMany2

check(purgeThrew !== null, 'the failure IS surfaced', purgeThrew?.message)
check((await Lead.countDocuments({ owner: PURGE_OWNER })) === 3, 'the leads survive')
const healTombs = await SyncTombstone.find({ owner: PURGE_OWNER }).lean()
check(healTombs.length === 1 && healTombs[0].entityId === null,
  'the stale tombstone is a PURGE, so the client refetches and restores them')
console.log('    -> a purge tombstone is safe even when nothing was deleted')

// ---------------------------------------------------------------------------
section('CLEANUP — isolated database only')
const dbName = mongoose.connection.name
if (!dbName.endsWith(SUFFIX)) throw new Error('refusing to clean a non-isolated database')
await mongoose.connection.dropDatabase()
console.log(`  dropped ${dbName}`)

await mongoose.disconnect()
console.log(`\n${fail === 0 ? `ALL ${total} CHECKS PASSED` : `${fail} of ${total} FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
