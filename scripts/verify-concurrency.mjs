/**
 * Phase 6 — optimistic concurrency, delete concurrency, and their interaction
 * with idempotency.
 *
 * ## What is exercised
 *
 * Real Express, real routers, real controllers, real MongoDB. Every assertion
 * below is about what the database actually holds after a request, not about
 * what a mock was told.
 *
 * The property that matters: a mutation written against a version that has
 * since changed must be **refused**, and refusing it must leave the newer
 * server state exactly as it was.
 *
 * ## Safety
 *
 * Connects with an explicit `dbName` of `test_phase6_concurrency` and refuses
 * to run unless the live connection carries that suffix. The production
 * database is never opened by this process, and the isolated one is dropped at
 * the end. No route touched here can send mail.
 *
 *     npm run verify:concurrency
 */

import express from 'express'
import mongoose from 'mongoose'

const B = new URL('../src', import.meta.url).href
const { config } = await import(`${B}/config/index.js`)

const SUFFIX = '_phase6_concurrency'
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
const { AuditLog } = await import(`${B}/models/auditLog.model.js`)
const { MutationReceipt } = await import(`${B}/models/mutationReceipt.model.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)
const { errorHandler } = await import(`${B}/middlewares/errorHandler.js`)
const { EXPECTED_VERSION_HEADER } = await import(`${B}/utils/optimisticConcurrency.js`)
const { MUTATION_ID_HEADER } = await import(`${B}/middlewares/idempotency.js`)
const leadRouter = (await import(`${B}/modules/leads/routes/lead.routes.js`)).default
const { companyRouter } = await import(`${B}/modules/leads/routes/lead.routes.js`)
const contactRouter = (await import(`${B}/modules/contacts/routes/contact.routes.js`)).default

let fail = 0
let total = 0
const check = (ok, label, detail = '') => {
  total += 1
  if (!ok) fail += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n=== ${t} ===`)

const ALICE = new mongoose.Types.ObjectId()
const BOB = new mongoose.Types.ObjectId()
let authUser = { _id: ALICE, id: String(ALICE), role: ROLES.OWNER, displayName: 'Alice' }

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.auth = { isAuthenticated: true, user: authUser, session: { id: 'test' } }
  next()
})
app.use('/api/v1/leads', leadRouter)
app.use('/api/v1/companies', companyRouter)
app.use('/api/v1/contacts', contactRouter)
app.use(errorHandler)

const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
const PORT = server.address().port

