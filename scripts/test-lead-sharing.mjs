/**
 * Lead sharing: who gains access, and — more importantly — who does not.
 *
 * The feature grants read and edit on one enquiry to named colleagues. The
 * assertions that matter most here are the negative ones: a shared user must
 * not be able to delete the enquiry, must not be able to re-share it, and an
 * unshared user must see nothing at all.
 *
 * Runs the real handlers and the real `buildLeadFilter` with the models
 * intercepted, so what is asserted is the query each one actually builds rather
 * than a restatement of it.
 *
 * Nothing here touches a database.
 */

const B = new URL('../src', import.meta.url).href
const { Lead } = await import(`${B}/models/lead.model.js`)
const { Company } = await import(`${B}/models/company.model.js`)
const { Contact } = await import(`${B}/models/contact.model.js`)
const { User } = await import(`${B}/models/user.model.js`)
const { AuditLog } = await import(`${B}/models/auditLog.model.js`)
const { SyncTombstone } = await import(`${B}/models/syncTombstone.model.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)
const { USER_STATUS } = await import(`${B}/constants/userStatus.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

const MANAGER = '000000000000000000000a01'   // owns the enquiry
const USER_B = '000000000000000000000b01'    // shared
const USER_C = '000000000000000000000c01'    // shared, later removed
const USER_D = '000000000000000000000d01'    // never shared
const ORG_OWNER = '000000000000000000000e01'  // role: owner
const INACTIVE = '000000000000000000000f01'   // suspended account
const LEAD_ID = '000000000000000000001111'
const COMPANY_ID = '000000000000000000003333'
const CONTACT_ID = '000000000000000000002222'
const REFERENCE = 'XAMP1687'

let rows = []
let people = []
let audits = []
let deleteCalls = []
let findQueries = []
let companyWrites = []
let contactWrites = []

function reset({ sharedWith = [] } = {}) {
  rows = [{
    _id: LEAD_ID,
    owner: MANAGER,
    reference: REFERENCE,
    stage: 'active',
    market: 'AU',
    isDeleted: false,
    company: COMPANY_ID,
    contact: CONTACT_ID,
    sharedWith: [...sharedWith],
    internalNotes: 'original',
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  }]
  people = [
    { _id: MANAGER, displayName: 'Manager A', email: 'a@x.com', role: ROLES.MANAGER, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: USER_B, displayName: 'Rahul', email: 'b@x.com', role: ROLES.SALES, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: USER_C, displayName: 'Priya', email: 'c@x.com', role: ROLES.SALES, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: USER_D, displayName: 'Amit', email: 'd@x.com', role: ROLES.SALES, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: INACTIVE, displayName: 'Neha', email: 'f@x.com', role: ROLES.SALES, status: 'suspended', userPanelAccess: true },
  ]
  audits = []
  deleteCalls = []
  findQueries = []
  companyWrites = []
  contactWrites = []
}

/** Matches a row against a filter, including the `$or` the new scopes use. */
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((clause) => matches(row, clause))
    if (key === '$and') return value.every((clause) => matches(row, clause))
    if (key === 'sharedWith') return (row.sharedWith ?? []).some((id) => String(id) === String(value))
    if (value && typeof value === 'object' && '$in' in value) {
      return value.$in.some((c) => String(c) === String(row[key]))
    }
    if (value && typeof value === 'object' && '$ne' in value) {
      return String(row[key]) !== String(value.$ne)
    }
    return String(row[key]) === String(value)
  })
}

const wrapLead = (row) => {
  if (!row) return null
  const doc = { ...row }
  doc.save = async () => { Object.assign(row, doc); return doc }
  doc.moveToStage = () => {}
  doc.isCampaignEligible = () => true
  doc.ageInDays = () => 1
  doc.toPublicJSON = () => ({
    id: String(doc._id),
    reference: doc.reference,
    sharedWith: (doc.sharedWith ?? []).map(String),
  })
  doc.toSummaryJSON = () => ({ id: String(doc._id), reference: doc.reference })
  return doc
}

