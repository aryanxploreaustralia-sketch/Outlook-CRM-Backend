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
const INACTIVE = '000000000000000000000f01'   // suspended — must still be offered
const ADMIN_U = '0000000000000000000a0001'    // role: admin
const INVITED = '0000000000000000000a0002'    // created, never signed in
const NO_PANEL = '0000000000000000000a0003'   // userPanelAccess: false
const DISABLED_U = '0000000000000000000a0004' // status: disabled
const OTHER_DEPT = '0000000000000000000a0005' // different department
const EXTRA_1 = '0000000000000000000a0006'
const EXTRA_2 = '0000000000000000000a0007'
const EXTRA_3 = '0000000000000000000a0008'
const DELETED_U = '0000000000000000000a0009'  // isDeleted — the ONLY exclusion
const LEAD_ID = '000000000000000000001111'
const COMPANY_ID = '000000000000000000003333'
const CONTACT_ID = '000000000000000000002222'
const REFERENCE = 'XAMP1687'

let rows = []
let people = []
let audits = []
let deleteCalls = []
let findQueries = []
let updateManyCalls = []
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
    { _id: ORG_OWNER, displayName: 'Owner O', email: 'o@x.com', role: ROLES.OWNER, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: ADMIN_U, displayName: 'Admin Ay', email: 'admin@x.com', role: ROLES.ADMIN, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: INVITED, displayName: 'Invited Ish', email: 'inv@x.com', role: ROLES.SALES, status: 'invited', userPanelAccess: true },
    { _id: NO_PANEL, displayName: 'Console Cara', email: 'cc@x.com', role: ROLES.ADMIN, status: USER_STATUS.ACTIVE, userPanelAccess: false },
    { _id: DISABLED_U, displayName: 'Disabled Dev', email: 'dd@x.com', role: ROLES.SUPPORT, status: 'disabled', userPanelAccess: true },
    { _id: OTHER_DEPT, displayName: 'Finance Fay', email: 'ff@x.com', role: ROLES.VIEWER, status: USER_STATUS.ACTIVE, userPanelAccess: true, department: 'Finance' },
    { _id: EXTRA_1, displayName: 'Extra One', email: 'e1@x.com', role: ROLES.SUPPORT, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: EXTRA_2, displayName: 'Extra Two', email: 'e2@x.com', role: ROLES.VIEWER, status: 'invited', userPanelAccess: false },
    { _id: EXTRA_3, displayName: 'Extra Three', email: 'e3@x.com', role: ROLES.MEMBER, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    // The one account that must NEVER be offered or accepted.
    { _id: DELETED_U, displayName: 'Deleted Dan', email: 'del@x.com', role: ROLES.SALES, status: 'disabled', userPanelAccess: true, isDeleted: true },
  ]
  audits = []
  deleteCalls = []
  findQueries = []
  updateManyCalls = []
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

/*
 * The two operations bulk sharing uses, behaving as the driver does.
 *
 * `updateMany` applies `$addToSet` with `$each` to every matching row and
 * reports `modifiedCount` — the number of documents that actually changed,
 * which is not the number matched when somebody is already shared.
 */
