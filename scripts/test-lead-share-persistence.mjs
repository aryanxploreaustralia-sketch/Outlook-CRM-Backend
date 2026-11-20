/**
 * Persistent sharing: a share agreed once covers the work entered afterwards.
 *
 * ## The defect under test
 *
 * Sharing used to be a stamp. "Share my leads" wrote the colleague's id into
 * `Lead.sharedWith` on every enquiry that existed at that instant, and an
 * enquiry created the next morning was born with an empty `sharedWith` — so it
 * was invisible to the colleague until the owner unshared and shared again.
 * Access depended on *when* a lead had been typed in.
 *
 * The scenarios below are written around that: each one that creates a lead
 * after the save is checking the half that used to be broken, and each one that
 * reads an untouched `sharedWith` value is checking that the fix took nothing
 * away.
 *
 * ## What is real here and what is stubbed
 *
 * The real handlers, the real `buildLeadFilter` and the real grant service run.
 * `Lead`, `User`, `AuditLog` and `LeadShare` are in-memory, so every assertion
 * is about the query or the row the code actually produced rather than a
 * restatement of it.
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

const { installLeadShareMock } = await import(new URL('./lib/leadShareMock.mjs', import.meta.url).href)
const leadShares = installLeadShareMock()

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}
const section = (title) => console.log(`\n${title}`)

const OWNER_A = '000000000000000000000a01' // shares their register
const EMPLOYEE_B = '000000000000000000000b01' // the colleague
const OWNER_X = '000000000000000000000c01' // shares with nobody
const STRANGER = '000000000000000000000d01' // never shared with
const ORG_OWNER = '000000000000000000000e01'

let rows = []
let people = []
let audits = []
let nextId = 1

/** Adds a lead to the fixture, as creating one in the app would. */
function addLead({ owner = OWNER_A, sharedWith = [], reference = null } = {}) {
  const id = String(nextId).padStart(24, '0')
  nextId += 1
  const row = {
    _id: id,
    owner,
    reference: reference ?? `XAMP${1000 + nextId}`,
    stage: 'active',
    market: 'AU',
    isDeleted: false,
    company: null,
    contact: null,
    sharedWith: [...sharedWith],
    internalNotes: '',
    quoteDate: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  }
  rows.push(row)
  return row
}

function reset() {
  rows = []
  audits = []
  nextId = 1
  leadShares.reset()
  people = [
    { _id: OWNER_A, displayName: 'Owner A', email: 'a@x.com', role: ROLES.MANAGER, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: EMPLOYEE_B, displayName: 'Employee B', email: 'b@x.com', role: ROLES.SALES, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: OWNER_X, displayName: 'Owner X', email: 'x@x.com', role: ROLES.MANAGER, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: STRANGER, displayName: 'Stranger', email: 'd@x.com', role: ROLES.SALES, status: USER_STATUS.ACTIVE, userPanelAccess: true },
    { _id: ORG_OWNER, displayName: 'Org Owner', email: 'o@x.com', role: ROLES.OWNER, status: USER_STATUS.ACTIVE, userPanelAccess: true },
  ]
}

/** Matches a row against the filter shapes the access paths build. */
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((clause) => matches(row, clause))
    if (key === '$and') return value.every((clause) => matches(row, clause))
    if (key === 'sharedWith') {
      if (value && typeof value === 'object' && '$in' in value) {
        return (row.sharedWith ?? []).some((id) => value.$in.some((c) => String(c) === String(id)))
      }
      return (row.sharedWith ?? []).some((id) => String(id) === String(value))
    }
    if (value && typeof value === 'object' && '$in' in value) {
      return value.$in.some((c) => String(c) === String(row[key]))
    }
    if (value && typeof value === 'object' && '$nin' in value) {
      return !value.$nin.some((c) => String(c) === String(row[key]))
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
  doc.save = async () => {
    Object.assign(row, doc)
    return doc
  }
  doc.moveToStage = () => {}
  doc.isCampaignEligible = () => true
  doc.ageInDays = () => 1
  doc.toPublicJSON = () => ({
    id: String(doc._id),
    reference: doc.reference,
    owner: String(doc.owner),
    sharedWith: (doc.sharedWith ?? []).map(String),
  })
  doc.toSummaryJSON = () => ({ id: String(doc._id), reference: doc.reference, owner: String(doc.owner) })
  return doc
}

