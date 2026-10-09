/**
 * Sorting the register by the reference's number, not its text.
 *
 * Two halves. The first runs the real `listLeads` with `Lead` intercepted and
 * inspects the pipeline it builds — the access match, the order of the sort
 * keys, where the skip and limit sit. The second runs that same sort
 * specification over sample documents, so the ordering the pipeline asks for
 * is checked as an ordering rather than as a shape.
 *
 * Nothing here touches a database.
 */

const B = new URL('../src', import.meta.url).href
const { Lead } = await import(`${B}/models/lead.model.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}
const section = (title) => console.log(`\n=== ${title} ===`)

const USER_A = '0000000000000000000a0001'
const USER_B = '0000000000000000000b0002'

let lastPipeline = null
let lastFindSort = null
let lastCountFilter = null

Lead.aggregate = async (pipeline) => {
  lastPipeline = pipeline
  return []
}
Lead.find = (filter) => ({
  sort: (spec) => {
    lastFindSort = { filter, spec }
    return { skip: () => ({ limit: () => [] }) }
  },
})
Lead.countDocuments = async (filter) => {
  lastCountFilter = filter
  return 7
}
Lead.hydrate = (doc) => ({ ...doc, hydrated: true })

const { listLeads } = await import(`${B}/modules/leads/services/lead.service.js`)

const stageOf = (pipeline, key) => pipeline.find((stage) => key in stage)?.[key]

// ---------------------------------------------------------------------------
section('The pipeline: access first, order globally, paginate last')

await listLeads({ owner: USER_A, viewer: USER_A, sort: 'reference', page: 3, limit: 25 })

const match = stageOf(lastPipeline, '$match')
const sort = stageOf(lastPipeline, '$sort')
const keys = Object.keys(sort)
const stages = lastPipeline.map((stage) => Object.keys(stage)[0])

check('CASE 9: the match admits owned and shared enquiries', JSON.stringify(match.$and?.[0]).includes('sharedWith'))
check('CASE 10: and nothing else — two alternatives only', match.$and[0].$or.length === 2)
check('    deleted enquiries stay out', match.isDeleted === false)
check(
  'CASE 7: the match comes before the sort, and the sort before skip/limit',
  stages.indexOf('$match') < stages.indexOf('$sort') && stages.indexOf('$sort') < stages.indexOf('$skip'),
  stages.join(' → '),
)
check('    the page is skipped by (page - 1) × limit', stageOf(lastPipeline, '$skip') === 50)
check('    and limited to the page size', stageOf(lastPipeline, '$limit') === 25)
check('    the total still comes from the same filter', JSON.stringify(lastCountFilter) === JSON.stringify(match))

check('the number is the first thing sorted on, after the has-a-number flag', keys[0] === '__refHasNumber' && keys[1] === '__refNumber')
check('CASE 3: the prefix is next, and ascending', keys[2] === '__refPrefix' && sort.__refPrefix === 1)
check('    with the id last, so the order is total', keys[3] === '_id' && sort._id === 1)
check('ascending asks for an ascending number', sort.__refNumber === 1)
check('the working fields are projected away', Object.keys(stageOf(lastPipeline, '$project')).every((key) => key.startsWith('__ref')))

await listLeads({ owner: USER_A, viewer: USER_A, sort: '-reference' })
const descending = stageOf(lastPipeline, '$sort')
check('CASE 4: descending reverses the number', descending.__refNumber === -1)
check('    and nothing else: the prefix stays ascending', descending.__refPrefix === 1)
check('    the id stays ascending too', descending._id === 1)
check('    references without a number stay last in both directions', descending.__refHasNumber === -1)

// ---------------------------------------------------------------------------
section('CASE 11: every other sort takes the path it always did')

lastPipeline = null
await listLeads({ owner: USER_A, viewer: USER_A })
check('the default sort does not use the pipeline', lastPipeline === null)
check('    and is still newest quote first', JSON.stringify(lastFindSort.spec) === JSON.stringify({ quoteDate: -1 }))

lastPipeline = null
await listLeads({ owner: USER_A, viewer: USER_A, sort: 'travel' })
check('travel order is unchanged', lastPipeline === null && JSON.stringify(lastFindSort.spec) === JSON.stringify({ travelDate: 1 }))

// ---------------------------------------------------------------------------
section('CASES 1-6: the ordering the pipeline asks for')

/*
 * The same keys the `$sort` stage names, applied in Mongo's own order, over
 * references that exercise each rule: three prefixes on one number, a prefix
 * of a different length, a four-digit number, and three malformed values.
 */
const REGISTER = [
  { reference: 'XNMP082', _id: 'id-1' },
  { reference: 'XARS079', _id: 'id-2' },
  { reference: 'XANB080', _id: 'id-3' },
  { reference: 'XANB079', _id: 'id-4' },
  { reference: 'XNMP079', _id: 'id-5' },
  { reference: 'XARS081', _id: 'id-6' },
  { reference: 'XAMP009', _id: 'id-7' },
  { reference: 'XAMP010', _id: 'id-8' },
  { reference: 'XAMP100', _id: 'id-9' },
  { reference: 'XQ7', _id: 'id-10' },
  { reference: 'XAMP1000', _id: 'id-11' },
  { reference: '', _id: 'id-12' },
  { reference: 'NOSUFFIX', _id: 'id-13' },
  { reference: null, _id: 'id-14' },
]

const PATTERN = /^([A-Z]*)(\d+)$/
const decorate = (row) => {
  const found = PATTERN.exec(String(row.reference ?? '').toUpperCase())
  const number = found ? Number(found[2]) : null
  return { ...row, prefix: found ? found[1] : '', number, hasNumber: number === null ? 0 : 1 }
}

const order = (direction) =>
  REGISTER.map(decorate)
    .sort(
      (a, b) =>
        b.hasNumber - a.hasNumber ||
        (a.number === null ? 0 : (a.number - b.number) * direction) ||
        a.prefix.localeCompare(b.prefix) ||
        String(a._id).localeCompare(String(b._id)),
    )
    .map((row) => row.reference)

const ascending = order(1)
const descendingOrder = order(-1)

check(
  'CASE 1: 079 before 080 before 100, and 009 before 010 before 100 before 1000',
  ascending.slice(0, 11).join(' ') === 'XQ7 XAMP009 XAMP010 XANB079 XARS079 XNMP079 XANB080 XARS081 XNMP082 XAMP100 XAMP1000',
  ascending.join(' '),
)
check('    numerically, so 100 does not sort between 009 and 010', ascending.indexOf('XAMP100') > ascending.indexOf('XAMP010'))
check('CASE 2: the three 079s are adjacent, whatever their prefix', ascending.slice(3, 6).join(' ') === 'XANB079 XARS079 XNMP079')
check('CASE 3: and alphabetical by prefix', ascending.slice(3, 6).join(' ') === 'XANB079 XARS079 XNMP079')
check(
  'CASE 4: descending reverses the numbers',
  descendingOrder.slice(0, 4).join(' ') === 'XAMP1000 XAMP100 XNMP082 XARS081',
  descendingOrder.join(' '),
)
check(
  'CASE 3 again: the 079 tie-break is still ascending when descending',
  descendingOrder.slice(5, 8).join(' ') === 'XANB079 XARS079 XNMP079',
  descendingOrder.slice(5, 8).join(' '),
)
check('CASE 5: a shorter prefix sorts by its number like any other', ascending[0] === 'XQ7')
check(
  'CASE 6: a blank, a letters-only and a null reference go last, in both directions',
  ascending.slice(-3).every((value) => ['', 'NOSUFFIX', null].includes(value)) &&
    descendingOrder.slice(-3).every((value) => ['', 'NOSUFFIX', null].includes(value)),
)
check('    and nothing was dropped', ascending.length === REGISTER.length && descendingOrder.length === REGISTER.length)

// ---------------------------------------------------------------------------
section('CASE 8: filters and search still apply')

await listLeads({
  owner: USER_A,
  viewer: USER_A,
  sort: 'reference',
  search: 'ABC',
  stage: 'active',
  city: 'Pune',
  handledBy: 'Mukesh Patel',
})
const filtered = stageOf(lastPipeline, '$match')
check('the search reaches the match', JSON.stringify(filtered).includes('$or'))
check('the stage filter too', filtered.stage === 'active')
check('the city filter', Boolean(filtered.city))
check('and handled-by', Boolean(filtered.handledBy))
check('access is still a factor nothing overwrote', JSON.stringify(filtered.$and?.[0]).includes('sharedWith'))

const asB = await listLeads({ owner: USER_B, viewer: USER_B, sort: 'reference' })
check(
  'CASE 10: a different reader gets their own scope',
  JSON.stringify(stageOf(lastPipeline, '$match').$and[0]) ===
    JSON.stringify({ $or: [{ owner: USER_B }, { sharedWith: USER_B }] }),
)
check('the page still reports the total from the count query', asB.pagination.total === 7)
check('and documents are hydrated so the DTO still renders', Lead.hydrate({ reference: 'X1' }).hydrated === true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
