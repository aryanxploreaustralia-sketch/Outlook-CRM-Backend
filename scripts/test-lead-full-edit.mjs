/**
 * The composite edit: enquiry + contact + company in one save.
 *
 * Runs the real `updateFull` handler with the three models intercepted, so the
 * queries it builds — and therefore the authorization and the relationship
 * safety — are what is asserted, not a restatement of them.
 *
 * Nothing here touches a database.
 */

const B = new URL('../src', import.meta.url).href
const { Lead } = await import(`${B}/models/lead.model.js`)
const { Contact } = await import(`${B}/models/contact.model.js`)
const { Company } = await import(`${B}/models/company.model.js`)
const { AuditLog } = await import(`${B}/models/auditLog.model.js`)
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
/** A record belonging to somebody else entirely. Must stay untouched. */
const FOREIGN_CONTACT = '00000000000000000000dead'

let queries = {}
let saved = []
let state = {}

function reset({ contact = CONTACT_ID, company = COMPANY_ID, imported = false } = {}) {
  queries = { lead: null, contact: null, company: null }
  saved = []
  state = {
    lead: {
      _id: LEAD_ID, owner: OWNER_A, isDeleted: false, reference: 'XA1', stage: 'active',
      contact, company,
      sourceSheet: imported ? 'Enquiries' : null,
    },
    contact: { _id: CONTACT_ID, owner: OWNER_A, displayName: 'Ravi', primaryEmail: 'r@x.com' },
    company: { _id: COMPANY_ID, owner: OWNER_A, isDeleted: false, companyName: 'Acme' },
  }
}

const wrap = (doc, kind) => {
  if (!doc) return null
  const d = { ...doc }
  d.save = async () => {
    saved.push(kind)
    state[kind] = { ...d }
    return d
  }
  d.moveToStage = () => {}
  d.toPublicJSON = () => ({ id: String(d._id) })
  return d
}

Lead.findOne = async (q) => {
  queries.lead = q
  if (q.owner !== undefined && String(q.owner) !== String(state.lead.owner)) return null
  return wrap(state.lead, 'lead')
}
Contact.findOne = async (q) => {
  queries.contact = q
  if (String(q._id) !== String(state.contact._id)) return null
  if (q.owner !== undefined && String(q.owner) !== String(state.contact.owner)) return null
  return wrap(state.contact, 'contact')
}
Company.findOne = async (q) => {
  queries.company = q
  if (String(q._id) !== String(state.company._id)) return null
  if (q.owner !== undefined && String(q.owner) !== String(state.company.owner)) return null
  return wrap(state.company, 'company')
}

let lastAudit = null
AuditLog.record = async (entry) => {
  lastAudit = entry
  return entry
}

const { updateFull } = await import(`${B}/modules/leads/controllers/lead.controller.js`)

/** Invokes the handler and waits for its own promise chain to settle. */
async function call({ userId, role, body }) {
  const req = {
    params: { id: LEAD_ID },
    body,
    method: 'PUT',
    originalUrl: `/api/v1/leads/${LEAD_ID}/full`,
    ip: '127.0.0.1',
    get: () => null,
    auth: { isAuthenticated: true, user: { _id: userId, role }, session: { _id: 's' } },
  }
  let payload = null
  const res = { status: () => res, json: (v) => { payload = v; return res } }
  let refusal = null

  // `asyncHandler` does not return its promise, so awaiting the call awaits
  // nothing; the loop is what lets the handler finish first.
  updateFull(req, res, (error) => { refusal = error })
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r))

  if (refusal) return { ok: false, status: refusal.statusCode ?? refusal.status ?? null, message: refusal.message }
  return { ok: true, payload }
}

const ownerA = { userId: OWNER_A, role: ROLES.MANAGER }
const ownerB = { userId: OWNER_B, role: ROLES.MANAGER }
const orgOwner = { userId: OWNER_B, role: ROLES.OWNER }

console.log('\n1-3. The lead owner edits all three records at once')
reset()
{
  const r = await call({ ...ownerA, body: {
    lead: { city: 'Sydney' },
    contact: { displayName: 'Ravi Kumar' },
    company: { companyName: 'Acme Travel' },
  } })
  check('the save succeeds', r.ok, r.ok ? '' : r.message)
  check('all three were written', saved.join(',') === 'lead,contact,company', saved.join(','))
  check('lead field applied', state.lead.city === 'Sydney')
  check('contact field applied', state.contact.displayName === 'Ravi Kumar')
  check('company field applied', state.company.companyName === 'Acme Travel')
  check('response reports what it updated', r.payload?.data?.updated?.join(',') === 'lead,contact,company',
    JSON.stringify(r.payload?.data?.updated))
}

console.log('\n4. Only the sections sent are touched')
reset()
{
  await call({ ...ownerA, body: { contact: { displayName: 'Only me' } } })
  check('just the contact was saved', saved.join(',') === 'contact', saved.join(','))
  check('the enquiry was not written', state.lead.city === undefined)
}