Lead.countDocuments = async (filter) => rows.filter((row) => matches(row, filter)).length
/** `distinct` over an array field: every unique member across matching rows. */
Lead.distinct = async (field, filter) => {
  const seen = new Set()
  for (const row of rows) {
    if (!matches(row, filter)) continue
    for (const value of row[field] ?? []) seen.add(String(value))
  }
  return [...seen]
}
Lead.updateMany = async (filter, update) => {
  updateManyCalls.push({ filter, update })

  const each = update?.$addToSet?.sharedWith?.$each ?? []
  const pull = update?.$pull?.sharedWith?.$in ?? []
  let modified = 0

  for (const row of rows) {
    if (!matches(row, filter)) continue

    const before = (row.sharedWith ?? []).map(String)
    let after = [...before]

    // $addToSet: add what is missing, never twice.
    for (const id of each) if (!after.includes(String(id))) after.push(String(id))

    // $pull with $in: drop every named id, leaving the rest in place.
    if (pull.length > 0) {
      const drop = new Set(pull.map(String))
      after = after.filter((id) => !drop.has(String(id)))
    }

    if (after.length !== before.length) {
      row.sharedWith = after
      modified += 1
    }
  }

  return { matchedCount: rows.filter((row) => matches(row, filter)).length, modifiedCount: modified }
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

console.log('\n16. Only a deleted or non-existent account is refused')
reset()
{
  // A suspended colleague is still a colleague. Sharing with them is allowed;
  // what they can do on opening the enquiry is the ordinary guards' business.
  const ok = await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B, INACTIVE] } })
  check('a suspended account is accepted', ok.ok, ok.ok ? '' : ok.message)
  check('both grants were stored', rows[0].sharedWith.length === 2, JSON.stringify(rows[0].sharedWith))

  reset()
  const bad = await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B, DELETED_U] } })
  check('a deleted account IS refused', !bad.ok, bad.ok ? 'IT WAS ALLOWED' : `${bad.status}`)
  check('400', bad.status === 400, String(bad.status))
  check('nothing was written — not even the valid half', rows[0].sharedWith.length === 0,
    JSON.stringify(rows[0].sharedWith))

  reset()
  const gone = await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: ['0000000000000000000affff'] } })
  check('an id matching no user is refused', !gone.ok, gone.ok ? 'IT WAS ALLOWED' : `${gone.status}`)

  const malformed = await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: ['not-an-id'] } })
  check('a malformed id is rejected by the schema', !malformed.ok,
    malformed.ok ? 'IT WAS ALLOWED' : `${malformed.status}`)
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

console.log('\n21. The recipient list is EVERY CRM user, minus deleted accounts')
reset()
{
  const r = await call(controller.shareableUsers, { ...asManager })
  const items = r.payload?.data?.items ?? []
  const ids = items.map((u) => String(u.id))

  check('the list loads', r.ok, r.ok ? '' : r.message)

  // --- no role filter -----------------------------------------------------
  check('SALES users appear', ids.includes(USER_B) && ids.includes(USER_C) && ids.includes(USER_D))
  check('OWNER users appear', ids.includes(ORG_OWNER), ids.join(','))
  check('ADMIN users appear', ids.includes(ADMIN_U))
  check('SUPPORT users appear', ids.includes(EXTRA_1))
  check('VIEWER users appear', ids.includes(OTHER_DEPT))
  check('MEMBER users appear', ids.includes(EXTRA_3))

  // --- no status filter ---------------------------------------------------
  check('suspended accounts appear', ids.includes(INACTIVE))
  check('invited (never signed in) accounts appear', ids.includes(INVITED))
  check('disabled accounts appear', ids.includes(DISABLED_U))

  // --- no userPanelAccess filter ------------------------------------------
  check('userPanelAccess:false accounts appear', ids.includes(NO_PANEL))
  check('a second no-panel, invited account appears', ids.includes(EXTRA_2))

  // --- no department filter -----------------------------------------------
  check('another department appears', ids.includes(OTHER_DEPT))

  // --- the only two exclusions --------------------------------------------
  check('the DELETED account is absent', ids.includes(DELETED_U) === false, ids.join(','))
  check('the caller is absent from their own list', ids.includes(MANAGER) === false)

  // --- completeness -------------------------------------------------------
  check('MORE THAN 7 users are returned', ids.length > 7, ids.length + ' returned')
  check('every non-deleted user except the caller is present',
    ids.length === people.filter((u) => u.isDeleted !== true && String(u._id) !== MANAGER).length,
    ids.length + ' of ' + people.length + ' fixture users')

  // --- payload shape ------------------------------------------------------
  check('only id, name and email are returned',
    Object.keys(items[0] ?? {}).sort().join(',') === 'email,id,name',
    Object.keys(items[0] ?? {}).join(','))
  check('no sensitive field leaks',
    items.every((u) => !('password' in u) && !('googleId' in u) && !('role' in u) &&
      !('status' in u) && !('userPanelAccess' in u) && !('refreshToken' in u)))
}

console.log('\n21b. A sales user sees the same complete list')
reset()
{
  const r = await call(controller.shareableUsers, { ...asB })
  const ids = (r.payload?.data?.items ?? []).map((u) => String(u.id))
  check('more than 7 for them too', ids.length > 7, String(ids.length))
  check('the manager appears in their list', ids.includes(MANAGER))
  check('they are absent from their own list', ids.includes(USER_B) === false)
  check('the deleted account is still absent', ids.includes(DELETED_U) === false)
}