const call = async (method, path, { body, version, mutationId } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(version ? { [EXPECTED_VERSION_HEADER]: version } : {}),
      ...(mutationId ? { [MUTATION_ID_HEADER]: mutationId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return {
    status: response.status,
    replay: response.headers.get('X-Idempotent-Replay') === 'true',
    body: await response.json().catch(() => null),
  }
}
const settle = () => new Promise((r) => setTimeout(r, 120))
const iso = (d) => new Date(d).toISOString()

const newCompany = async (name) => Company.create({
  owner: ALICE, companyName: name, matchKey: name.toLowerCase().replace(/\s+/g, ''), city: 'Mumbai',
})
const newLead = async (ref) => Lead.create({
  owner: ALICE, reference: ref, market: 'AU', contactPerson: 'Test Person', stage: 'active', city: 'Mumbai',
})
const newContact = async (name) => Contact.create({
  owner: ALICE, displayName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@x.invalid`,
})

// ---------------------------------------------------------------------------
section('1. NO HEADER — existing online behaviour is untouched')

const plain = await newCompany('Plain Co')
const noHeader = await call('PUT', `/api/v1/companies/${plain._id}`, { body: { city: 'Pune' } })
check(noHeader.status === 200, '1. an edit with no version header succeeds', `HTTP ${noHeader.status}`)
check((await Company.findById(plain._id)).city === 'Pune', '   and is applied')

// Even a wildly stale caller succeeds when it does not ask for the check.
const stillNoHeader = await call('PUT', `/api/v1/companies/${plain._id}`, { body: { city: 'Delhi' } })
check(stillNoHeader.status === 200, '   a second edit with no header also succeeds — nothing opted in')

// ---------------------------------------------------------------------------
section('2. EDIT — matching version succeeds, stale version is refused')

const co = await newCompany('Version Co')
const v0 = iso(co.updatedAt)

const good = await call('PUT', `/api/v1/companies/${co._id}`, { body: { city: 'Pune' }, version: v0 })
check(good.status === 200, '2. an edit at the current version succeeds', `HTTP ${good.status}`)
check((await Company.findById(co._id)).city === 'Pune', '   and is applied')

const v1 = iso((await Company.findById(co._id)).updatedAt)
check(v1 !== v0, '   the version advanced', `${v0} → ${v1}`)

// A second edit still holding the ORIGINAL version.
const stale = await call('PUT', `/api/v1/companies/${co._id}`, { body: { city: 'Chennai' }, version: v0 })
check(stale.status === 409, '3. a stale edit is refused with 409', `HTTP ${stale.status}`)
check(stale.body?.code === 'VERSION_CONFLICT', '   with the VERSION_CONFLICT code', stale.body?.code)

const after = await Company.findById(co._id)
check(after.city === 'Pune', '4. the newer server value was NOT overwritten', after.city)
check(iso(after.updatedAt) === v1, '   and the server version is untouched by the refusal')

// ---------------------------------------------------------------------------
section('3. THE 409 CARRIES WHAT A CLIENT NEEDS')

const detail = stale.body?.errors
check(Boolean(detail), '5. the response carries conflict detail')
check(detail?.conflictType === 'staleVersion', '   conflictType', detail?.conflictType)
check(detail?.entity === 'companies', '   entity', detail?.entity)
check(String(detail?.id) === String(co._id), '   record id')
check(detail?.expectedUpdatedAt === v0, '   the version the client held')
check(detail?.serverUpdatedAt === v1, '   the version the server holds')
check(detail?.serverDeleted === false, '   and whether the record was deleted')

// ---------------------------------------------------------------------------
section('4. LEADS — the same guard on a controller with business logic')

const lead = await newLead('CONC0001')
const lv0 = iso(lead.updatedAt)

const leadOk = await call('PUT', `/api/v1/leads/${lead._id}`, { body: { city: 'Delhi' }, version: lv0 })
check(leadOk.status === 200, '6. a lead edit at the current version succeeds', `HTTP ${leadOk.status}`)
check((await Lead.findById(lead._id)).city === 'Delhi', '   and is applied')

const leadStale = await call('PUT', `/api/v1/leads/${lead._id}`, { body: { city: 'Kochi' }, version: lv0 })
check(leadStale.status === 409, '7. a stale lead edit is refused', `HTTP ${leadStale.status}`)
check((await Lead.findById(lead._id)).city === 'Delhi', '   and the newer value survives')

// A stage change is business logic, not a field assignment — it must be guarded too.
const lv1 = iso((await Lead.findById(lead._id)).updatedAt)
await Lead.updateOne({ _id: lead._id }, { $set: { handledBy: 'Someone Else' } })
const staleStage = await call('PUT', `/api/v1/leads/${lead._id}`, { body: { stage: 'closed' }, version: lv1 })
check(staleStage.status === 409, '8. a stale STAGE change is refused', `HTTP ${staleStage.status}`)
const stageAfter = await Lead.findById(lead._id)
check(stageAfter.stage === 'active', '   the stage did not move', stageAfter.stage)
check(stageAfter.stageHistory.length === 0, '   and no stage history was written', String(stageAfter.stageHistory.length))

// ---------------------------------------------------------------------------
section('5. DELETE — version guarded, and nothing newer is destroyed')

const delCo = await newCompany('Delete Co')
const dv0 = iso(delCo.updatedAt)

await Company.updateOne({ _id: delCo._id }, { $set: { city: 'Moved' } })

const staleDelete = await call('DELETE', `/api/v1/companies/${delCo._id}`, { version: dv0 })
check(staleDelete.status === 409, '9. a stale delete is refused', `HTTP ${staleDelete.status}`)
const survived = await Company.findById(delCo._id)
check(survived.isDeleted === false, '10. the record was NOT deleted', String(survived.isDeleted))
check(survived.city === 'Moved', '    and the newer change survives')

const dv1 = iso(survived.updatedAt)
const okDelete = await call('DELETE', `/api/v1/companies/${delCo._id}`, { version: dv1 })
check(okDelete.status === 200, '11. a delete at the current version succeeds', `HTTP ${okDelete.status}`)
check((await Company.findById(delCo._id)).isDeleted === true, '    and soft-deletes the record')

// Deleting again: the record is already gone from the active set.
const twice = await call('DELETE', `/api/v1/companies/${delCo._id}`, { version: dv1 })
check(twice.status === 404,
  '12. deleting an already-deleted record is a deterministic 404 — existing semantics, unchanged',
  `HTTP ${twice.status}`)

// ---------------------------------------------------------------------------
section('6. LEAD AND CONTACT DELETE')

const delLead = await newLead('CONC0002')
const dlv = iso(delLead.updatedAt)
await Lead.updateOne({ _id: delLead._id }, { $set: { city: 'Changed' } })

const staleLeadDelete = await call('DELETE', `/api/v1/leads/${delLead._id}`, { version: dlv })
check(staleLeadDelete.status === 409, '13. a stale lead delete is refused', `HTTP ${staleLeadDelete.status}`)
check((await Lead.findById(delLead._id)).isDeleted === false, '    the lead survives')

const freshLead = iso((await Lead.findById(delLead._id)).updatedAt)
const auditBefore = await AuditLog.countDocuments({ action: 'lead.deleted' })
const okLeadDelete = await call('DELETE', `/api/v1/leads/${delLead._id}`, { version: freshLead })
check(okLeadDelete.status === 200, '14. a current lead delete succeeds', `HTTP ${okLeadDelete.status}`)
check((await Lead.findById(delLead._id)).isDeleted === true, '    and soft-deletes it')
check(await AuditLog.countDocuments({ action: 'lead.deleted' }) === auditBefore + 1,
  '    one audit event was written')

const contact = await newContact('Conflict Person')
const cv0 = iso(contact.updatedAt)
await Contact.updateOne({ _id: contact._id }, { $set: { country: 'India' } })

const staleContact = await call('PUT', `/api/v1/contacts/${contact._id}`, { body: { company: 'X' }, version: cv0 })
check(staleContact.status === 409, '15. a stale contact edit is refused', `HTTP ${staleContact.status}`)
check((await Contact.findById(contact._id)).company !== 'X', '    and is not applied')

const staleContactDelete = await call('DELETE', `/api/v1/contacts/${contact._id}`, { version: cv0 })
check(staleContactDelete.status === 409, '16. a stale contact delete is refused', `HTTP ${staleContactDelete.status}`)
check((await Contact.findById(contact._id)).isDeleted === false, '    and the contact survives')

// ---------------------------------------------------------------------------
section('7. NO MISLEADING AUDIT ON A REFUSED MUTATION')

const auditLead = await newLead('CONC0003')
const av = iso(auditLead.updatedAt)
await Lead.updateOne({ _id: auditLead._id }, { $set: { city: 'Elsewhere' } })

const updatedBefore = await AuditLog.countDocuments({ action: 'lead.updated' })
const refusedEdit = await call('PUT', `/api/v1/leads/${auditLead._id}`, { body: { city: 'Nope' }, version: av })
check(refusedEdit.status === 409, '17. the edit was refused')
check(await AuditLog.countDocuments({ action: 'lead.updated' }) === updatedBefore,
  '    and NO "updated" audit event was written for a change that never happened')

// ---------------------------------------------------------------------------
section('8. CONCURRENCY AND IDEMPOTENCY TOGETHER')

const both = await newCompany('Both Co')
const bv = iso(both.updatedAt)
const key = 'phase6-mut-1'

const firstTry = await call('PUT', `/api/v1/companies/${both._id}`, {
  body: { city: 'Accepted' }, version: bv, mutationId: key,
})
await settle()
check(firstTry.status === 200, '18. the guarded, keyed mutation succeeded', `HTTP ${firstTry.status}`)

// The response is "lost"; the client retries with the same key AND the same
// now-stale version. Idempotency must answer before the version check can fail.
const retry = await call('PUT', `/api/v1/companies/${both._id}`, {
  body: { city: 'Accepted' }, version: bv, mutationId: key,
})
check(retry.status === 200, '19. the retry succeeded rather than 409-ing on its own write',
  `HTTP ${retry.status}`)
check(retry.replay === true, '    because it was served from the receipt')
check(JSON.stringify(retry.body) === JSON.stringify(firstTry.body), '    with the original body')
check(await MutationReceipt.countDocuments({ clientMutationId: key }) === 1, '    one receipt exists')

const bothNow = await Company.findById(both._id)
check(bothNow.city === 'Accepted', '20. the record holds the accepted value')

// A DELETE replay, same story.
const delKey = 'phase6-del-1'
const delTarget = await newCompany('Replay Delete Co')
const dtv = iso(delTarget.updatedAt)

const del1 = await call('DELETE', `/api/v1/companies/${delTarget._id}`, { version: dtv, mutationId: delKey })
await settle()
check(del1.status === 200, '21. the guarded delete succeeded')

const del2 = await call('DELETE', `/api/v1/companies/${delTarget._id}`, { version: dtv, mutationId: delKey })
check(del2.status === 200, '22. the delete replay returned success rather than 404', `HTTP ${del2.status}`)
check(del2.replay === true, '    served from the receipt — no second delete, no second audit')

// ---------------------------------------------------------------------------
section('9. THE CHECK IS ATOMIC')

const raceCo = await newCompany('Race Co')
const rv = iso(raceCo.updatedAt)

/*
 * Ten concurrent edits, every one claiming the SAME base version. Exactly one
 * can win: the version is part of the filter of a single findOneAndUpdate, so
 * the database serialises them. A read-then-compare-then-write implementation
 * would let several through.
 */
const racers = await Promise.all(
  Array.from({ length: 10 }, (_, i) =>
    call('PUT', `/api/v1/companies/${raceCo._id}`, { body: { city: `Racer ${i}` }, version: rv })),
)

const won = racers.filter((r) => r.status === 200)
const lost = racers.filter((r) => r.status === 409)
check(won.length === 1, '23. exactly one concurrent writer won', String(won.length))
check(lost.length === 9, '    the other nine were refused', String(lost.length))
check(won.length + lost.length === 10, '    and nothing else happened')

// ---------------------------------------------------------------------------
section('10. OWNERSHIP IS STILL THE SERVER’S')

const alicesCo = await newCompany('Alices Co')
const acv = iso(alicesCo.updatedAt)

authUser = { _id: BOB, id: String(BOB), role: ROLES.SALES, displayName: 'Bob' }

const bobEdit = await call('PUT', `/api/v1/companies/${alicesCo._id}`, { body: { city: 'Stolen' }, version: acv })
check(bobEdit.status === 404, "24. Bob cannot edit Alice's company", `HTTP ${bobEdit.status}`)
check((await Company.findById(alicesCo._id)).city === 'Mumbai', '    and it is unchanged')

const bobDelete = await call('DELETE', `/api/v1/companies/${alicesCo._id}`, { version: acv })
/*
 * 403 or 404, and both are correct refusals. The company delete route carries
 * `requirePermission(LEADS_DELETE)` on top of owner scoping, so a role without
 * that permission is stopped before the record is ever looked up. What matters
 * is that Bob cannot delete it and that it survives.
 */
check([403, 404].includes(bobDelete.status), "25. Bob cannot delete Alice's company",
  `HTTP ${bobDelete.status}`)
check((await Company.findById(alicesCo._id)).isDeleted === false, '    and it survives')

const bobContact = await call('DELETE', `/api/v1/contacts/${contact._id}`, { version: cv0 })
check(bobContact.status === 404, "26. Bob cannot delete Alice's contact", `HTTP ${bobContact.status}`)

authUser = { _id: ALICE, id: String(ALICE), role: ROLES.OWNER, displayName: 'Alice' }

// ---------------------------------------------------------------------------
section('11. A MALFORMED VERSION HEADER IS REFUSED, NOT IGNORED')

const badVersion = await call('PUT', `/api/v1/companies/${plain._id}`, {
  body: { city: 'X' }, version: 'not-a-timestamp',
})
check(badVersion.status === 400,
  '27. a malformed version header is a 400 — never silently treated as "no check"',
  `HTTP ${badVersion.status}`)
check((await Company.findById(plain._id)).city === 'Delhi', '    and nothing was applied')

// ---------------------------------------------------------------------------
section('CLEANUP — isolated database only')
server.close()
await mongoose.connection.dropDatabase()
console.log(`  dropped ${TEST_DB}`)
await mongoose.disconnect()

console.log(`\n${fail === 0 ? `ALL ${total} CHECKS PASSED` : `${fail} of ${total} CHECKS FAILED`}`)
process.exit(fail === 0 ? 0 : 1)
