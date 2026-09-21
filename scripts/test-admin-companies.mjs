/**
 * The company-wise enquiry overview, and the company filter it links with.
 *
 * Runs the real `listAdminCompanies` and `listAdminLeads` with `Lead` and
 * `User` intercepted, so what is asserted is the pipeline and the filter the
 * services actually build — not a restatement of them. The two have to agree:
 * a row saying 245 must open a table of exactly those 245.
 *
 * Nothing here touches a database.
 */

const B = new URL('../src', import.meta.url).href
const { Lead } = await import(`${B}/models/lead.model.js`)
const { User } = await import(`${B}/models/user.model.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}
const section = (title) => console.log(`\n=== ${title} ===`)

// --- intercept ---------------------------------------------------------------

const OWNER_A = '0000000000000000000a0001'
const OWNER_B = '0000000000000000000b0002'

let lastPipeline = null
Lead.aggregate = async (pipeline) => {
  lastPipeline = pipeline
  return [
    {
      rows: [
        {
          _id: 'abc travels',
          name: 'ABC Travels',
          total: 245,
          active: 180,
          closed: 65,
          confirmed: 12,
          latestQueryAt: new Date('2026-09-21T00:00:00.000Z'),
          owners: [OWNER_A, OWNER_B],
        },
        {
          _id: 'xyz tours',
          name: 'XYZ Tours',
          total: 128,
          active: 96,
          closed: 32,
          confirmed: 4,
          latestQueryAt: null,
          owners: [],
        },
      ],
      counted: [{ companies: 37 }],
    },
  ]
}

User.find = () => ({
  select: () => ({
    lean: async () => [
      { _id: OWNER_A, displayName: 'Mukesh Patel' },
      { _id: OWNER_B, displayName: 'Neha Bhatkar' },
    ],
  }),
})

/** Captures the filter `listAdminLeads` builds, without running a query. */
let leadFilter = null
const emptyQuery = () => ({
  select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) }),
})
Lead.find = (filter) => {
  leadFilter = filter
  return emptyQuery()
}
Lead.countDocuments = async () => 0
Lead.distinct = async () => []

const { listAdminCompanies, listAdminLeads } = await import(
  `${B}/modules/admin/services/adminMonitoring.service.js`
)
const { adminCompanyQuerySchema, adminLeadQuerySchema } = await import(
  `${B}/modules/admin/validators/admin.validator.js`
)

// ---------------------------------------------------------------------------
section('The aggregation groups by company, across owners')

const result = await listAdminCompanies(adminCompanyQuerySchema.parse({}))

const group = lastPipeline.find((stage) => stage.$group)?.$group
check('groups by the name on the lead, not the Company record', JSON.stringify(group?._id).includes('$companyName'))
check('case-insensitively, and trimmed', JSON.stringify(group?._id).includes('toLower') && JSON.stringify(group?._id).includes('$trim'))
check('counts every enquiry in the group', JSON.stringify(group?.total) === '{"$sum":1}')
check('splits active and closed by stage', JSON.stringify(group?.active).includes('active') && JSON.stringify(group?.closed).includes('closed'))
check('takes the latest query date', JSON.stringify(group?.latestQueryAt).includes('$max'))
check('collects the distinct owners', JSON.stringify(group?.owners).includes('$addToSet'))

const match = lastPipeline.find((stage) => stage.$match)?.$match
check('reads live enquiries only', match?.isDeleted === false)
check('and skips leads with no company name', JSON.stringify(match?.companyName).includes('$nin'))

const facet = lastPipeline.find((stage) => stage.$facet)?.$facet
check('pages the groups and counts them in one round trip', Boolean(facet?.rows && facet?.counted))

// ---------------------------------------------------------------------------
section('What the page receives')

const [abc, xyz] = result.items
check('one row per company', result.items.length === 2)
check('company name as first spelled, not the lowered key', abc.name === 'ABC Travels')
check('total queries', abc.total === 245)
check('active', abc.active === 180)
check('closed', abc.closed === 65)
check('latest query date preserved', abc.latestQueryAt instanceof Date)
check('owners resolved to names', abc.owners.map((o) => o.name).join(', ') === 'Mukesh Patel, Neha Bhatkar')
check('a company nobody owns reports no owners', xyz.owners.length === 0)
check('a company with no dated enquiry reports none', xyz.latestQueryAt === null)
check('the total is the count of companies, not of the page', result.pagination.total === 37)
check('pages are derived from that total', result.pagination.totalPages === Math.ceil(37 / 25))

// ---------------------------------------------------------------------------
section('Filters narrow what is counted')

await listAdminCompanies(adminCompanyQuerySchema.parse({ owner: OWNER_A, market: 'AU', stage: 'active' }))
const filtered = lastPipeline.find((stage) => stage.$match)?.$match
check('owner reaches the match, before grouping', String(filtered.owner) === OWNER_A)
check('destination too', JSON.stringify(filtered.market).includes('AU'))
check('and stage', JSON.stringify(filtered.stage).includes('active'))

await listAdminCompanies(adminCompanyQuerySchema.parse({ search: 'ABC' }))
const searched = lastPipeline.find((stage) => stage.$match)?.$match
check('search matches the company name only', Boolean(searched.companyName?.$regex))
check('and still excludes the empty ones', JSON.stringify(searched.companyName).includes('$nin'))

await listAdminCompanies(adminCompanyQuerySchema.parse({ search: 'a.*b' }))
const escaped = lastPipeline.find((stage) => stage.$match)?.$match
check('a regex typed into the box is escaped, not executed', escaped.companyName.$regex.source.includes('a\\.\\*b'))

// ---------------------------------------------------------------------------
section('"View queries" opens exactly that company')

await listAdminLeads(adminLeadQuerySchema.parse({ company: 'ABC Travels' }))
check('the monitor filters on the company name', leadFilter.companyName instanceof RegExp)
check('anchored, so "ABC Travels" excludes "ABC Travels International"', leadFilter.companyName.source === '^ABC Travels$')
check('case-insensitively, as the grouping is', leadFilter.companyName.flags.includes('i'))
check('"ABC Travels" matches', leadFilter.companyName.test('abc travels'))
check('"ABC Travels International" does not', !leadFilter.companyName.test('ABC Travels International'))

await listAdminLeads(adminLeadQuerySchema.parse({ company: 'A.*B' }))
check('a regex in the parameter is escaped', leadFilter.companyName.source === '^A\\.\\*B$')

// ---------------------------------------------------------------------------
section('The monitor is otherwise untouched')

await listAdminLeads(adminLeadQuerySchema.parse({}))
check('no company clause when none is asked for', !('companyName' in leadFilter))
check('and the register is still scoped to live enquiries', leadFilter.isDeleted === false)

await listAdminLeads(adminLeadQuerySchema.parse({ stage: 'active', attention: 'unassigned' }))
check('existing filters still build as they did', JSON.stringify(leadFilter.stage).includes('active') && leadFilter.owner === null)

// ---------------------------------------------------------------------------
section('Authorisation is unchanged')

const routes = (await import('node:fs')).readFileSync(
  new URL('../src/modules/admin/routes/admin.routes.js', import.meta.url),
  'utf8',
)
const guard = /router\.get\(\s*'\/companies',\s*requireAllPermissions\(\[PERMISSIONS\.LEADS_VIEW, PERMISSIONS\.ANALYTICS_VIEW\]\)/
check('the endpoint requires leads.view AND analytics.view, as /leads does', guard.test(routes))
check('no new permission was invented', !/PERMISSIONS\.COMPANIES/.test(routes))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
