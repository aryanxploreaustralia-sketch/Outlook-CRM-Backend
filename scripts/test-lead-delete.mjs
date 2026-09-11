/**
 * Individual lead deletion, and the recreation it used to block.
 *
 * The defect this covers: `DELETE /leads/:id` soft-deleted the enquiry, and
 * `referenceExists` — the pre-check `createLeadManually` runs — matched
 * soft-deleted rows. So deleting an enquiry and entering it again under the
 * same reference was refused as a duplicate by a record no screen could show.
 *
 * Runs the real `remove` handler and the real `referenceExists` with the models
 * intercepted, so what is asserted is the query each one actually builds —
 * including the ownership scoping and the relationship safety — rather than a
 * restatement of them.
 *
 * Nothing here touches a database.
 */

const B = new URL('../src', import.meta.url).href
const { Lead } = await import(`${B}/models/lead.model.js`)
const { Company } = await import(`${B}/models/company.model.js`)
const { Contact } = await import(`${B}/models/contact.model.js`)
const { AuditLog } = await import(`${B}/models/auditLog.model.js`)
const { SyncTombstone, TOMBSTONE_ENTITY } = await import(`${B}/models/syncTombstone.model.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

const OWNER_A = '000000000000000000000a01'
const OWNER_B = '000000000000000000000b01'
const LEAD_ID = '000000000000000000001111'
const CONTACT_ID = '000000000000000000002222'
const COMPANY_ID = '000000000000000000003333'
const REFERENCE = 'XAMP1687'

/**
 * The collection, as rows.
 *
 * A physical delete has to be observable as the document *leaving*, which a
 * single mutable object cannot show — so the interceptors below work against
 * this array the way the driver would.
 */
let rows = []
let companies = []
let contacts = []
let tombstones = []
let deleteCalls = []
let savedLeads = []
let audits = []

function reset({ deleted = false } = {}) {
  rows = [{
    _id: LEAD_ID,
    owner: OWNER_A,
    reference: REFERENCE,
    stage: 'active',
    market: 'AU',
    isDeleted: deleted,
    company: COMPANY_ID,
    contact: CONTACT_ID,
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  }]
  companies = [{ _id: COMPANY_ID, owner: OWNER_A, companyName: 'Acme Travel', leadCount: 1 }]
  contacts = [{ _id: CONTACT_ID, owner: OWNER_A, primaryEmail: 'r@acme.com', leadCount: 1 }]
  tombstones = []
  deleteCalls = []
  savedLeads = []
  audits = []
}

/** Matches a plain-object filter against a row, the way a find would. */
const matches = (row, filter) =>
  Object.entries(filter).every(([key, value]) => {
    if (value instanceof RegExp) return value.test(String(row[key] ?? ''))
    if (value && typeof value === 'object' && '$in' in value) {
      return value.$in.some((candidate) => String(candidate) === String(row[key]))
    }
    return String(row[key]) === String(value)
  })

const wrapLead = (row) => {
  if (!row) return null
  const doc = { ...row }
  doc.save = async () => { savedLeads.push(doc); Object.assign(row, doc); return doc }
  doc.toPublicJSON = () => ({ id: String(doc._id) })
  return doc
}

Lead.findOne = async (filter) => wrapLead(rows.find((row) => matches(row, filter)))
Lead.exists = async (filter) => {
  const hit = rows.find((row) => matches(row, filter))
  return hit ? { _id: hit._id } : null
}
Lead.find = (filter) => {
  const found = rows.filter((row) => matches(row, filter))
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: async () => found,
    then: (resolve, rejectFn) => Promise.resolve(found).then(resolve, rejectFn),
  }
  return chain
}
Lead.deleteOne = async (filter) => {
  deleteCalls.push(filter)
  const before = rows.length
  rows = rows.filter((row) => !matches(row, filter))
  return { deletedCount: before - rows.length, acknowledged: true }
}
/** The operation the fix replaced. Calling it now is a regression. */
Lead.updateOne = async () => { throw new Error('Lead.updateOne must not be used by the delete path') }
Lead.deleteMany = async () => { throw new Error('Lead.deleteMany must not be used by the single delete path') }
Lead.countDocuments = async (filter) => rows.filter((row) => matches(row, filter)).length

Company.findById = async (id) => {
  const found = companies.find((row) => String(row._id) === String(id))
  if (!found) return null
  return {
    ...found,
    recount: async () => {
      found.leadCount = rows.filter(
        (row) => String(row.company) === String(found._id) && row.isDeleted === false,
      ).length
      return { leadCount: found.leadCount }
    },
  }
}
Company.deleteOne = async () => { throw new Error('Company.deleteOne must not be called') }
Company.deleteMany = async () => { throw new Error('Company.deleteMany must not be called') }
Contact.deleteOne = async () => { throw new Error('Contact.deleteOne must not be called') }
Contact.deleteMany = async () => { throw new Error('Contact.deleteMany must not be called') }

SyncTombstone.insertMany = async (docs) => { tombstones.push(...docs); return docs }
SyncTombstone.create = async (doc) => { tombstones.push(doc); return doc }

AuditLog.record = async (entry) => { audits.push(entry); return entry }

const { remove } = await import(`${B}/modules/leads/controllers/lead.controller.js`)
const { referenceExists } = await import(`${B}/modules/leads/services/referenceGenerator.service.js`)

/** Invokes the handler and waits for its own promise chain to settle. */
async function callDelete({ userId, role, id = LEAD_ID }) {
  const req = {
    params: { id },
    body: {},
    method: 'DELETE',
    originalUrl: `/api/v1/leads/${id}`,
    ip: '127.0.0.1',
    get: () => null,
    auth: { isAuthenticated: true, user: { _id: userId, role }, session: { _id: 's' } },
  }
  let payload = null
  let statusCode = 200
  const res = {
    status: (code) => { statusCode = code; return res },
    json: (value) => { payload = value; return res },
  }
  let refusal = null

  // `asyncHandler` does not return its promise, so awaiting the call awaits
  // nothing; the loop is what lets the handler finish first.
  remove(req, res, (error) => { refusal = error })
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r))

  if (refusal) return { ok: false, status: refusal.statusCode ?? refusal.status ?? null, message: refusal.message }
  return { ok: true, payload, statusCode }
}

const ownerA = { userId: OWNER_A, role: ROLES.SALES }
const ownerB = { userId: OWNER_B, role: ROLES.SALES }

// ---------------------------------------------------------------------------

console.log('\n1. The reported bug: create → delete → recreate the same reference')
reset()
{
  const beforeDelete = await referenceExists({ owner: OWNER_A, reference: REFERENCE })
  check('the live enquiry blocks its own reference', beforeDelete === true)

  const r = await callDelete(ownerA)
  check('the delete succeeds', r.ok, r.ok ? '' : r.message)

  const afterDelete = await referenceExists({ owner: OWNER_A, reference: REFERENCE })
  check('the deleted enquiry no longer blocks recreation', afterDelete === false,
    afterDelete ? 'STILL BLOCKED — the bug is present' : '')
}

console.log('\n2. The delete is physical, not a flag')
reset()
{
  await callDelete(ownerA)
  check('the document left the collection', rows.length === 0, `${rows.length} row(s) remain`)
  check('deleteOne was used', deleteCalls.length === 1, `${deleteCalls.length} call(s)`)
  check('nothing was saved with isDeleted', savedLeads.length === 0, `${savedLeads.length} save(s)`)
  check('the delete is scoped to the id', String(deleteCalls[0]?._id) === LEAD_ID)
  check('the delete is scoped to the owner', String(deleteCalls[0]?.owner) === OWNER_A)
}

console.log('\n3. A tombstone is recorded, so offline devices learn about it')
reset()
{
  await callDelete(ownerA)
  check('exactly one tombstone', tombstones.length === 1, `${tombstones.length}`)
  check('it names the lead entity', tombstones[0]?.entityType === TOMBSTONE_ENTITY.LEAD, String(tombstones[0]?.entityType))
  check('it names this enquiry', String(tombstones[0]?.entityId) === LEAD_ID)
  check('it is scoped to the owner', String(tombstones[0]?.owner) === OWNER_A)
  check('it is a named deletion, not a purge', tombstones[0]?.entityId !== null)
}

console.log('\n4. Recreation after delete is allowed; an active duplicate is still refused')
reset()
{
  check('active reference is taken', (await referenceExists({ owner: OWNER_A, reference: REFERENCE })) === true)
  await callDelete(ownerA)
  check('after deletion it is free', (await referenceExists({ owner: OWNER_A, reference: REFERENCE })) === false)

  // Recreate it, exactly as `createLeadManually` would.
  rows.push({ ...{
    _id: '00000000000000000000aaaa', owner: OWNER_A, reference: REFERENCE,
    stage: 'active', market: 'AU', isDeleted: false, company: COMPANY_ID, contact: CONTACT_ID,
  } })
  check('the recreated enquiry takes the reference again',
    (await referenceExists({ owner: OWNER_A, reference: REFERENCE })) === true)
}

console.log('\n5. Duplicate protection between live enquiries is unchanged')
reset()
{
  check('a live reference is reported as in use',
    (await referenceExists({ owner: OWNER_A, reference: REFERENCE })) === true)
  check('lower case input still matches', (await referenceExists({ owner: OWNER_A, reference: 'xamp1687' })) === true)
  check('surrounding whitespace still matches',
    (await referenceExists({ owner: OWNER_A, reference: '  XAMP1687 ' })) === true)
  check('an unrelated reference is free', (await referenceExists({ owner: OWNER_A, reference: 'XAMP9999' })) === false)
  check('another workspace’s reference is free to use',
    (await referenceExists({ owner: OWNER_B, reference: REFERENCE })) === false)
  check('an empty reference is never "in use"', (await referenceExists({ owner: OWNER_A, reference: '' })) === false)
}

console.log('\n6. A soft-deleted enquiry — from the admin bulk path — does not block either')
reset({ deleted: true })
{
  check('a soft-deleted row no longer blocks recreation',
    (await referenceExists({ owner: OWNER_A, reference: REFERENCE })) === false)
}

console.log('\n7. Deleting a lead does not delete its Company or Contact')
reset()
{
  await callDelete(ownerA)
  check('the company survives', companies.length === 1)
  check('the contact survives', contacts.length === 1)
  check('the company was recounted', companies[0].leadCount === 0, String(companies[0].leadCount))
}

console.log('\n8. Deleting a lead does not touch another lead of the same company')
reset()
{
  rows.push({
    _id: '00000000000000000000bbbb', owner: OWNER_A, reference: 'XAMP1688',
    stage: 'active', market: 'AU', isDeleted: false, company: COMPANY_ID, contact: CONTACT_ID,
  })
  await callDelete(ownerA)
  check('the sibling enquiry survives', rows.length === 1, `${rows.length} row(s)`)
  check('the survivor is the other enquiry', String(rows[0]._id) === '00000000000000000000bbbb')
  check('the company count reflects the survivor', companies[0].leadCount === 1, String(companies[0].leadCount))
  check('its reference is still protected',
    (await referenceExists({ owner: OWNER_A, reference: 'XAMP1688' })) === true)
}

console.log('\n9. Access control is unchanged')
reset()
{
  const r = await callDelete(ownerB)
  check('another consultant is refused', !r.ok, r.ok ? 'IT WAS ALLOWED' : `${r.status}`)
  check('404, not 403', r.status === 404, String(r.status))
  check('the enquiry survives', rows.length === 1)
  check('no tombstone was written', tombstones.length === 0)
  check('no delete was attempted', deleteCalls.length === 0)
}

console.log('\n10. An already-deleted enquiry is a 404, not a second deletion')
reset({ deleted: true })
{
  const r = await callDelete(ownerA)
  check('refused', !r.ok, r.ok ? 'IT WAS ALLOWED' : `${r.status}`)
  check('404', r.status === 404, String(r.status))
  check('no delete was attempted', deleteCalls.length === 0)
}

console.log('\n11. The audit entry survives the document')
reset()
{
  await callDelete(ownerA)
  check('one audit entry', audits.length === 1, `${audits.length}`)
  check('action is lead.deleted', audits[0]?.action === 'lead.deleted', String(audits[0]?.action))
  check('it still names the reference', audits[0]?.entityName === REFERENCE, String(audits[0]?.entityName))
  check('it still names the id', String(audits[0]?.entityId) === LEAD_ID, String(audits[0]?.entityId))
  check('it still carries the lead reference link', String(audits[0]?.leadId) === LEAD_ID)
  check('the summary still reads correctly', audits[0]?.summary === `Deleted the enquiry ${REFERENCE}`,
    String(audits[0]?.summary))
  check('it records that the delete was physical', audits[0]?.metadata?.soft === false,
    String(audits[0]?.metadata?.soft))
  check('it records the stage the enquiry was in', audits[0]?.metadata?.stage === 'active')
}

console.log('\n12. The API response shape is unchanged')
reset()
{
  const r = await callDelete(ownerA)
  check('success envelope', r.payload?.success === true)
  check('message unchanged', r.payload?.message === 'Lead deleted.', String(r.payload?.message))
  check('data.id is the enquiry id', String(r.payload?.data?.id) === LEAD_ID)
  check('data.deleted is true', r.payload?.data?.deleted === true)
}

console.log('\n13. An enquiry with no company deletes cleanly')
reset()
{
  rows[0].company = null
  const r = await callDelete(ownerA)
  check('the delete succeeds', r.ok, r.ok ? '' : r.message)
  check('the document left the collection', rows.length === 0)
  check('a tombstone was still written', tombstones.length === 1)
}

console.log('\n14. A failing tombstone write never blocks the deletion')
reset()
{
  const insertMany = SyncTombstone.insertMany
  SyncTombstone.insertMany = async () => { throw new Error('sync collection unavailable') }
  const r = await callDelete(ownerA)
  SyncTombstone.insertMany = insertMany

  check('the delete still succeeds', r.ok, r.ok ? '' : r.message)
  check('the document still left the collection', rows.length === 0)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