Lead.findOne = async (filter) => {
  findQueries.push(filter)
  return wrapLead(rows.find((row) => matches(row, filter)))
}
Lead.deleteOne = async (filter) => {
  deleteCalls.push(filter)
  const before = rows.length
  rows = rows.filter((row) => !matches(row, filter))
  return { deletedCount: before - rows.length }
}
Lead.exists = async (filter) => {
  const hit = rows.find((row) => matches(row, filter))
  return hit ? { _id: hit._id } : null
}

User.find = (filter) => {
  const found = people.filter((row) => matches(row, filter))
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: async () => found,
    then: (res, rej) => Promise.resolve(found).then(res, rej),
  }
  return chain
}
User.findById = (id) => {
  const found = people.find((row) => String(row._id) === String(id)) ?? null
  const chain = { select: () => chain, lean: async () => found, then: (r, j) => Promise.resolve(found).then(r, j) }
  return chain
}

Company.findById = async (id) => {
  if (String(id) !== COMPANY_ID) return null
  return {
    _id: COMPANY_ID,
    companyName: 'Acme',
    toPublicJSON: () => ({ id: COMPANY_ID }),
    recount: async () => { companyWrites.push('recount'); return { leadCount: 0 } },
  }
}
Company.deleteOne = async () => { throw new Error('Company must never be deleted by sharing') }
Company.updateOne = async () => { companyWrites.push('update'); return {} }
Contact.findById = async () => ({ _id: CONTACT_ID, toPublicJSON: () => ({ id: CONTACT_ID }) })
Contact.deleteOne = async () => { throw new Error('Contact must never be deleted by sharing') }
Contact.updateOne = async () => { contactWrites.push('update'); return {} }

SyncTombstone.insertMany = async (d) => d
SyncTombstone.create = async (d) => d
AuditLog.record = async (entry) => { audits.push(entry); return entry }

const controller = await import(`${B}/modules/leads/controllers/lead.controller.js`)
const { buildLeadFilter } = await import(`${B}/modules/leads/services/lead.service.js`)

/** Invokes a handler and waits for its own promise chain to settle. */
async function call(handler, { userId, role = ROLES.SALES, params = {}, body = {}, query = {} }) {
  const req = {
    params, body, query,
    method: 'POST',
    originalUrl: '/api/v1/leads',
    ip: '127.0.0.1',
    get: () => null,
    auth: { isAuthenticated: true, user: { _id: userId, role }, session: { _id: 's' } },
  }
  let payload = null
  const res = { status: () => res, json: (v) => { payload = v; return res } }
  let refusal = null

  handler(req, res, (error) => { refusal = error })
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r))

  if (refusal) return { ok: false, status: refusal.statusCode ?? refusal.status ?? null, message: refusal.message }
  return { ok: true, payload }
}

const asManager = { userId: MANAGER, role: ROLES.MANAGER }
const asB = { userId: USER_B, role: ROLES.SALES }
const asC = { userId: USER_C, role: ROLES.SALES }
const asD = { userId: USER_D, role: ROLES.SALES }
const asOrgOwner = { userId: ORG_OWNER, role: ROLES.OWNER }
const P = { params: { id: LEAD_ID } }

// ---------------------------------------------------------------------------

console.log('\n1. The filter is untouched for every existing caller')
{
  const before = buildLeadFilter({ owner: MANAGER })
  check('no viewer → plain { owner, isDeleted }',
    JSON.stringify(before) === JSON.stringify({ owner: MANAGER, isDeleted: false }),
    JSON.stringify(before))
  check('no $or is introduced', before.$or === undefined)
  check('no $and is introduced', before.$and === undefined)

  const exported = buildLeadFilter({ owner: MANAGER, stage: 'active', search: 'acme' })
  check('export/audience shape unchanged (owner still top-level)', String(exported.owner) === MANAGER)
  check('search still owns $or', Array.isArray(exported.$or) && exported.$or.length === 5)
}