console.log('\n22. The owner can read the current share list')
reset({ sharedWith: [USER_B, USER_C] })
{
  const r = await call(controller.getSharing, { ...asManager, ...P })
  check('it loads', r.ok, r.ok ? '' : r.message)
  check('it names both users', (r.payload?.data?.items ?? []).length === 2,
    String((r.payload?.data?.items ?? []).length))
}

// ---------------------------------------------------------------------------
// Bulk sharing — the whole register at once
// ---------------------------------------------------------------------------

/** Our two live enquiries, one deleted one of ours, and another owner's. */
function seedRegister() {
  reset()
  rows.push({
    _id: '00000000000000000000bbbb', owner: MANAGER, reference: 'XAMP1688',
    stage: 'active', market: 'AU', isDeleted: false, company: COMPANY_ID,
    contact: CONTACT_ID, sharedWith: [],
  })
  // Ours, but deleted — must never be touched.
  rows.push({
    _id: '00000000000000000000dddd', owner: MANAGER, reference: 'XAMP1689',
    stage: 'active', market: 'AU', isDeleted: true, company: null,
    contact: null, sharedWith: [],
  })
  // Another manager's enquiry — must never be touched.
  rows.push({
    _id: '00000000000000000000cccc', owner: ORG_OWNER, reference: 'XNMP0001',
    stage: 'active', market: 'NZ', isDeleted: false, company: null,
    contact: null, sharedWith: [],
  })
}

const mine = () => rows.filter((r) => String(r.owner) === MANAGER && r.isDeleted === false)
const foreign = () => rows.find((r) => String(r._id) === '00000000000000000000cccc')
const deletedOne = () => rows.find((r) => String(r._id) === '00000000000000000000dddd')

console.log('\n23. A manager bulk-shares every enquiry they own')
seedRegister()
{
  const r = await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  check('the operation succeeds', r.ok, r.ok ? '' : r.message)
  check('both live enquiries were shared', mine().every((l) => l.sharedWith.length === 2),
    JSON.stringify(mine().map((l) => l.sharedWith.length)))
  check('updatedCount is the owner-scoped total', r.payload?.data?.updatedCount === 2,
    String(r.payload?.data?.updatedCount))
  check('it reports the users', (r.payload?.data?.userIds ?? []).length === 2)
  check('the message names both numbers',
    /2 lead\(s\) shared with 2 user\(s\)/.test(r.payload?.message ?? ''), r.payload?.message)
}

console.log('\n24. The update is scoped to the caller and to live enquiries')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B] } })
  const { filter, update } = updateManyCalls[0] ?? {}
  check('updateMany was called once', updateManyCalls.length === 1, String(updateManyCalls.length))
  check('scoped to the authenticated owner', String(filter?.owner) === MANAGER, JSON.stringify(filter))
  check('scoped to isDeleted: false', filter?.isDeleted === false, JSON.stringify(filter))
  check('the filter contains nothing else',
    Object.keys(filter ?? {}).sort().join(',') === 'isDeleted,owner', Object.keys(filter ?? {}).join(','))
  check('it uses $addToSet + $each', Boolean(update?.$addToSet?.sharedWith?.$each), JSON.stringify(update))
  check('the update writes no field but sharedWith',
    Object.keys(update ?? {}).join(',') === '$addToSet' &&
    Object.keys(update?.$addToSet ?? {}).join(',') === 'sharedWith', JSON.stringify(update))
}

console.log('\n25. Another manager’s enquiries are never modified')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  check('the foreign enquiry is untouched', (foreign().sharedWith ?? []).length === 0,
    JSON.stringify(foreign().sharedWith))
  check('its owner is unchanged', String(foreign().owner) === ORG_OWNER)
}

console.log('\n26. Deleted enquiries are never modified')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B] } })
  check('the soft-deleted enquiry is untouched', (deletedOne().sharedWith ?? []).length === 0,
    JSON.stringify(deletedOne().sharedWith))
  check('it is still deleted', deletedOne().isDeleted === true)
}