Lead.findOne = async (filter) => wrapLead(rows.find((row) => matches(row, filter)))
Lead.exists = async (filter) => {
  const hit = rows.find((row) => matches(row, filter))
  return hit ? { _id: hit._id } : null
}
Lead.countDocuments = async (filter) => rows.filter((row) => matches(row, filter)).length
Lead.distinct = async (field, filter) => {
  const seen = new Set()
  for (const row of rows) {
    if (!matches(row, filter)) continue
    const value = row[field]
    if (Array.isArray(value)) for (const entry of value) seen.add(String(entry))
    else if (value !== null && value !== undefined && value !== '') seen.add(String(value))
  }
  return [...seen]
}
Lead.aggregate = async () => []
Lead.deleteOne = async (filter) => {
  const before = rows.length
  rows = rows.filter((row) => !matches(row, filter))
  return { deletedCount: before - rows.length }
}
Lead.updateMany = async (filter, update) => {
  const each = update?.$addToSet?.sharedWith?.$each ?? []
  const pull = update?.$pull?.sharedWith?.$in ?? []
  let modified = 0
  for (const row of rows) {
    if (!matches(row, filter)) continue
    const before = (row.sharedWith ?? []).map(String)
    let after = [...before]
    for (const id of each) if (!after.includes(String(id))) after.push(String(id))
    if (pull.length > 0) {
      const drop = new Set(pull.map(String))
      after = after.filter((id) => !drop.has(id))
    }
    if (after.length !== before.length) {
      row.sharedWith = after
      modified += 1
    }
  }
  return { matchedCount: rows.filter((row) => matches(row, filter)).length, modifiedCount: modified }
}