console.log('\n2. With a viewer, access and search compose instead of colliding')
{
  const f = buildLeadFilter({ owner: USER_B, viewer: USER_B, search: 'acme' })
  check('access lives in $and', Array.isArray(f.$and) && f.$and.length === 1)
  check('access is owner OR sharedWith', JSON.stringify(f.$and[0]) ===
    JSON.stringify({ $or: [{ owner: USER_B }, { sharedWith: USER_B }] }), JSON.stringify(f.$and[0]))
  check('search still owns its own $or', Array.isArray(f.$or) && f.$or.length === 5)
  check('no top-level owner that would exclude shared rows', f.owner === undefined)
  check('isDeleted still applied', f.isDeleted === false)
}

console.log('\n3. Owner behaviour is unchanged — sees and edits their own enquiry')
reset()
{
  const r = await call(controller.getById, { ...asManager, ...P })
  check('owner opens their enquiry', r.ok, r.ok ? '' : r.message)
  check('canEdit true', r.payload?.data?.canEdit === true)
  check('canShare true', r.payload?.data?.canShare === true)

  const u = await call(controller.update, { ...asManager, ...P, body: { internalNotes: 'by owner' } })
  check('owner updates it', u.ok, u.ok ? '' : u.message)
  check('the note was written', rows[0].internalNotes === 'by owner')
}

console.log('\n4. Manager shares with ONE user')
reset()
{
  const r = await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B] } })
  check('the save succeeds', r.ok, r.ok ? '' : r.message)
  check('one grant stored', rows[0].sharedWith.length === 1, JSON.stringify(rows[0].sharedWith))
  check('it names the right user', String(rows[0].sharedWith[0]) === USER_B)
  check('owner is unchanged', String(rows[0].owner) === MANAGER)
}

console.log('\n5. Manager shares with MULTIPLE users')
reset()
{
  const r = await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B, USER_C] } })
  check('the save succeeds', r.ok, r.ok ? '' : r.message)
  check('two grants stored', rows[0].sharedWith.length === 2, JSON.stringify(rows[0].sharedWith))
  check('owner still unchanged', String(rows[0].owner) === MANAGER)
}

console.log('\n6. Duplicates and the owner are never stored')
reset()
{
  await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B, USER_B, USER_C, MANAGER] } })
  check('duplicates collapsed', rows[0].sharedWith.length === 2, JSON.stringify(rows[0].sharedWith))
  check('the owner is not in their own share list',
    rows[0].sharedWith.every((id) => String(id) !== MANAGER))
}

console.log('\n7. A shared user can SEE the enquiry in the register')
reset({ sharedWith: [USER_B] })
{
  const f = buildLeadFilter({ owner: USER_B, viewer: USER_B })
  check('the shared enquiry matches the register filter', matches(rows[0], f))

  const unshared = buildLeadFilter({ owner: USER_D, viewer: USER_D })
  check('it does NOT match an unshared user’s filter', matches(rows[0], unshared) === false)
}

console.log('\n8. A shared user can OPEN and EDIT it')
reset({ sharedWith: [USER_B] })
{
  const r = await call(controller.getById, { ...asB, ...P })
  check('shared user opens it', r.ok, r.ok ? '' : r.message)
  check('canEdit is true for them', r.payload?.data?.canEdit === true)
  check('canShare is FALSE for them', r.payload?.data?.canShare === false,
    String(r.payload?.data?.canShare))

  const u = await call(controller.update, { ...asB, ...P, body: { internalNotes: 'by shared user' } })
  check('shared user updates it', u.ok, u.ok ? '' : u.message)
  check('the note was written', rows[0].internalNotes === 'by shared user')
  check('ownership survived the edit', String(rows[0].owner) === MANAGER)
}

console.log('\n9. An UNSHARED user is refused everywhere')
reset({ sharedWith: [USER_B] })
{
  const g = await call(controller.getById, { ...asD, ...P })
  check('GET refused', !g.ok, g.ok ? 'IT WAS ALLOWED' : `${g.status}`)
  check('404, not 403', g.status === 404, String(g.status))

  const u = await call(controller.update, { ...asD, ...P, body: { internalNotes: 'hijack' } })
  check('PUT refused', !u.ok, u.ok ? 'IT WAS ALLOWED' : `${u.status}`)
  check('404 on update too', u.status === 404, String(u.status))
  check('nothing was written', rows[0].internalNotes === 'original', rows[0].internalNotes)
}