console.log('\n27. Existing shared users are preserved, never overwritten')
seedRegister()
{
  rows[0].sharedWith = [USER_D]
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B] } })

  const ids = rows[0].sharedWith.map(String)
  check('the pre-existing grant survives', ids.includes(USER_D), JSON.stringify(ids))
  check('the new grant was added', ids.includes(USER_B), JSON.stringify(ids))
  check('both are present', ids.length === 2, String(ids.length))
}

console.log('\n28. Running it twice is idempotent')
seedRegister()
{
  const first = await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  const snapshot = JSON.stringify(mine().map((l) => [...l.sharedWith].map(String).sort()))

  const second = await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  check('the second run succeeds', second.ok, second.ok ? '' : second.message)
  check('nothing changed the second time',
    JSON.stringify(mine().map((l) => [...l.sharedWith].map(String).sort())) === snapshot)
  check('no duplicate ids anywhere',
    mine().every((l) => new Set(l.sharedWith.map(String)).size === l.sharedWith.length))
  check('modifiedCount is 0 on the repeat', second.payload?.data?.modifiedCount === 0,
    String(second.payload?.data?.modifiedCount))
  check('updatedCount still reports coverage',
    second.payload?.data?.updatedCount === first.payload?.data?.updatedCount)
}

console.log('\n29. Duplicates in the request, and the owner, are dropped')
seedRegister()
{
  const r = await call(controller.bulkShare, {
    ...asManager, body: { userIds: [USER_B, USER_B, USER_C, MANAGER] },
  })
  check('the operation succeeds', r.ok, r.ok ? '' : r.message)
  check('two recipients, not four', (r.payload?.data?.userIds ?? []).length === 2,
    JSON.stringify(r.payload?.data?.userIds))
  check('the owner is not among them',
    (r.payload?.data?.userIds ?? []).every((id) => String(id) !== MANAGER))
  check('no enquiry lists the owner as shared',
    mine().every((l) => l.sharedWith.every((id) => String(id) !== MANAGER)))
}

console.log('\n30. Ownership is never changed by a bulk share')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  check('every enquiry keeps its owner', mine().every((l) => String(l.owner) === MANAGER))
  check('the foreign enquiry keeps its owner', String(foreign().owner) === ORG_OWNER)
}

console.log('\n31. A non-manager cannot bulk-share')
seedRegister()
{
  const r = await call(controller.bulkShare, { ...asB, body: { userIds: [USER_C] } })
  check('a sales user is refused', !r.ok, r.ok ? 'IT WAS ALLOWED' : `${r.status}`)
  check('403', r.status === 403, String(r.status))
  check('updateMany was never called', updateManyCalls.length === 0, String(updateManyCalls.length))
  check('nothing was shared', mine().every((l) => l.sharedWith.length === 0))
}

console.log('\n32. A shared user cannot bulk-share someone else’s register')
seedRegister()
{
  rows[0].sharedWith = [USER_B]
  const r = await call(controller.bulkShare, { ...asB, body: { userIds: [USER_D] } })
  check('refused', !r.ok, r.ok ? 'IT WAS ALLOWED' : `${r.status}`)
  check('the manager’s enquiry is unchanged', rows[0].sharedWith.length === 1,
    JSON.stringify(rows[0].sharedWith))
  check('User D gained nothing', rows[0].sharedWith.every((id) => String(id) !== USER_D))
}

console.log('\n33. Bulk: every role may receive; only a deleted account is refused')
seedRegister()
{
  const r = await call(controller.bulkShare, {
    ...asManager,
    body: { userIds: [USER_B, INACTIVE, ADMIN_U, INVITED, NO_PANEL, DISABLED_U, OTHER_DEPT, EXTRA_1, EXTRA_3] },
  })
  check('nine recipients across every role and status are accepted', r.ok, r.ok ? '' : r.message)
  check('all nine were applied', mine().every((l) => l.sharedWith.length === 9),
    JSON.stringify(mine().map((l) => l.sharedWith.length)))
  check('more than 7 recipients in one operation', (r.payload?.data?.userIds ?? []).length > 7,
    String((r.payload?.data?.userIds ?? []).length))

  seedRegister()
  const bad = await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, DELETED_U] } })
  check('a deleted account IS refused', !bad.ok, bad.ok ? 'IT WAS ALLOWED' : String(bad.status))
  check('400', bad.status === 400, String(bad.status))
  check('updateMany was never called', updateManyCalls.length === 0)
  check('not even the valid half was applied', mine().every((l) => l.sharedWith.length === 0))
}

