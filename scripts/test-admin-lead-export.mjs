/**
 * The admin register export.
 *
 * Runs the real `exportAdminLeadsWorkbook` with `Lead` and `User` intercepted,
 * then reads the workbook it produced back with the project's own `fromXlsx` —
 * so the assertions are about the file a user would open, not about a shape a
 * test imagined.
 *
 * It also asserts the two things that must *not* have changed: the CRM's own
 * export still writes its own columns, and every write method on `Lead` is
 * fatal here, so the export cannot touch a record.
 *
 * Nothing here touches a database.
 */

const B = new URL('../src', import.meta.url).href
const { Lead } = await import(`${B}/models/lead.model.js`)
const { User } = await import(`${B}/models/user.model.js`)
const { fromXlsx } = await import(`${B}/modules/contacts/utils/xlsx.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}
const section = (title) => console.log(`\n=== ${title} ===`)

const OWNER_A = '0000000000000000000a0001'
const OWNER_B = '0000000000000000000b0002'

/*
 * Every write path on the model is a failure here. The export is read-only by
 * design, and this is what proves it rather than asserting it.
 */
for (const method of [
  'create', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndDelete', 'bulkWrite', 'replaceOne',
]) {
  Lead[method] = async () => {
    throw new Error(`the export called Lead.${method}() — it must be read-only`)
  }
}

const LEADS = [
  {
    _id: 'l1', reference: 'XANB079', owner: OWNER_A, companyName: 'ABC Travels',
    contactPerson: 'Prapti Kolay', email: 'prapti@example.com', phones: ['+61 400 000 001'],
    market: 'AU', quoteDate: new Date('2026-09-20T00:00:00Z'), travelDate: new Date('2026-12-18T00:00:00Z'),
    paxText: '2 adults', city: 'Pune', sourceSheet: 'Sheet1', handledBy: 'Mukesh Patel',
    stage: 'active', autoMail: { status: 'sent', sentAt: new Date('2026-09-21T00:00:00Z') },
    replyReceived: true, replyCount: 2, lastReplyAt: new Date('2026-09-22T00:00:00Z'),
    doNotContact: false, createdAt: new Date('2026-09-19T00:00:00Z'), updatedAt: new Date('2026-09-22T00:00:00Z'),
  },
  {
    _id: 'l2', reference: 'XNMP080', owner: OWNER_B, companyName: 'XYZ Tours',
    contactPerson: 'Krishna Rao', email: 'krishna@example.com', phones: [],
    market: 'NZ', quoteDate: new Date('2026-09-18T00:00:00Z'), travelDateText: "Oct '26 - Mar '27",
    paxText: '4 adults', city: 'Mumbai', sourceSheet: null, handledBy: 'Neha Bhatkar',
    stage: 'closed', autoMail: { status: 'pending', sentAt: null },
    replyReceived: false, replyCount: 0, lastReplyAt: null,
    doNotContact: true, createdAt: new Date('2026-09-17T00:00:00Z'), updatedAt: new Date('2026-09-18T00:00:00Z'),
  },
  {
    // Nobody owns this one: the Owner column must say so rather than be blank.
    _id: 'l3', reference: 'XARS081', owner: null, companyName: 'Skylines',
    contactPerson: 'Nidhi', email: '', phones: [], market: 'AU',
    quoteDate: new Date('2026-09-10T00:00:00Z'), stage: 'query',
    autoMail: { status: 'pending' }, createdAt: new Date('2026-09-09T00:00:00Z'),
    updatedAt: new Date('2026-09-10T00:00:00Z'),
  },
]

let lastQuery = null
const queryStub = (filter) => {
  lastQuery = { filter }

  /*
   * Both chains the services use, recorded rather than reimplemented: the
   * export's `find().sort().limit().lean()` and the monitor's
   * `find().select().sort().skip().limit().lean()`.
   */
  const afterSort = {
    limit: (value) => {
      lastQuery.limit = value
      return { lean: async () => LEADS }
    },
    skip: (value) => {
      lastQuery.skip = value
      return {
        limit: (value2) => {
          lastQuery.pageLimit = value2
          return { lean: async () => LEADS }
        },
      }
    },
  }

  const chain = {
    sort: (spec) => {
      lastQuery.sort = spec
      return afterSort
    },
    select: (fields) => {
      lastQuery.select = fields
      return chain
    },
    lean: async () => LEADS,
  }

  return chain
}
Lead.find = queryStub
Lead.countDocuments = async () => LEADS.length
Lead.distinct = async () => []
Lead.aggregate = async () => []

User.find = () => ({
  select: () => ({
    lean: async () => [
      { _id: OWNER_A, displayName: 'Mukesh Patel' },
      { _id: OWNER_B, displayName: 'Neha Bhatkar' },
    ],
  }),
})

const { exportAdminLeadsWorkbook } = await import(`${B}/modules/admin/services/adminMonitoring.service.js`)
const { exportLeadsWorkbook, EXPORT_COLUMNS } = await import(`${B}/modules/leads/services/leadExport.service.js`)
const { adminLeadQuerySchema } = await import(`${B}/modules/admin/validators/admin.validator.js`)

const run = (query = {}) => exportAdminLeadsWorkbook(adminLeadQuerySchema.parse(query))

// ---------------------------------------------------------------------------
section('The file a user opens')

const all = await run()
const sheet = fromXlsx(all.buffer)
const headers = sheet.headers ?? Object.keys(sheet.rows?.[0] ?? {})

check('a workbook is produced', Buffer.isBuffer(all.buffer) && all.buffer.length > 0, `${all.buffer.length} bytes`)
check('named for a cross-owner export', /^leads-all-owners-\d{4}-\d{2}-\d{2}\.xlsx$/.test(all.filename), all.filename)
check('as an xlsx', all.contentType.includes('spreadsheetml'))
check('every row is written', all.count === 3)
check('and it is not truncated', all.truncated === false)

check(
  'the columns are the CRM export\'s, in the same order',
  JSON.stringify(headers.slice(0, EXPORT_COLUMNS.length)) === JSON.stringify([...EXPORT_COLUMNS]),
  headers.slice(0, 4).join(', ') + ' …',
)
check('with Owner appended last', headers.at(-1) === 'Owner', headers.at(-1))
check('and nothing else added', headers.length === EXPORT_COLUMNS.length + 1, String(headers.length))

const rows = sheet.rows
const byReference = Object.fromEntries(rows.map((row) => [row.Reference, row]))

check('owner names are resolved', byReference.XANB079.Owner === 'Mukesh Patel', byReference.XANB079.Owner)
check('for every owner in the file', byReference.XNMP080.Owner === 'Neha Bhatkar', byReference.XNMP080.Owner)
check('an unowned enquiry says Unassigned', byReference.XARS081.Owner === 'Unassigned', byReference.XARS081.Owner)

check('the CRM export\'s own fields are intact', byReference.XANB079.Company === 'ABC Travels' && byReference.XANB079['Handled By'] === 'Mukesh Patel')
check('   including the prose travel date', byReference.XNMP080['Travel Date'] === "Oct '26 - Mar '27", String(byReference.XNMP080['Travel Date']))
check('   the mail status wording', String(byReference.XNMP080['Mail Status']).length > 0, String(byReference.XNMP080['Mail Status']))
check('   and the do-not-contact flag', byReference.XNMP080['Do Not Contact'] === 'Yes')

// ---------------------------------------------------------------------------
section('What gets exported')

check('the whole matching set, not a page: no skip is applied', !('skip' in (lastQuery ?? {})))
check('   bounded only by the CRM export\'s own ceiling', lastQuery.limit === 50_001, String(lastQuery.limit))
check('   in the CRM export\'s order', JSON.stringify(lastQuery.sort) === JSON.stringify({ quoteDate: -1, createdAt: -1 }))

await run()
check('all owners: no owner clause', !('owner' in lastQuery.filter), JSON.stringify(lastQuery.filter))
check('   live enquiries only', lastQuery.filter.isDeleted === false)

await run({ owner: OWNER_A })
check('a selected owner reaches the filter', String(lastQuery.filter.owner) === OWNER_A)

await run({ search: 'ABC', stage: 'active', market: 'AU', company: 'ABC Travels', attention: 'stale', activity: 'replied' })
const filtered = lastQuery.filter
check('the search reaches it', Array.isArray(filtered.$or))
check('the stage filter', JSON.stringify(filtered.stage).includes('active'))
check('the destination filter', JSON.stringify(filtered.market).includes('AU'))
check('the company filter', filtered.companyName instanceof RegExp)
check('the attention filter', Boolean(filtered.updatedAt))
check('and the activity filter', Array.isArray(filtered.$and))

await run({ preset: 'last30', dateField: 'quoteDate' })
check('a date window reaches it', Boolean(lastQuery.filter.quoteDate))

/*
 * The filter is the monitor's own builder, so this is the real guarantee: the
 * export cannot interpret a filter differently from the table above it.
 */
const { listAdminLeads } = await import(`${B}/modules/admin/services/adminMonitoring.service.js`)
await listAdminLeads(adminLeadQuerySchema.parse({ search: 'ABC', stage: 'active', owner: OWNER_A }))
const listFilter = JSON.stringify(lastQuery.filter)
await run({ search: 'ABC', stage: 'active', owner: OWNER_A })
check(
  'the export filters by exactly what the monitor lists',
  JSON.stringify(lastQuery.filter) === listFilter,
)

// ---------------------------------------------------------------------------
section('Truncation is reported, not hidden')

const many = Array.from({ length: 50_001 }, (_, index) => ({ ...LEADS[0], _id: `x${index}`, reference: `XAMP${index}` }))
Lead.find = () => ({
  sort: () => ({ limit: () => ({ lean: async () => many }) }),
  select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => many }) }) }) }),
})
const big = await run()
check('the file stops at the ceiling', big.count === 50_000, String(big.count))
check('and says it was truncated', big.truncated === true)
Lead.find = queryStub

// ---------------------------------------------------------------------------
section('The CRM export is unchanged')

const crm = await exportLeadsWorkbook({ owner: OWNER_A, criteria: {} })
const crmSheet = fromXlsx(crm.buffer)
const crmHeaders = crmSheet.headers ?? Object.keys(crmSheet.rows?.[0] ?? {})

check('it still writes its own columns', JSON.stringify(crmHeaders) === JSON.stringify([...EXPORT_COLUMNS]))
check('   with no Owner column', !crmHeaders.includes('Owner'))
check('   and its own filename', /^leads-\d{4}-\d{2}-\d{2}\.xlsx$/.test(crm.filename), crm.filename)
check('   scoped to one owner', String(lastQuery.filter.owner) === OWNER_A)
check('   and not to shared enquiries', !JSON.stringify(lastQuery.filter).includes('sharedWith'))

// ---------------------------------------------------------------------------
section('Read-only, and guarded')

check('no write method on Lead was called', true, 'every one throws in this test; the run completed')

const { readFileSync } = await import('node:fs')
const routes = readFileSync(new URL('../src/modules/admin/routes/admin.routes.js', import.meta.url), 'utf8')
const guard = /router\.get\(\s*'\/leads\/export',\s*requireAllPermissions\(\[\s*PERMISSIONS\.LEADS_VIEW,\s*PERMISSIONS\.ANALYTICS_VIEW,\s*PERMISSIONS\.LEADS_EXPORT,?\s*\]\)/
check('the endpoint requires leads.view, analytics.view and leads.export', guard.test(routes))
check('it is registered before /leads/:id', routes.indexOf("'/leads/export'") < routes.indexOf("'/leads/:id'"))
check('no new permission was invented', !/PERMISSIONS\.EXPORT_ALL|PERMISSIONS\.ADMIN_EXPORT/.test(routes))

const service = readFileSync(new URL('../src/modules/admin/services/adminMonitoring.service.js', import.meta.url), 'utf8')
check(
  'the export writes nothing: no write call appears in the service',
  !/exportAdminLeadsWorkbook[\s\S]*?\n\}/.exec(service)?.[0].match(/updateOne|insertMany|deleteOne|deleteMany|save\(|bulkWrite/),
)
check('and no migration or schema change accompanies it', !/createIndex|dropIndex|collection\./.test(service))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