console.log('\n10. SHARING DOES NOT GRANT DELETE')
reset({ sharedWith: [USER_B] })
{
  const d = await call(controller.remove, { ...asB, ...P })
  check('a shared user is refused deletion', !d.ok, d.ok ? 'IT WAS ALLOWED' : `${d.status}`)
  check('404', d.status === 404, String(d.status))
  check('deleteOne was never called', deleteCalls.length === 0, `${deleteCalls.length}`)
  check('the enquiry survives', rows.length === 1)

  // And the query it built never mentioned sharedWith at all.
  const deleteScope = findQueries[findQueries.length - 1]
  check('the delete scope is owner-only', String(deleteScope?.owner) === USER_B, JSON.stringify(deleteScope))
  check('the delete scope has no sharedWith clause',
    JSON.stringify(deleteScope).includes('sharedWith') === false, JSON.stringify(deleteScope))
}

console.log('\n11. The owner can still delete, exactly as before')
reset({ sharedWith: [USER_B] })
{
  const d = await call(controller.remove, { ...asManager, ...P })
  check('the owner deletes it', d.ok, d.ok ? '' : d.message)
  check('it was a hard delete', rows.length === 0, `${rows.length} row(s) remain`)
  check('deleteOne was used once', deleteCalls.length === 1)
}

console.log('\n12. A shared user cannot RE-SHARE (no privilege escalation)')
reset({ sharedWith: [USER_B] })
{
  const r = await call(controller.updateSharing, { ...asB, ...P, body: { userIds: [USER_B, USER_D] } })
  check('refused', !r.ok, r.ok ? 'IT WAS ALLOWED' : `${r.status}`)
  check('403, and it explains why', r.status === 403, String(r.status))
  check('the share list is untouched', rows[0].sharedWith.length === 1)

  const read = await call(controller.getSharing, { ...asB, ...P })
  check('nor may they read the share list', !read.ok, read.ok ? 'IT WAS ALLOWED' : `${read.status}`)
}

console.log('\n13. Adding a user later, and removing one')
reset({ sharedWith: [USER_B, USER_C] })
{
  await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B, USER_C, USER_D] } })
  check('a third user was added', rows[0].sharedWith.length === 3)

  await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B, USER_D] } })
  check('User C was removed', rows[0].sharedWith.length === 2, JSON.stringify(rows[0].sharedWith))
  check('C is gone', rows[0].sharedWith.every((id) => String(id) !== USER_C))
  check('B and D remain', ['b', 'd'].every((k) =>
    rows[0].sharedWith.some((id) => String(id).includes(`0000${k}01`))))
}

console.log('\n14. A removed user loses access immediately')
reset({ sharedWith: [USER_B, USER_C] })
{
  const before = await call(controller.getById, { ...asC, ...P })
  check('C can open it while shared', before.ok)

  await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B] } })

  const after = await call(controller.getById, { ...asC, ...P })
  check('C is refused straight after removal', !after.ok, after.ok ? 'STILL ALLOWED' : `${after.status}`)
  check('404', after.status === 404)

  const edit = await call(controller.update, { ...asC, ...P, body: { internalNotes: 'x' } })
  check('and cannot update either', !edit.ok, edit.ok ? 'STILL ALLOWED' : '')
}

console.log('\n15. Sharing may be cleared entirely')
reset({ sharedWith: [USER_B, USER_C] })
{
  const r = await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [] } })
  check('the save succeeds', r.ok, r.ok ? '' : r.message)
  check('nobody is left', rows[0].sharedWith.length === 0)
  check('the message says so', /no longer shared/i.test(r.payload?.message ?? ''), r.payload?.message)
  check('owner unchanged', String(rows[0].owner) === MANAGER)
}