console.log('\n34. An empty selection is refused')
seedRegister()
{
  const r = await call(controller.bulkShare, { ...asManager, body: { userIds: [] } })
  check('refused', !r.ok, r.ok ? 'IT WAS ALLOWED' : `${r.status}`)
  check('400', r.status === 400, String(r.status))
  check('nothing was written', updateManyCalls.length === 0)

  const onlyOwner = await call(controller.bulkShare, { ...asManager, body: { userIds: [MANAGER] } })
  check('a selection of just the owner is refused too', !onlyOwner.ok,
    onlyOwner.ok ? 'IT WAS ALLOWED' : `${onlyOwner.status}`)
}

console.log('\n35. The org owner may bulk-share their own register only')
seedRegister()
{
  const r = await call(controller.bulkShare, { ...asOrgOwner, body: { userIds: [USER_B] } })
  check('the operation succeeds', r.ok, r.ok ? '' : r.message)
  check('their own enquiry was shared', (foreign().sharedWith ?? []).length === 1,
    JSON.stringify(foreign().sharedWith))
  check('the manager’s enquiries were NOT touched', mine().every((l) => l.sharedWith.length === 0),
    JSON.stringify(mine().map((l) => l.sharedWith.length)))
  check('the scope named the org owner', String(updateManyCalls[0]?.filter?.owner) === ORG_OWNER)
}

console.log('\n36. One audit entry for the whole operation, not one per enquiry')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  check('exactly one audit entry', audits.length === 1, String(audits.length))

  const entry = audits[0]
  check('it reuses lead.sharing_updated', entry?.action === 'lead.sharing_updated', String(entry?.action))
  check('it is marked as bulk', entry?.metadata?.bulk === true)
  check('it names the recipients', (entry?.metadata?.added ?? []).length === 2,
    JSON.stringify(entry?.metadata?.added))
  check('it records how many enquiries matched', entry?.metadata?.matched === 2,
    String(entry?.metadata?.matched))
  check('it records the unchanged owner', String(entry?.metadata?.owner) === MANAGER)
}

console.log('\n37. The preview answers what the dialog needs')
seedRegister()
{
  const asMgr = await call(controller.bulkSharingPreview, { ...asManager })
  check('a manager may bulk-share', asMgr.payload?.data?.canBulkShare === true)
  check('the count is their live owned enquiries only', asMgr.payload?.data?.leadCount === 2,
    String(asMgr.payload?.data?.leadCount))

  const asSales = await call(controller.bulkSharingPreview, { ...asB })
  check('a sales user may not', asSales.payload?.data?.canBulkShare === false)
  check('and is given no count', asSales.payload?.data?.leadCount === 0,
    String(asSales.payload?.data?.leadCount))
}

console.log('\n38. Bulk sharing never touches companies, contacts or deletes')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B] } })
  check('no company write', companyWrites.length === 0, companyWrites.join(','))
  check('no contact write', contactWrites.length === 0, contactWrites.join(','))
  check('no delete was attempted', deleteCalls.length === 0)
}

console.log('\n39. Individual sharing still works alongside bulk')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B] } })
  check('bulk applied to both', mine().every((l) => l.sharedWith.length === 1))

  const r = await call(controller.updateSharing, {
    ...asManager, params: { id: LEAD_ID }, body: { userIds: [USER_C] },
  })
  check('the individual save succeeds', r.ok, r.ok ? '' : r.message)
  check('that one enquiry now lists only C',
    rows[0].sharedWith.map(String).join(',') === USER_C, JSON.stringify(rows[0].sharedWith))
  check('the other enquiry is unaffected by it',
    mine().find((l) => String(l._id) === '00000000000000000000bbbb')
      .sharedWith.map(String).join(',') === USER_B)
  check('ownership unchanged throughout', mine().every((l) => String(l.owner) === MANAGER))
}

// ---------------------------------------------------------------------------
// Revoking — taking shared access back
// ---------------------------------------------------------------------------

