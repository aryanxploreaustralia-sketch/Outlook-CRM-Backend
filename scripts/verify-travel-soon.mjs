/**
 * Read-only check of the Travel Soon widget's data path, against the real
 * database.
 *
 * Calls `listAdminLeads` with exactly the parameters the dashboard card sends,
 * then cross-checks every answer against a raw query written independently. It
 * writes nothing and creates nothing.
 */

const B = new URL('../src', import.meta.url).href

const { connectDatabase, disconnectDatabase } = await import(`${B}/config/database.js`)
const { listAdminLeads } = await import(`${B}/modules/admin/services/adminMonitoring.service.js`)
const { adminLeadQuerySchema } = await import(`${B}/modules/admin/validators/admin.validator.js`)
const { Lead } = await import(`${B}/models/lead.model.js`)

const iso = (d) => d.toISOString().slice(0, 10)
const ddmmyyyy = (d) =>
  d ? `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}` : '—'

let failures = 0
const check = (label, actual, expected) => {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
}

await connectDatabase()

console.log('\n=== the register ===')
const totalLeads = await Lead.countDocuments({ isDeleted: false })
const noTravelDate = await Lead.countDocuments({ isDeleted: false, travelDate: null })
console.log(`  live enquiries        : ${totalLeads}`)
console.log(`  with no travel date   : ${noTravelDate}`)

for (const days of [7, 14, 30]) {
  const today = new Date()
  const horizon = new Date(today)
  horizon.setDate(horizon.getDate() + days)

  // Parsed through the real schema, so this exercises the validator too.
  const query = adminLeadQuerySchema.parse({
    dateField: 'travelDate',
    from: iso(today),
    to: iso(horizon),
    sort: 'travel',
    limit: '5',
  })

  const result = await listAdminLeads(query)

  // The independent answer: same window, written from scratch.
  const lower = new Date(`${iso(today)}T00:00:00.000Z`)
  const upper = new Date(`${iso(horizon)}T23:59:59.999Z`)
  const expected = await Lead.countDocuments({
    isDeleted: false,
    travelDate: { $gte: lower, $lte: upper },
  })

  console.log(`\n=== next ${days} days (${ddmmyyyy(lower)} – ${ddmmyyyy(upper)}) ===`)
  check('count matches an independent query', result.pagination.total, expected)
  check('page is capped at 5', result.items.length, Math.min(5, expected))

  const dates = result.items.map((l) => (l.travelDate ? new Date(l.travelDate) : null))
  check('no row is missing a travel date', dates.filter((d) => d === null).length, 0)
  check(
    'no row is in the past',
    dates.filter((d) => d && d < lower).length,
    0,
  )
  check(
    'no row is beyond the window',
    dates.filter((d) => d && d > upper).length,
    0,
  )

  const ascending = dates.every((d, i) => i === 0 || d >= dates[i - 1])
  check('sorted nearest first', ascending, true)

  for (const lead of result.items) {
    console.log(
      `    ${ddmmyyyy(new Date(lead.travelDate))}  ${String(lead.reference).padEnd(10)} ${String(lead.customer ?? '—').slice(0, 28)}`,
    )
  }
}

console.log('\n=== the default order is untouched ===')
const before = await Lead.find({ isDeleted: false }).sort({ createdAt: -1 }).limit(5).select('reference').lean()
const viaApi = await listAdminLeads(adminLeadQuerySchema.parse({ limit: '5' }))
check(
  'no sort param still returns newest-first',
  viaApi.items.map((l) => l.reference).join(','),
  before.map((l) => l.reference).join(','),
)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)

await disconnectDatabase()
process.exit(failures === 0 ? 0 : 1)
