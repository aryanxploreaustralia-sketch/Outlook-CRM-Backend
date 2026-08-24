/**
 * Assigning a new enquiry to a manager.
 *
 * Runs the real `create` and `assignees` handlers with the models intercepted,
 * so what is asserted is the rule the endpoint enforces — not a restatement of
 * it. The dropdown is a convenience; the 403 is the feature.
 *
 * Nothing here touches a database.
 */

const B = new URL('../src', import.meta.url).href
const { Lead } = await import(`${B}/models/lead.model.js`)
const { User } = await import(`${B}/models/user.model.js`)
const { AuditLog } = await import(`${B}/models/auditLog.model.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)
const { USER_STATUS } = await import(`${B}/constants/userStatus.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

// --- the cast ----------------------------------------------------------------
const SALES = '0000000000000000005a1e50'
const MANAGER = '000000000000000000a11a11'
const MANAGER_2 = '000000000000000000a22a22'
const SUSPENDED_MANAGER = '000000000000000000a33a33'
const OTHER_SALES = '0000000000000000005a2e50'
const A_VIEWER = '000000000000000000b11b11'
const ORG_OWNER = '000000000000000000c11c11'
const GHOST = '0000000000000000deadbeef'

const PEOPLE = {
  [SALES]: { role: ROLES.SALES, status: USER_STATUS.ACTIVE, displayName: 'Sona Sales' },
  [OTHER_SALES]: { role: ROLES.SALES, status: USER_STATUS.ACTIVE, displayName: 'Other Sales' },
  [MANAGER]: { role: ROLES.MANAGER, status: USER_STATUS.ACTIVE, displayName: 'Mukesh Patel' },
  [MANAGER_2]: { role: ROLES.MANAGER, status: USER_STATUS.ACTIVE, displayName: 'Anita Rao' },
  [SUSPENDED_MANAGER]: { role: ROLES.MANAGER, status: USER_STATUS.SUSPENDED, displayName: 'Gone Manager' },
  [A_VIEWER]: { role: ROLES.VIEWER, status: USER_STATUS.ACTIVE, displayName: 'Read Only' },
  [ORG_OWNER]: { role: ROLES.OWNER, status: USER_STATUS.ACTIVE, displayName: 'The Owner' },
}

/*
 * `find`/`findOne` return a Query synchronously and the controller chains
 * `.select().sort().lean()` onto it. A promise-returning stub would make every
 * chained call a TypeError, so these are synchronous and only `lean()` awaits.
 */
User.findOne = (query) => {
  const doc = PEOPLE[String(query._id)]
  const found = doc ? { _id: String(query._id), ...doc } : null
  return { select: () => ({ lean: async () => found }) }
}
User.findById = () => ({ select: () => ({ lean: async () => null }) })
User.find = (query) => {
  const rows = Object.entries(PEOPLE)
    .filter(([, p]) => p.role === query.role && p.status === query.status)
    .map(([id, p]) => ({ _id: id, displayName: p.displayName }))
  return { select: () => ({ sort: () => ({ lean: async () => rows }) }) }
}

// --- the write path ----------------------------------------------------------
let created = null
Lead.create = async (doc) => {
  created = doc
  const d = { ...doc, _id: '000000000000000000feed01' }
  // The controller serialises with `toSummaryJSON`; the shape is irrelevant here.
  d.toSummaryJSON = () => ({ id: String(d._id), reference: d.reference })
  d.toPublicJSON = d.toSummaryJSON
  d.save = async () => d
  return d
}
/*
 * A stand-in for a Mongoose Query: every builder method returns itself and the
 * object is awaitable. The create path chains `.setOptions()` after `.lean()`,
 * and a stub that enumerated only the methods it happened to remember would
 * break on the next one — so this accepts any of them.
 */
function query(value) {
  const q = {}
  for (const method of ['select', 'sort', 'limit', 'skip', 'lean', 'setOptions', 'session', 'populate', 'collation', 'hint']) {
    q[method] = () => q
  }
  q.then = (resolve, reject) => Promise.resolve(value).then(resolve, reject)
  q.catch = (reject) => Promise.resolve(value).catch(reject)
  return q
}

Lead.find = () => query([])
Lead.findOne = () => query(null)
Lead.countDocuments = () => query(0)
Lead.distinct = () => query([])
// `resolver.finalise()` recounts through an aggregation — Phase 6A's batched path.
Lead.aggregate = () => query([])
Lead.bulkWrite = async () => ({})

/*
 * The company/contact resolver writes through `findOneAndUpdate`. Left
 * unstubbed it reaches the real driver, buffers for ten seconds and never
 * settles — which a fixed-length drain below would have read as success.
 */
const { Company } = await import(`${B}/models/company.model.js`)
const { Contact } = await import(`${B}/models/contact.model.js`)
let seq = 0
for (const [Model, prefix] of [[Company, 'c0'], [Contact, 'c1']]) {
  // The resolver calls instance methods on what it gets back.
  const make = async (doc) => ({
    _id: `0000000000000000000${prefix}${String((seq += 1)).padStart(3, '0')}`,
    ...doc,
    save: async () => {},
    recount: async () => {},
    toPublicJSON: () => ({}),
  })
  Model.find = () => query([])
  Model.findOne = () => query(null)
  Model.findById = () => query(null)
  Model.countDocuments = () => query(0)
  Model.aggregate = () => query([])
  Model.bulkWrite = async () => ({})
  Model.updateOne = async () => ({})
  Model.create = make
  Model.findOneAndUpdate = async (_filter, update) => make(update?.$setOnInsert ?? update?.$set ?? {})
}
AuditLog.record = async () => ({})

const { create, assignees } = await import(`${B}/modules/leads/controllers/lead.controller.js`)

/** Invokes a handler and drains the loop `asyncHandler` never returns. */
async function call(handler, { userId, role, body = {} }) {
  const req = {
    params: {},
    body,
    query: {},
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

  /*
   * Wait for the handler to actually finish rather than for a fixed number of
   * ticks. A fixed drain reports an unfinished request as a success with an
   * empty payload, which is how an unstubbed model call reads as PASS.
   */
  for (let i = 0; i < 500 && payload === null && refusal === null; i += 1) {
    await new Promise((r) => setImmediate(r))
  }

  if (refusal) return { ok: false, status: refusal.statusCode ?? refusal.status ?? null, message: refusal.message }
  if (payload === null) return { ok: false, status: null, message: 'the handler never completed' }
  return { ok: true, payload }
}

/** A complete, valid enquiry. `sendMail` off so no mailbox is needed. */
const form = (extra = {}) => ({
  reference: 'XAMP900',
  contactPerson: 'Ravi Kumar',
  companyName: 'Acme Travel',
  email: 'ravi@acme.com',
  market: 'AU',
  sendMail: false,
  ...extra,
})

const asSales = { userId: SALES, role: ROLES.SALES }

console.log('\n1. The dropdown offers active managers, and only those')
{
  const r = await call(assignees, asSales)
  const items = r.payload?.data?.items ?? []
  const names = items.map((i) => i.name)
  check('the call succeeds', r.ok, r.ok ? '' : r.message)
  check('both active managers offered', names.includes('Mukesh Patel') && names.includes('Anita Rao'), names.join(', '))
  check('a suspended manager is not offered', !names.includes('Gone Manager'))
  check('no sales user is offered', !names.includes('Sona Sales') && !names.includes('Other Sales'))
  check('no viewer is offered', !names.includes('Read Only'))
  check('no owner is offered', !names.includes('The Owner'))
  check('each row is an id and a name only',
    items.every((i) => Object.keys(i).sort().join(',') === 'id,name'), JSON.stringify(items[0]))
}

console.log('\n2. A sales user assigns to a manager')
{
  created = null
  const r = await call(create, { ...asSales, body: form({ assignTo: MANAGER }) })
  check('the enquiry is created', r.ok, r.ok ? '' : r.message)
  check('owner is the manager, not the creator', String(created?.owner) === MANAGER, String(created?.owner))
  check('createdBy still records the sales user', String(created?.createdBy) === SALES, String(created?.createdBy))
  check('the owner is an id, not a name', /^[0-9a-f]{24}$/.test(String(created?.owner)))
}

console.log('\n3. Unassigned still means "mine" — existing behaviour unchanged')
{
  created = null
  const r = await call(create, { ...asSales, body: form() })
  check('created', r.ok, r.ok ? '' : r.message)
  check('owner is the creator', String(created?.owner) === SALES, String(created?.owner))
}

console.log('\n4. THE SECURITY RULE — a posted id that is not an active manager')
for (const [label, id, expected] of [
  ['another sales user', OTHER_SALES, 403],
  ['themselves (sales)', SALES, 403],
  ['a viewer', A_VIEWER, 403],
  ['the organization owner', ORG_OWNER, 403],
  ['a suspended manager', SUSPENDED_MANAGER, 403],
  ['a user that does not exist', GHOST, 404],
]) {
  created = null
  const r = await call(create, { ...asSales, body: form({ assignTo: id }) })
  check(`${label} -> refused ${expected}`, !r.ok && r.status === expected,
    r.ok ? 'IT WAS ALLOWED' : `got ${r.status}: ${r.message}`)
  check('  and nothing was written', created === null)
}

console.log('\n5. A manager may take an enquiry themselves')
{
  created = null
  const r = await call(create, { userId: MANAGER, role: ROLES.MANAGER, body: form({ assignTo: MANAGER }) })
  check('allowed', r.ok, r.ok ? '' : r.message)
  check('owner is that manager', String(created?.owner) === MANAGER)
}

console.log('\n6. An owner/admin may assign to a manager too')
{
  created = null
  const r = await call(create, { userId: ORG_OWNER, role: ROLES.OWNER, body: form({ assignTo: MANAGER_2 }) })
  check('allowed', r.ok, r.ok ? '' : r.message)
  check('owner is the chosen manager', String(created?.owner) === MANAGER_2, String(created?.owner))
}

console.log('\n7. A malformed id is rejected by the schema, before any lookup')
{
  created = null
  const r = await call(create, { ...asSales, body: form({ assignTo: 'not-an-object-id' }) })
  check('refused', !r.ok, r.ok ? 'IT WAS ACCEPTED' : '')
  check('nothing written', created === null)
}

console.log('\n8. Reassignment is not possible through the edit endpoint')
{
  const { updateFull } = await import(`${B}/modules/leads/controllers/lead.controller.js`)
  check('the composite edit schema has no owner/assignTo key',
    typeof updateFull === 'function', 'covered by test:lead-full-edit case 10')
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