console.log('\n40. Individual revoke: unticking one colleague removes only them')
reset({ sharedWith: [USER_B, USER_C, USER_D] })
{
  check('three hold access to begin with', rows[0].sharedWith.length === 3)

  // The dialog saves the desired final set, so "untick C" arrives as B + D.
  const r = await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B, USER_D] } })
  check('the save succeeds', r.ok, r.ok ? '' : r.message)

  const ids = rows[0].sharedWith.map(String)
  check('C lost access', ids.includes(USER_C) === false, JSON.stringify(ids))
  check('B kept access', ids.includes(USER_B))
  check('D kept access', ids.includes(USER_D))
  check('exactly two remain', ids.length === 2, String(ids.length))
  check('the owner never changed', String(rows[0].owner) === MANAGER)
}

console.log('\n41. Individual revoke: clearing every colleague')
reset({ sharedWith: [USER_B, USER_C] })
{
  const r = await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [] } })
  check('the save succeeds', r.ok, r.ok ? '' : r.message)
  check('nobody is left', rows[0].sharedWith.length === 0)
  check('the enquiry still exists', rows.length >= 1)
  check('the owner never changed', String(rows[0].owner) === MANAGER)
}

console.log('\n42. A revoked colleague loses access immediately')
reset({ sharedWith: [USER_B, USER_C] })
{
  const before = await call(controller.getById, { ...asC, ...P })
  check('C can open it while shared', before.ok)

  await call(controller.updateSharing, { ...asManager, ...P, body: { userIds: [USER_B] } })

  const after = await call(controller.getById, { ...asC, ...P })
  check('C is refused straight after', !after.ok, after.ok ? 'STILL ALLOWED' : String(after.status))
  check('404', after.status === 404)
  check('B is unaffected', (await call(controller.getById, { ...asB, ...P })).ok)
}

console.log('\n43. Bulk revoke removes the selected people from every owned enquiry')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C, USER_D] } })
  check('all three were granted first', mine().every((l) => l.sharedWith.length === 3))

  const r = await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  check('the revoke succeeds', r.ok, r.ok ? '' : r.message)
  check('both were removed everywhere',
    mine().every((l) => !l.sharedWith.map(String).includes(USER_B) &&
                        !l.sharedWith.map(String).includes(USER_C)),
    JSON.stringify(mine().map((l) => l.sharedWith)))
  check('the colleague NOT selected keeps access',
    mine().every((l) => l.sharedWith.map(String).includes(USER_D)))
  check('one grant remains per enquiry', mine().every((l) => l.sharedWith.length === 1))
  check('modifiedCount reports the enquiries that changed', r.payload?.data?.modifiedCount === 2,
    String(r.payload?.data?.modifiedCount))
  check('the message uses the real figure',
    /Access removed for 2 user\(s\) from 2 lead\(s\)/.test(r.payload?.message ?? ''), r.payload?.message)
}

console.log('\n44. Bulk revoke uses $pull scoped to the caller and live enquiries')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B] } })
  updateManyCalls.length = 0

  await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [USER_B] } })
  const { filter, update } = updateManyCalls[0] ?? {}

  check('updateMany was called once', updateManyCalls.length === 1, String(updateManyCalls.length))
  check('scoped to the authenticated owner', String(filter?.owner) === MANAGER, JSON.stringify(filter))
  check('scoped to isDeleted: false', filter?.isDeleted === false, JSON.stringify(filter))
  check('the filter contains nothing else',
    Object.keys(filter ?? {}).sort().join(',') === 'isDeleted,owner', Object.keys(filter ?? {}).join(','))
  check('it uses $pull with $in', Array.isArray(update?.$pull?.sharedWith?.$in), JSON.stringify(update))
  check('the update writes no field but sharedWith',
    Object.keys(update ?? {}).join(',') === '$pull' &&
    Object.keys(update?.$pull ?? {}).join(',') === 'sharedWith', JSON.stringify(update))
}

console.log('\n45. Bulk revoke never touches another owner or a deleted enquiry')
seedRegister()
{
  // Give the foreign enquiry and the deleted one the same colleague directly.
  foreign().sharedWith = [USER_B]
  deletedOne().sharedWith = [USER_B]
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B] } })

  const r = await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [USER_B] } })
  check('the revoke succeeds', r.ok, r.ok ? '' : r.message)
  check('our live enquiries lost the grant', mine().every((l) => l.sharedWith.length === 0))
  check('another owner keeps theirs', (foreign().sharedWith ?? []).map(String).includes(USER_B),
    JSON.stringify(foreign().sharedWith))
  check('the deleted enquiry keeps theirs', (deletedOne().sharedWith ?? []).map(String).includes(USER_B),
    JSON.stringify(deletedOne().sharedWith))
  check('the deleted enquiry is still deleted', deletedOne().isDeleted === true)
}

