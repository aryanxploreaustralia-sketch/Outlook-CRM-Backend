/**
 * Filter options come from the enquiries the reader can actually see.
 *
 * Runs the real `leadFacets` with `Lead` intercepted, so what is asserted is
 * the query it builds. The question behind every check: could this filter omit
 * a value that is on the reader's screen, or offer one from a lead they cannot
 * open? Both are answered by the scope, which is why the scope is what is
 * inspected.
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

/** Every query the service runs, in order. */
let distinctCalls = []
let aggregateCalls = []
let companyFindCalls = 0

Lead.distinct = async (field, filter) => {
  distinctCalls.push({ field, filter })
  return field === 'stage' ? ['active', 'closed'] : ['value-1', 'value-2']
}
Lead.aggregate = async (pipeline) => {
  aggregateCalls.push(pipeline)
  const match = pipeline.find((stage) => stage.$match)?.$match ?? {}
  // The company grouping asks for `company: { $ne: null }`; the months one does not.
  return match.company
    ? [{ _id: 'company-1', name: 'Travel Masters', leadCount: 4 }]
    : [{ _id: '2026-09', count: 3 }]
}

const { Company } = await import(`${B}/models/company.model.js`)
Company.find = () => {
  companyFindCalls += 1
  return { select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) }
}

const { leadFacets } = await import(`${B}/modules/leads/services/lead.service.js`)

const run = async (args) => {
  distinctCalls = []
  aggregateCalls = []
  companyFindCalls = 0
  return leadFacets(args)
}

/** The access clause of a filter, whatever else it carries. */
const accessOf = (filter) => JSON.stringify(filter.$and?.[0] ?? { owner: filter.owner })

// ---------------------------------------------------------------------------
section('CASES 1-3: the scope is the register\'s own')

const result = await run({ owner: USER_A, viewer: USER_A })

const scopes = [...distinctCalls.map((call) => call.filter), ...aggregateCalls.map((p) => p.find((s) => s.$match).$match)]
check('every facet is queried', distinctCalls.length === 4 && aggregateCalls.length === 2, `${distinctCalls.length} distinct, ${aggregateCalls.length} aggregate`)
check(
  'and every one carries the same access clause',
  new Set(scopes.map(accessOf)).size === 1,
  [...new Set(scopes.map(accessOf))].join(' | '),
)
check(
  'which admits the reader\'s own enquiries and the ones shared with them',
  accessOf(scopes[0]).includes('owner') && accessOf(scopes[0]).includes('sharedWith'),
  accessOf(scopes[0]),
)
check('the shared alternative names the reader', JSON.stringify(scopes[0]).includes(USER_B) === false && JSON.stringify(scopes[0]).includes(USER_A))
check('deleted enquiries contribute nothing', scopes.every((scope) => scope.isDeleted === false))

/*
 * CASE 2 is the defect this fixes: a lead owned by A, shared with B, handled by
 * Mukesh Patel. B's `handledBy` query must reach it.
 */
const asB = await run({ owner: USER_B, viewer: USER_B })
const handledByScope = asB && distinctCalls.find((call) => call.field === 'handledBy').filter
check("CASE 2: B's Handled by query includes leads shared with B", JSON.stringify(handledByScope).includes('sharedWith'))
check('    and is not restricted to leads B owns', accessOf(handledByScope) !== JSON.stringify({ owner: USER_B }))

/*
 * CASE 3: the clause is an `$or` of exactly two alternatives, so a lead that is
 * neither owned by nor shared with the reader cannot be matched by any of them.
 */
const alternatives = handledByScope.$and[0].$or
check('CASE 3: exactly two ways in — owner, or shared with the reader', alternatives.length === 2)
check('    no third alternative could admit somebody else\'s lead', JSON.stringify(alternatives) === JSON.stringify([{ owner: USER_B }, { sharedWith: USER_B }]))

// ---------------------------------------------------------------------------
section('CASES 4-7: each facet reads the leads, not another collection')

check('CASE 4: companies are grouped from accessible leads', aggregateCalls.some((p) => JSON.stringify(p).includes('$company')))
check('    and no longer read from the owner-scoped Company collection', companyFindCalls === 0)
check('    keeping the shape the page renders', result.companies[0]?.name === 'Travel Masters' && result.companies[0]?.leadCount === 4)
check('CASE 5: cities come from the leads', distinctCalls.some((call) => call.field === 'city'))
check('CASE 6: destinations come from the leads', distinctCalls.some((call) => call.field === 'market'))
check('CASE 7: stages come from the leads', distinctCalls.some((call) => call.field === 'stage'))
check('    and only the stages present are offered', result.stages.every((option) => ['active', 'closed'].includes(option.value)))
check('    in the register\'s own order, with labels', result.stages[0].value === 'active' && Boolean(result.stages[0].label))

// ---------------------------------------------------------------------------
section('Empty and unshared registers')

Lead.distinct = async (field) => (field === 'stage' ? [] : [])
Lead.aggregate = async () => []
const empty = await leadFacets({ owner: USER_A, viewer: USER_A })
check('a register with nothing in it offers no options rather than all of them', empty.stages.length === 0 && empty.cities.length === 0)

Lead.distinct = async (field, filter) => {
  distinctCalls.push({ field, filter })
  return []
}
distinctCalls = []
await leadFacets({ owner: USER_A })
check(
  'a caller that asks for one register only still gets `{ owner }`',
  JSON.stringify(distinctCalls[0].filter.$and) === undefined && String(distinctCalls[0].filter.owner) === USER_A,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