console.log('\n5. Relationship safety — ids come off the lead, never the body')
reset()
{
  await call({ ...ownerA, body: {
    contact: { displayName: 'X' },
    company: { companyName: 'Y' },
    // A caller trying to steer the write at somebody else's records.
    contactId: FOREIGN_CONTACT,
    companyId: FOREIGN_CONTACT,
    contact_id: FOREIGN_CONTACT,
  } })
  check('contact query used the lead’s contact', String(queries.contact._id) === CONTACT_ID, String(queries.contact._id))
  check('company query used the lead’s company', String(queries.company._id) === COMPANY_ID, String(queries.company._id))
  check('the foreign id appears in neither query',
    JSON.stringify(queries).includes(FOREIGN_CONTACT) === false)
  check('both are scoped to the enquiry’s owner',
    String(queries.contact.owner) === OWNER_A && String(queries.company.owner) === OWNER_A)
  check('the link itself is never reassigned',
    state.lead.contact === CONTACT_ID && state.lead.company === COMPANY_ID)
}

console.log('\n6. No duplicate records are ever created')
{
  const guard = (Model, name) => {
    Model.create = async () => { throw new Error(`${name}.create must not be called`) }
    Model.insertMany = async () => { throw new Error(`${name}.insertMany must not be called`) }
  }
  guard(Contact, 'Contact')
  guard(Company, 'Company')
  reset()
  const r = await call({ ...ownerA, body: {
    contact: { displayName: 'Edited' }, company: { companyName: 'Edited' },
  } })
  check('editing creates nothing new', r.ok, r.ok ? '' : r.message)
  check('existing contact was mutated in place', String(state.contact._id) === CONTACT_ID)
  check('existing company was mutated in place', String(state.company._id) === COMPANY_ID)
}

console.log('\n7. Imported enquiries behave identically')
reset({ imported: true })
{
  const r = await call({ ...ownerA, body: { lead: { city: 'Perth' }, company: { companyName: 'Z' } } })
  check('imported lead is fully editable', r.ok, r.ok ? '' : r.message)
  check('same records written', saved.join(',') === 'lead,company', saved.join(','))
}

console.log('\n8. A different consultant is refused')
reset()
{
  const r = await call({ ...ownerB, body: { company: { companyName: 'Hijack' } } })
  check('refused', !r.ok, r.ok ? 'IT WAS ALLOWED' : `${r.status}`)
  check('404, not 403', r.status === 404, String(r.status))
  check('nothing was written', saved.length === 0, saved.join(','))
  check('the company was never even loaded', queries.company === null)
}

console.log('\n9. The organization owner may edit any enquiry and its records')
reset()
{
  const r = await call({ ...orgOwner, body: {
    lead: { city: 'Cairns' }, contact: { displayName: 'Org edit' }, company: { companyName: 'Org co' },
  } })
  check('allowed', r.ok, r.ok ? '' : r.message)
  check('lead query was not owner-scoped', queries.lead.owner === undefined)
  check('but the contact stayed scoped to the enquiry’s owner',
    String(queries.contact.owner) === OWNER_A, String(queries.contact.owner))
  check('audit records the cross-owner edit', lastAudit.metadata.onBehalfOfOwner === OWNER_A)
  check('audit lists the related records', lastAudit.metadata.alsoUpdated.join(',') === 'contact,company',
    String(lastAudit.metadata.alsoUpdated))
}

console.log('\n10. Ownership cannot be reassigned through this endpoint')
reset()
{
  const r = await call({ ...ownerA, body: { lead: { owner: OWNER_B, city: 'Q' } } })
  check('the request succeeds', r.ok)
  check('owner is not among the changed fields', !lastAudit.metadata.changedFields.includes('owner'),
    JSON.stringify(lastAudit.metadata.changedFields))
  check('the enquiry still belongs to its owner', String(state.lead.owner) === OWNER_A)
}

console.log('\n11. An empty payload is rejected rather than silently succeeding')
reset()
{
  const r = await call({ ...ownerA, body: {} })
  check('refused', !r.ok, r.ok ? 'IT WAS ACCEPTED' : '')
  check('nothing written', saved.length === 0)
}

console.log('\n12. A section with no record to update refuses before writing anything')
reset({ company: null })
{
  const r = await call({ ...ownerA, body: { lead: { city: 'A' }, company: { companyName: 'B' } } })
  check('refused', !r.ok, r.ok ? 'IT WAS ALLOWED' : r.message)
  check('the enquiry was NOT half-saved', saved.length === 0, saved.join(','))
}

console.log('\n13. Validation is the existing validator’s, not a new one')
reset()
{
  const tooLong = 'x'.repeat(300)
  const r = await call({ ...ownerA, body: { company: { companyName: tooLong } } })
  check('an over-long company name is rejected', !r.ok, r.ok ? 'IT WAS ACCEPTED' : '')
  check('nothing written', saved.length === 0)

  const badEmail = await call({ ...ownerA, body: { contact: { primaryEmail: 'not-an-email' } } })
  check('an invalid contact email is rejected', !badEmail.ok, badEmail.ok ? 'IT WAS ACCEPTED' : '')
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