console.log('\n46. Bulk revoke is idempotent')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  const first = await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [USER_B] } })
  const snapshot = JSON.stringify(mine().map((l) => l.sharedWith.map(String)))

  const second = await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [USER_B] } })
  check('the second run succeeds', second.ok, second.ok ? '' : second.message)
  check('nothing changed the second time',
    JSON.stringify(mine().map((l) => l.sharedWith.map(String))) === snapshot)
  check('modifiedCount is 0 on the repeat', second.payload?.data?.modifiedCount === 0,
    String(second.payload?.data?.modifiedCount))
  check('the first run did change things', first.payload?.data?.modifiedCount === 2,
    String(first.payload?.data?.modifiedCount))
  check('C still holds access throughout',
    mine().every((l) => l.sharedWith.map(String).includes(USER_C)))
}

console.log('\n47. Revoking somebody who has no access changes nothing')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B] } })
  const r = await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [USER_D] } })

  check('the call succeeds', r.ok, r.ok ? '' : r.message)
  check('nothing was modified', r.payload?.data?.modifiedCount === 0,
    String(r.payload?.data?.modifiedCount))
  check('the message says so', /None of your enquiries were shared/.test(r.payload?.message ?? ''),
    r.payload?.message)
  check('B still holds access', mine().every((l) => l.sharedWith.map(String).includes(USER_B)))
}

console.log('\n48. Bulk revoke authorization is unchanged from bulk share')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  updateManyCalls.length = 0

  const sales = await call(controller.bulkRevokeSharing, { ...asB, body: { userIds: [USER_C] } })
  check('a sales user is refused', !sales.ok, sales.ok ? 'IT WAS ALLOWED' : String(sales.status))
  check('403', sales.status === 403, String(sales.status))
  check('updateMany was never called', updateManyCalls.length === 0)
  check('nothing was revoked', mine().every((l) => l.sharedWith.length === 2))

  const shared = await call(controller.bulkRevokeSharing, { ...asC, body: { userIds: [USER_B] } })
  check('a shared user is refused too', !shared.ok, shared.ok ? 'IT WAS ALLOWED' : String(shared.status))
}

console.log('\n49. An empty revoke selection is refused')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B] } })
  updateManyCalls.length = 0

  const empty = await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [] } })
  check('refused', !empty.ok, empty.ok ? 'IT WAS ALLOWED' : String(empty.status))
  check('400', empty.status === 400, String(empty.status))
  check('updateMany was never called', updateManyCalls.length === 0)

  const onlyOwner = await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [MANAGER] } })
  check('a selection of just the owner is refused too', !onlyOwner.ok,
    onlyOwner.ok ? 'IT WAS ALLOWED' : String(onlyOwner.status))
  check('B still holds access', mine().every((l) => l.sharedWith.map(String).includes(USER_B)))
}

console.log('\n50. Revoke handles ids that are invalid, unknown, or deleted')
seedRegister()
{
  const malformed = await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: ['not-an-id'] } })
  check('a malformed id is rejected by the schema', !malformed.ok,
    malformed.ok ? 'IT WAS ALLOWED' : String(malformed.status))

  const unknown = await call(controller.bulkRevokeSharing, {
    ...asManager, body: { userIds: ['0000000000000000000affff'] },
  })
  check('an id matching nobody is accepted and removes nothing', unknown.ok,
    unknown.ok ? '' : unknown.message)
  check('nothing was modified', unknown.payload?.data?.modifiedCount === 0)

  /*
   * A deleted account keeps its stale grant unless revoke can name it — the
   * grant path refuses deleted users, so if revoke did too this would be the
   * one entry nobody could ever clean up.
   */
  seedRegister()
  rows[0].sharedWith = [DELETED_U]
  const stale = await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [DELETED_U] } })
  check('a DELETED account can still be revoked', stale.ok, stale.ok ? '' : stale.message)
  check('the stale grant was cleaned up', rows[0].sharedWith.length === 0,
    JSON.stringify(rows[0].sharedWith))
}

