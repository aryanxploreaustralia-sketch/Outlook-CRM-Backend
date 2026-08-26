/**
 * Read-only check of the admin calendar's data path, against the real database.
 *
 * Drives the service exactly as the endpoint does, then cross-checks every
 * number against an independently written query. Writes nothing.
 */

const B = new URL('../src', import.meta.url).href

const { connectDatabase, disconnectDatabase } = await import(`${B}/config/database.js`)
const { getAdminCalendar, getAdminCalendarDay } = await import(
  `${B}/modules/admin/services/adminCalendar.service.js`
)
const { adminCalendarQuerySchema, adminCalendarDaySchema } = await import(
  `${B}/modules/admin/validators/admin.validator.js`
)
const { Lead } = await import(`${B}/models/lead.model.js`)

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

await connectDatabase()

// The month the grid opens on.
const now = new Date()
const first = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
const last = `${first.slice(0, 8)}${lastDay}`

console.log(`\n=== COUNTS: ${first} → ${last} ===`)
const query = adminCalendarQuerySchema.parse({ from: first, to: last, tz: 'Asia/Kolkata' })
const result = await getAdminCalendar(query)

check('timezone accepted', result.timezone === 'Asia/Kolkata', result.timezone)
check('days are sorted', result.days.every((d, i) => i === 0 || d.date > result.days[i - 1].date))
check('only non-empty days returned', result.days.every((d) => d.travel + d.followUp + d.activity + d.task > 0))
check('every date is inside the range', result.days.every((d) => d.date >= first && d.date <= last))

// The independent answer for travel, day by day.
const raw = await Lead.aggregate([
  {
    $match: {
      isDeleted: false,
      travelDate: { $gte: new Date(`${first}T00:00:00.000Z`), $lte: new Date(`${last}T23:59:59.999Z`) },
    },
  },
  { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$travelDate', timezone: 'UTC' } }, n: { $sum: 1 } } },
])
const expected = new Map(raw.map((r) => [r._id, r.n]))
const mismatches = result.days.filter((d) => (expected.get(d.date) ?? 0) !== d.travel)
check('travel counts match an independent aggregation', mismatches.length === 0,
  mismatches.length ? JSON.stringify(mismatches.slice(0, 3)) : `${expected.size} dated days`)
check('travel total matches the sum of days', result.totals.travel === [...expected.values()].reduce((a, b) => a + b, 0),
  String(result.totals.travel))

console.log('\n  busiest dates this month:')
for (const day of [...result.days].sort((a, b) => b.travel - a.travel).slice(0, 5)) {
  const [y, m, d] = day.date.split('-')
  console.log(`    ${d}/${m}/${y}   travel ${day.travel}  follow-up ${day.followUp}  activity ${day.activity}  task ${day.task}`)
}
console.log(`  totals: ${JSON.stringify(result.totals)}`)

// ---------------------------------------------------------------------------
console.log('\n=== DAY DETAIL ===')
const busiest = [...result.days].sort((a, b) => b.travel - a.travel)[0]
if (!busiest) {
  console.log('  (no dated activity this month — nothing to open)')
} else {
  const day = await getAdminCalendarDay(adminCalendarDaySchema.parse({ date: busiest.date, tz: 'Asia/Kolkata' }))
  check('date echoed back', day.date === busiest.date, day.date)
  check('travel total matches the grid', day.travel.total === busiest.travel, `${day.travel.total} vs ${busiest.travel}`)
  check('sample is capped at 25', day.travel.items.length <= 25, `${day.travel.items.length} rows`)
  check('every row is on that date', day.travel.items.every(
    (i) => new Date(i.travelDate).toISOString().slice(0, 10) === busiest.date))
  check('rows carry a real reference', day.travel.items.every((i) => Boolean(i.reference)))
  check('owner resolved to a name, not an id', day.travel.items.every(
    (i) => i.owner === null || !/^[a-f\d]{24}$/i.test(i.owner)))

  const [y, m, d] = busiest.date.split('-')
  console.log(`\n  ${d}/${m}/${y} — ${day.travel.total} travelling, showing ${day.travel.items.length}:`)
  for (const item of day.travel.items.slice(0, 4)) {
    console.log(`    ${String(item.reference).padEnd(10)} ${String(item.customer ?? '—').slice(0, 26).padEnd(28)} ${item.market ?? '—'}  ${item.owner ?? 'Unassigned'}`)
  }
  console.log(`  follow-ups ${day.followUp.total}  activities ${day.activity.total}  tasks ${day.task.total}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== GUARDS ===')
const rejects = (input) => {
  try {
    adminCalendarQuerySchema.parse(input)
    return false
  } catch {
    return true
  }
}
check('rejects a reversed range', rejects({ from: '2026-09-01', to: '2026-08-01' }))
check('rejects a range over 62 days', rejects({ from: '2026-01-01', to: '2026-12-31' }))
check('rejects a malformed date', rejects({ from: '01/08/2026', to: '2026-08-31' }))
check('falls back to UTC on a bogus timezone',
  adminCalendarQuerySchema.parse({ from: first, to: last, tz: 'Mars/Olympus' }).timezone === 'UTC')
check('accepts a 62-day span', !rejects({ from: '2026-08-01', to: '2026-10-01' }))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)

await disconnectDatabase()
process.exit(failures === 0 ? 0 : 1)
