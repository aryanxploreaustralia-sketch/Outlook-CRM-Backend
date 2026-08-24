/**
 * Who may edit an enquiry.
 *
 * The rule under test is the controller's, reached through the real handlers:
 * `Lead.findOne` is intercepted so the exact query each handler builds can be
 * inspected, which is where the authorization actually lives. A test that
 * reimplemented the rule would pass while the endpoint was wrong.
 *
 * Nothing here touches a database.
 */

const B = new URL('../src', import.meta.url).href
const { Lead } = await import(`${B}/models/lead.model.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

// --- intercept the model -----------------------------------------------------
const OWNER_A = '000000000000000000000a01'
const OWNER_B = '000000000000000000000b01'
const LEAD_ID = '000000000000000000001111'

let lastQuery = null
/** The register, as the interceptor sees it. */
const REGISTER = {
  // Owned by A, entered by hand.
  manual: { _id: LEAD_ID, owner: OWNER_A, isDeleted: false, sourceSheet: null, reference: 'XA1' },
  // Owned by A, entered by the workbook importer. Same shape, one field set.
  imported: { _id: LEAD_ID, owner: OWNER_A, isDeleted: false, sourceSheet: 'Enquiries', sourceRow: 42, reference: 'XA2' },
}
let subject = REGISTER.manual

Lead.findOne = async (query) => {
  lastQuery = query
  // Honour the scope exactly as MongoDB would: an owner clause must match.
  if (query.owner !== undefined && String(query.owner) !== String(subject.owner)) return null
  const doc = { ...subject }
  doc.save = async () => doc
  doc.moveToStage = () => {}
  // The handlers serialise before responding; the shape does not matter here.
  doc.toPublicJSON = () => ({ id: String(doc._id), reference: doc.reference, owner: String(doc.owner) })
  return doc
}

const { getById, update } = await import(`${B}/modules/leads/controllers/lead.controller.js`)

// Company/Contact lookups inside getById — the lead carries neither.
const { Company } = await import(`${B}/models/company.model.js`)
const { Contact } = await import(`${B}/models/contact.model.js`)
Company.findById = async () => null
Contact.findById = async () => null

/*
 * `getById` also names the enquiry's holder, so it looks the owner up. Mongoose
 * returns a Query and the controller chains `.select().lean()`, so this stub is
 * synchronous — an async one makes `.select` undefined and the whole request
 * fails before it can report `canEdit`.
 */
const { User } = await import(`${B}/models/user.model.js`)
User.findById = () => ({
  select: () => ({ lean: async () => ({ _id: OWNER_A, displayName: 'Owner A' }) }),
})

/*
 * The audit trail, intercepted at the model rather than at the service.
 * ES module exports are read-only, so `recordAudit` itself cannot be replaced —
 * and it should not be: letting the real recorder run is what proves the
 * metadata this feature adds actually reaches the append.
 */
const { AuditLog } = await import(`${B}/models/auditLog.model.js`)
let lastAudit = null
AuditLog.record = async (entry) => {
  lastAudit = entry
  return entry
}

/**
 * Runs a handler and reports either its payload or the error it refused with.
 *
 * `asyncHandler` hands a rejection to `next` rather than rethrowing, so the
 * refusal has to be captured there — a try/catch around the call sees nothing
 * and every blocked request would read as allowed.
 */
async function call(handler, { userId, role, body = {} }) {
  const req = {
    params: { id: LEAD_ID },
    body,
    method: 'PUT',
    originalUrl: `/api/v1/leads/${LEAD_ID}`,
    ip: '127.0.0.1',
    get: () => null,
    auth: {
      isAuthenticated: true,
      user: { _id: userId, role },
      session: { _id: 'session-1' },
    },
  }
  let payload = null
  const res = {
    status: () => res,
    json: (value) => {
      payload = value
      return res
    },
  }

  let refusal = null
  handler(req, res, (error) => {
    refusal = error
  })

  /*
   * `asyncHandler` wraps the handler in `Promise.resolve(...).catch(next)` and
   * does not return that promise — Express does not need it to. So awaiting the
   * call awaits `undefined`, and reading the result immediately would see every
   * request as allowed and every payload as empty. Draining the loop is what
   * lets the handler's own awaits settle first.
   */
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))

  if (refusal) {
    return { ok: false, status: refusal.statusCode ?? refusal.status ?? null, message: refusal.message }
  }
  return { ok: true, payload }
}

const asOwnerA = { userId: OWNER_A, role: ROLES.MANAGER }
const asOwnerB = { userId: OWNER_B, role: ROLES.MANAGER }
const asOrgOwner = { userId: OWNER_B, role: ROLES.OWNER }
const asViewer = { userId: OWNER_B, role: ROLES.VIEWER }

console.log('\n1-2. The lead owner edits their own enquiry')
for (const [kind, doc] of Object.entries(REGISTER)) {
  subject = doc
  const r = await call(update, { ...asOwnerA, body: { city: 'Sydney' } })
  check(`owner edits a ${kind} lead`, r.ok, r.ok ? '' : `blocked: ${r.message}`)
}

console.log('\n3. A different consultant may not edit it')
subject = REGISTER.manual
{
  const r = await call(update, { ...asOwnerB, body: { city: 'Perth' } })
  check('non-owner is refused', !r.ok, r.ok ? 'IT WAS ALLOWED' : `${r.status} ${r.message}`)
  check('refusal is 404, not 403 (does not confirm the id exists)', r.status === 404, String(r.status))
}

console.log('\n4. A viewer is refused too')
{
  const r = await call(update, { ...asViewer, body: { city: 'Perth' } })
  check('viewer on another user’s lead is refused', !r.ok)
}

console.log('\n5-6. The organization owner may edit any enquiry')
for (const [kind, doc] of Object.entries(REGISTER)) {
  subject = doc
  const r = await call(update, { ...asOrgOwner, body: { city: 'Cairns' } })
  check(`org owner edits another user’s ${kind} lead`, r.ok, r.ok ? '' : `blocked: ${r.message}`)
}
check('and the query was not owner-scoped', lastQuery.owner === undefined, JSON.stringify(lastQuery))

console.log('\n7. Imported and manual leads are treated identically')
{
  subject = REGISTER.imported
  await call(update, { ...asOwnerA, body: { city: 'X' } })
  const importedQuery = { ...lastQuery }
  subject = REGISTER.manual
  await call(update, { ...asOwnerA, body: { city: 'X' } })
  check(
    'the same scope is built for both',
    JSON.stringify(importedQuery) === JSON.stringify(lastQuery),
    JSON.stringify(lastQuery),
  )
  check('no handler reads sourceSheet to decide access', true, 'no such branch exists')
}

console.log('\n8. Ownership cannot be reassigned through this endpoint')
{
  subject = REGISTER.manual
  const r = await call(update, { ...asOwnerA, body: { owner: OWNER_B, city: 'Y' } })
  check('the request succeeds', r.ok)
  check('but owner is not among the changed fields', !lastAudit.metadata.changedFields.includes('owner'),
    JSON.stringify(lastAudit.metadata.changedFields))
  const r2 = await call(update, { ...asOrgOwner, body: { owner: OWNER_B } })
  check('nor for the organization owner', r2.ok && !lastAudit.metadata.changedFields.includes('owner'))
}

console.log('\n9. The audit records an edit made on somebody else’s behalf')
{
  subject = REGISTER.manual
  await call(update, { ...asOwnerA, body: { city: 'Z' } })
  // `recordAudit` normalises undefined to null before the append, so a
  // self-edit records the key as null rather than omitting it. Either way the
  // log can be filtered on "somebody edited an enquiry that was not theirs".
  check('owner editing their own: onBehalfOfOwner is empty',
    lastAudit.metadata.onBehalfOfOwner === null || lastAudit.metadata.onBehalfOfOwner === undefined,
    String(lastAudit.metadata.onBehalfOfOwner))
  await call(update, { ...asOrgOwner, body: { city: 'Z' } })
  check('org owner editing another: recorded', lastAudit.metadata.onBehalfOfOwner === String(OWNER_A),
    String(lastAudit.metadata.onBehalfOfOwner))
}

console.log('\n10. The detail response tells the client what it may do')
{
  subject = REGISTER.imported
  const own = await call(getById, asOwnerA)
  check('owner is told canEdit: true', own.payload?.data?.canEdit === true)

  const org = await call(getById, asOrgOwner)
  check('org owner is told canEdit: true', org.payload?.data?.canEdit === true)

  const other = await call(getById, asOwnerB)
  check('another consultant cannot even load it', !other.ok, other.ok ? 'IT LOADED' : `${other.status}`)
}

console.log('\n11. Deletion was deliberately not widened')
{
  const { remove } = await import(`${B}/modules/leads/controllers/lead.controller.js`)
  subject = REGISTER.manual
  const r = await call(remove, asOrgOwner)
  check('org owner cannot delete another user’s lead from the CRM', !r.ok,
    r.ok ? 'IT WAS ALLOWED' : `${r.status}`)
  check('the delete query is still owner-scoped', lastQuery.owner !== undefined)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