console.log('\n51. Revoke never deletes an enquiry or changes an owner')
seedRegister()
{
  const countBefore = rows.length
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [USER_B, USER_C] } })

  check('no enquiry was deleted', rows.length === countBefore, `${rows.length} of ${countBefore}`)
  check('deleteOne was never called', deleteCalls.length === 0)
  check('every owner is unchanged',
    mine().every((l) => String(l.owner) === MANAGER) && String(foreign().owner) === ORG_OWNER)
  check('no company write', companyWrites.length === 0)
  check('no contact write', contactWrites.length === 0)
}

console.log('\n52. Revoke touches only sharedWith, no other Lead field')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B] } })
  const snapshot = mine().map((l) => JSON.stringify({ ...l, sharedWith: null }))

  await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [USER_B] } })
  const after = mine().map((l) => JSON.stringify({ ...l, sharedWith: null }))

  check('every other field is byte-identical', JSON.stringify(snapshot) === JSON.stringify(after))
  check('reference, stage and notes survive',
    mine().every((l) => l.reference && l.stage === 'active' && l.isDeleted === false))
}

console.log('\n53. One audit entry for a bulk revoke, naming what moved')
seedRegister()
{
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  audits.length = 0

  await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [USER_B] } })
  check('exactly one audit entry', audits.length === 1, String(audits.length))

  const entry = audits[0]
  check('it is the revoke event', entry?.action === 'lead.sharing_revoked', String(entry?.action))
  check('it is marked as a bulk revoke',
    entry?.metadata?.bulk === true && entry?.metadata?.operation === 'revoke')
  check('it names who lost access', (entry?.metadata?.removed ?? []).includes(USER_B),
    JSON.stringify(entry?.metadata?.removed))
  check('it records how many enquiries changed', entry?.metadata?.modified === 2,
    String(entry?.metadata?.modified))
  check('it records the unchanged owner', String(entry?.metadata?.owner) === MANAGER)
}

console.log('\n54. The preview reports who currently holds access')
seedRegister()
{
  const empty = await call(controller.bulkSharingPreview, { ...asManager })
  check('nobody holds access to begin with', (empty.payload?.data?.sharedUserIds ?? []).length === 0,
    JSON.stringify(empty.payload?.data?.sharedUserIds))

  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  const after = await call(controller.bulkSharingPreview, { ...asManager })
  const ids = (after.payload?.data?.sharedUserIds ?? []).map(String)
  check('both holders are reported', ids.includes(USER_B) && ids.includes(USER_C), JSON.stringify(ids))
  check('the lead count is still right', after.payload?.data?.leadCount === 2)

  const asSales = await call(controller.bulkSharingPreview, { ...asB })
  check('a user who may not manage sharing is told nothing',
    (asSales.payload?.data?.sharedUserIds ?? []).length === 0)
}

console.log('\n55. Share, revoke and individual sharing compose correctly')
seedRegister()
{
  // Bulk share to two, then individually add a third to one enquiry only.
  await call(controller.bulkShare, { ...asManager, body: { userIds: [USER_B, USER_C] } })
  await call(controller.updateSharing, {
    ...asManager, params: { id: LEAD_ID }, body: { userIds: [USER_B, USER_C, USER_D] },
  })
  check('the first enquiry has three', rows[0].sharedWith.length === 3, JSON.stringify(rows[0].sharedWith))

  const other = () => mine().find((l) => String(l._id) === '00000000000000000000bbbb')
  check('the second still has two', other().sharedWith.length === 2)

  // Bulk revoke one of the two originals.
  await call(controller.bulkRevokeSharing, { ...asManager, body: { userIds: [USER_B] } })
  check('B is gone from both', mine().every((l) => !l.sharedWith.map(String).includes(USER_B)))
  check('C survives on both', mine().every((l) => l.sharedWith.map(String).includes(USER_C)))
  check('D survives on the first only',
    rows[0].sharedWith.map(String).includes(USER_D) &&
    !other().sharedWith.map(String).includes(USER_D))
  check('ownership unchanged throughout', mine().every((l) => String(l.owner) === MANAGER))
  check('no enquiry was deleted', deleteCalls.length === 0)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