/** The register listing, as `listLeads` runs it. */
Lead.find = (filter) => {
  const found = rows.filter((row) => matches(row, filter))
  const chain = {
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    select: () => chain,
    lean: async () => found,
    then: (res, rej) => Promise.resolve(found.map(wrapLead)).then(res, rej),
  }
  return chain
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

Company.findById = async () => null
Company.updateOne = async () => ({})
Company.deleteOne = async () => {
  throw new Error('Sharing must never delete a company')
}
Contact.findById = async () => null
Contact.updateOne = async () => ({})
Contact.deleteOne = async () => {
  throw new Error('Sharing must never delete a contact')
}
SyncTombstone.insertMany = async (d) => d
SyncTombstone.create = async (d) => d
AuditLog.record = async (entry) => {
  audits.push(entry)
  return entry
}

const controller = await import(`${B}/modules/leads/controllers/lead.controller.js`)
const { buildLeadFilter, listLeads, leadFacets } = await import(`${B}/modules/leads/services/lead.service.js`)

/** Invokes a handler and waits for its own promise chain to settle. */
async function call(handler, { userId, role = ROLES.SALES, params = {}, body = {}, query = {} }) {
  const req = {
    params,
    body,
    query,
    method: 'POST',
    originalUrl: '/api/v1/leads',
    ip: '127.0.0.1',
    get: () => null,
    auth: { isAuthenticated: true, user: { _id: userId, role }, session: { _id: 's' } },
  }
  let payload = null
  const res = {
    status: () => res,
    json: (value) => {
      payload = value
      return res
    },
    set: () => res,
    setHeader: () => res,
  }
  let refusal = null

  handler(req, res, (error) => {
    refusal = error
  })
  for (let i = 0; i < 16; i += 1) await new Promise((resolve) => setImmediate(resolve))

  if (refusal) return { ok: false, status: refusal.statusCode ?? refusal.status ?? null, message: refusal.message }
  return { ok: true, payload }
}

const asOwnerA = { userId: OWNER_A, role: ROLES.MANAGER }
const asB = { userId: EMPLOYEE_B, role: ROLES.SALES }
const asStranger = { userId: STRANGER, role: ROLES.SALES }

/** The references a reader's register shows. */
async function registerOf(viewer) {
  const { items } = await listLeads({ owner: viewer, viewer })
  return items.map((item) => item.reference).sort()
}

/** Shares A's whole register with the given people, through the real endpoint. */
const shareRegister = (userIds, actor = asOwnerA) => call(controller.bulkShare, { ...actor, body: { userIds } })

// ---------------------------------------------------------------------------

section('1. Nothing changes for a reader with no grants')
reset()
{
  const plain = buildLeadFilter({ owner: OWNER_A })
  check(
    'no viewer → the filter it always was',
    JSON.stringify(plain) === JSON.stringify({ owner: OWNER_A, isDeleted: false }),
    JSON.stringify(plain),
  )

  const viewing = buildLeadFilter({ owner: EMPLOYEE_B, viewer: EMPLOYEE_B })
  check(
    'a viewer with no grants → the original two branches',
    JSON.stringify(viewing.$and[0]) === JSON.stringify({ $or: [{ owner: EMPLOYEE_B }, { sharedWith: EMPLOYEE_B }] }),
    JSON.stringify(viewing.$and[0]),
  )

  const granted = buildLeadFilter({ owner: EMPLOYEE_B, viewer: EMPLOYEE_B, sharedOwners: [OWNER_A] })
  check(
    'a grant adds a third branch and changes neither of the first two',
    granted.$and[0].$or.length === 3 &&
      JSON.stringify(granted.$and[0].$or.slice(0, 2)) === JSON.stringify(viewing.$and[0].$or),
    JSON.stringify(granted.$and[0].$or[2]),
  )
  check(
    'the third branch is by owner, not by stamp',
    JSON.stringify(granted.$and[0].$or[2]) === JSON.stringify({ owner: { $in: [OWNER_A] } }),
  )
}

section('2. Sharing the register stores a relationship, not only stamps')
reset()
addLead({ reference: 'XAMP1001' })
addLead({ reference: 'XAMP1002' })
{
  const r = await shareRegister([EMPLOYEE_B])
  check('the save succeeds', r.ok, r.ok ? '' : r.message)
  check(
    'one grant row, A to B',
    leadShares.pairs().join(',') === `${OWNER_A}>${EMPLOYEE_B}`,
    leadShares.pairs().join(','),
  )
  check('the grant records who gave it', String(leadShares.rows[0].createdBy) === OWNER_A)
  check(
    'the existing enquiries were stamped as before',
    rows.every((row) => row.sharedWith.map(String).includes(EMPLOYEE_B)),
  )
  check('the response says the share now covers future work', r.payload?.data?.persistent === true)
  check('ownership is untouched', rows.every((row) => String(row.owner) === OWNER_A))
}

section('3. The existing enquiries are visible to the employee')
{
  const visible = await registerOf(EMPLOYEE_B)
  check('B sees both of the owner’s enquiries', visible.join(',') === 'XAMP1001,XAMP1002', visible.join(','))
}

section('4. A lead created AFTER the share is visible — the defect itself')
{
  addLead({ reference: 'XAMP1003' })
  check('the new enquiry carries no stamp (a lead is born unshared)', rows.at(-1).sharedWith.length === 0)

  const visible = await registerOf(EMPLOYEE_B)
  check('B sees it anyway, with nothing re-shared', visible.includes('XAMP1003'), visible.join(','))

  const r = await call(controller.getById, { ...asB, params: { id: rows.at(-1)._id } })
  check('B can open it', r.ok, r.ok ? '' : r.message)
  check('and may edit it, exactly as a stamped enquiry', r.payload?.data?.canEdit === true)
  check('but may not re-share it', r.payload?.data?.canShare === false)
}

section('5. A second employee added later needs no re-share of old leads')
{
  const r = await shareRegister([EMPLOYEE_B, STRANGER])
  check('the save succeeds', r.ok, r.ok ? '' : r.message)
  check('two grant rows now', leadShares.pairs().length === 2, leadShares.pairs().join(','))

  const visible = await registerOf(STRANGER)
  check('the newcomer sees every enquiry, old and new', visible.join(',') === 'XAMP1001,XAMP1002,XAMP1003', visible.join(','))
  check(
    'the original grant was not rewritten',
    leadShares.rows.filter((row) => String(row.viewer) === EMPLOYEE_B).length === 1,
  )
}

section('6. Revoking ends access to existing AND future enquiries')
{
  const r = await shareRegister([EMPLOYEE_B])
  check('the save succeeds', r.ok, r.ok ? '' : r.message)
  check(
    'the revoked grant row is gone',
    leadShares.pairs().join(',') === `${OWNER_A}>${EMPLOYEE_B}`,
    leadShares.pairs().join(','),
  )
  check('their stamps were pulled too', rows.every((row) => !row.sharedWith.map(String).includes(STRANGER)))
  check('the revoked colleague sees nothing', (await registerOf(STRANGER)).length === 0)

  addLead({ reference: 'XAMP1004' })
  check('and sees nothing created afterwards either', (await registerOf(STRANGER)).length === 0)
  check('while B still sees everything', (await registerOf(EMPLOYEE_B)).includes('XAMP1004'))

  const opened = await call(controller.getById, { ...asStranger, params: { id: rows.at(-1)._id } })
  check(
    'a revoked colleague gets a 404, not a refusal that confirms it exists',
    !opened.ok && opened.status === 404,
    String(opened.status),
  )
}

section('7. Revoking everybody: Save with nobody ticked')
{
  const r = await shareRegister([])
  check('the save succeeds', r.ok, r.ok ? '' : r.message)
  check('no grant rows remain', leadShares.pairs().length === 0, leadShares.pairs().join(','))
  check('no stamps remain', rows.every((row) => row.sharedWith.length === 0))
  check('B sees nothing', (await registerOf(EMPLOYEE_B)).length === 0)
  check('every enquiry still exists', rows.length === 4, String(rows.length))
}

section('8. Existing stamps keep working with no grant behind them — no migration')
reset()
{
  // Exactly the state the database is in today: a share made before standing
  // grants existed is a stamp and nothing else.
  addLead({ reference: 'XAMP2001', sharedWith: [EMPLOYEE_B] })
  addLead({ reference: 'XAMP2002' })

  check('no grant rows exist', leadShares.pairs().length === 0)

  const visible = await registerOf(EMPLOYEE_B)
  check('the stamped enquiry is still visible', visible.join(',') === 'XAMP2001', visible.join(','))
  check('the unstamped one is still not', !visible.includes('XAMP2002'))

  const r = await call(controller.getById, { ...asB, params: { id: rows[0]._id } })
  check('B can still open it', r.ok, r.ok ? '' : r.message)
  check('and still edit it', r.payload?.data?.canEdit === true)
  check('the stored stamp was not altered by being read', rows[0].sharedWith.map(String).join(',') === EMPLOYEE_B)
}

section('9. Repeating the save is idempotent')
reset()
addLead({ reference: 'XAMP3001' })
{
  await shareRegister([EMPLOYEE_B])
  const firstRow = { ...leadShares.rows[0] }

  const again = await shareRegister([EMPLOYEE_B])
  check('the repeat save succeeds', again.ok, again.ok ? '' : again.message)
  check('still exactly one grant row', leadShares.rows.length === 1, String(leadShares.rows.length))
  check('the original grant was not replaced', String(leadShares.rows[0].createdAt) === String(firstRow.createdAt))
  check('it reports nothing changed', /nothing changed/i.test(again.payload?.message ?? ''), again.payload?.message)
  // Recorded in the audit entry rather than the response: the dialog has no use
  // for the row counts, but the log is where "did this save change anything"
  // has to be answerable afterwards.
  const logged = audits.at(-1)?.metadata ?? {}
  check(
    'the audit entry records that no grant was written or withdrawn',
    logged.grantsAdded === 0 && logged.grantsRevoked === 0,
    JSON.stringify({ added: logged.grantsAdded, revoked: logged.grantsRevoked }),
  )
}

section('10. An owner is never granted access to their own register')
reset()
addLead({ reference: 'XAMP4001' })
{
  const r = await shareRegister([OWNER_A, EMPLOYEE_B])
  check('the save succeeds', r.ok, r.ok ? '' : r.message)
  check(
    'no self-grant row was stored',
    leadShares.rows.every((row) => String(row.owner) !== String(row.viewer)),
    leadShares.pairs().join(','),
  )
  check('only the colleague holds a grant', leadShares.pairs().join(',') === `${OWNER_A}>${EMPLOYEE_B}`)
}

section('11. A grant reaches one register only')
reset()
addLead({ owner: OWNER_A, reference: 'XAMP5001' })
addLead({ owner: OWNER_X, reference: 'XAMP5002' })
{
  await shareRegister([EMPLOYEE_B])
  const visible = await registerOf(EMPLOYEE_B)
  check('B sees the shared register’s enquiry', visible.includes('XAMP5001'))
  check('B does NOT see the register nobody shared', !visible.includes('XAMP5002'), visible.join(','))

  addLead({ owner: OWNER_X, reference: 'XAMP5003' })
  check('nor anything that register adds later', !(await registerOf(EMPLOYEE_B)).includes('XAMP5003'))

  const opened = await call(controller.getById, { ...asB, params: { id: rows[1]._id } })
  check('and cannot open one of its enquiries', !opened.ok && opened.status === 404, String(opened.status))
}

section('12. Deletion stays owner-only')
reset()
addLead({ reference: 'XAMP6001' })
{
  await shareRegister([EMPLOYEE_B])
  const r = await call(controller.remove, { ...asB, params: { id: rows[0]._id } })
  check('a grant holder cannot delete', !r.ok, r.ok ? 'it was allowed' : String(r.status))
  check('the enquiry still exists', rows.length === 1)
}

section('13. A grant holder cannot re-share the register')
reset()
addLead({ reference: 'XAMP7001' })
{
  await shareRegister([EMPLOYEE_B])
  const r = await shareRegister([STRANGER], asB)
  check('B is refused', !r.ok && r.status === 403, String(r.status))
  check(
    'no grant was written for the stranger',
    leadShares.rows.every((row) => String(row.viewer) !== STRANGER),
    leadShares.pairs().join(','),
  )
}

section('14. The filter options follow the grant, not the stamps')
reset()
addLead({ reference: 'XAMP8001' })
{
  await shareRegister([EMPLOYEE_B])
  addLead({ reference: 'XAMP8002' })

  const facets = await leadFacets({ owner: EMPLOYEE_B, viewer: EMPLOYEE_B })
  check('the facets resolve for a grant holder', Boolean(facets))
  check('and they cover the post-share enquiry', (facets.markets ?? []).includes('AU'), JSON.stringify(facets.markets))
}

section('15. The dialog shows a grant it has no stamps to infer it from')
reset()
{
  // No leads at all: the owner shares an empty register, so there is nothing to
  // stamp and the grant is the only record of the arrangement.
  const r = await shareRegister([EMPLOYEE_B])
  check('sharing an empty register succeeds', r.ok, r.ok ? '' : r.message)
  check('the grant was still stored', leadShares.pairs().length === 1, leadShares.pairs().join(','))

  const preview = await call(controller.bulkSharingPreview, { ...asOwnerA, query: {} })
  check('the preview succeeds', preview.ok, preview.ok ? '' : preview.message)
  check(
    'and reports the colleague as holding access',
    (preview.payload?.data?.sharedUserIds ?? []).includes(EMPLOYEE_B),
    JSON.stringify(preview.payload?.data?.sharedUserIds),
  )
  check(
    'the enquiry count is honest about the empty register',
    preview.payload?.data?.leadCount === 0,
    String(preview.payload?.data?.leadCount),
  )

  addLead({ reference: 'XAMP9001' })
  const visible = await registerOf(EMPLOYEE_B)
  check('the first enquiry entered afterwards is visible to B', visible.join(',') === 'XAMP9001', visible.join(','))
}

section('16. Nothing was deleted or overwritten along the way')
{
  check('no enquiry was removed by any sharing operation', rows.length === 1)
  check('the audit log recorded the saves', audits.length > 0, String(audits.length))
  check(
    'every audit entry names the unchanged owner',
    audits.every((entry) => entry.metadata?.owner === undefined || String(entry.metadata.owner) === OWNER_A),
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