console.log('\n16. Ineligible users are refused before anything is written')
reset()
{
  const r = await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B, INACTIVE] } })
  check('a suspended account is refused', !r.ok, r.ok ? 'IT WAS ALLOWED' : `${r.status}`)
  check('400', r.status === 400, String(r.status))
  check('nothing was written — not even the valid half', rows[0].sharedWith.length === 0,
    JSON.stringify(rows[0].sharedWith))
}

console.log('\n17. The organization owner keeps their existing access')
reset({ sharedWith: [] })
{
  const g = await call(controller.getById, { ...asOrgOwner, ...P })
  check('org owner opens any enquiry', g.ok, g.ok ? '' : g.message)
  check('and may manage its sharing', g.payload?.data?.canShare === true)

  const s = await call(controller.updateSharing, { ...asOrgOwner, ...P, body: { userIds: [USER_B] } })
  check('org owner can share it', s.ok, s.ok ? '' : s.message)
  check('ownership still not transferred', String(rows[0].owner) === MANAGER)
}

console.log('\n18. Company and contact records are never touched by sharing')
reset()
{
  await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B, USER_C] } })
  check('no company write', companyWrites.length === 0, companyWrites.join(','))
  check('no contact write', contactWrites.length === 0, contactWrites.join(','))
  check('the enquiry still points at its company', String(rows[0].company) === COMPANY_ID)
  check('and at its contact', String(rows[0].contact) === CONTACT_ID)
}

console.log('\n19. The change is audited, naming what moved')
reset({ sharedWith: [USER_C] })
{
  await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B] } })
  const entry = audits[audits.length - 1]
  check('an audit entry was written', audits.length === 1, `${audits.length}`)
  check('action is lead.sharing_updated', entry?.action === 'lead.sharing_updated', String(entry?.action))
  check('it names the addition', entry?.metadata?.added?.includes(USER_B) === true,
    JSON.stringify(entry?.metadata?.added))
  check('it names the removal', entry?.metadata?.removed?.includes(USER_C) === true,
    JSON.stringify(entry?.metadata?.removed))
  check('it records the unchanged owner', String(entry?.metadata?.owner) === MANAGER)
  check('it names the enquiry', entry?.entityName === REFERENCE, String(entry?.entityName))
}

console.log('\n20. Backward compatibility: an enquiry with no sharedWith field')
{
  reset()
  delete rows[0].sharedWith          // exactly how every pre-existing document reads

  const g = await call(controller.getById, { ...asManager, ...P })
  check('the owner still opens it', g.ok, g.ok ? '' : g.message)

  const d = await call(controller.getById, { ...asD, ...P })
  check('an unrelated user is still refused', !d.ok, d.ok ? 'IT WAS ALLOWED' : '')

  const f = buildLeadFilter({ owner: MANAGER, viewer: MANAGER })
  check('it still matches its owner’s register', matches(rows[0], f))

  const other = buildLeadFilter({ owner: USER_D, viewer: USER_D })
  check('and is invisible to everybody else', matches(rows[0], other) === false)
}

console.log('\n21. The shareable-users list is eligible people only')
reset()
{
  const r = await call(controller.shareableUsers, { ...asManager })
  const ids = (r.payload?.data?.items ?? []).map((u) => String(u.id))
  check('the list loads', r.ok, r.ok ? '' : r.message)
  check('the suspended account is absent', ids.includes(INACTIVE) === false, ids.join(','))
  check('the caller is absent from their own list', ids.includes(MANAGER) === false)
  check('eligible colleagues are present', ids.includes(USER_B) && ids.includes(USER_D))
  check('it carries no role or status', Object.keys(r.payload?.data?.items?.[0] ?? {}).sort().join(',') === 'email,id,name',
    Object.keys(r.payload?.data?.items?.[0] ?? {}).join(','))
}

console.log('\n22. The owner can read the current share list')
reset({ sharedWith: [USER_B, USER_C] })
{
  const r = await call(controller.getSharing, { ...asManager, ...P })
  check('it loads', r.ok, r.ok ? '' : r.message)
  check('it names both users', (r.payload?.data?.items ?? []).length === 2,
    String((r.payload?.data?.items ?? []).length))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
