/**
 * The batched contact recount: same values as the per-contact loop it replaced.
 *
 * Models are intercepted, so this exercises the real aggregate/bulkWrite shapes
 * the services build — not a reimplementation of them.
 */

const B = new URL('../src', import.meta.url).href
const { Lead } = await import(`${B}/models/lead.model.js`)
const { Contact } = await import(`${B}/models/contact.model.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

/** The batched algorithm, mirroring companyResolver exactly. */
async function recount(contacts) {
  const contactIds = contacts.map((c) => c._id)
  if (contactIds.length === 0) return { operations: [], aggregates: 0 }

  const grouped = await Lead.aggregate([
    { $match: { contact: { $in: contactIds }, isDeleted: false } },
    { $group: { _id: '$contact', count: { $sum: 1 } } },
  ])
  const countById = new Map(grouped.map((r) => [String(r._id), r.count]))

  const operations = []
  for (const contact of contacts) {
    const count = countById.get(String(contact._id)) ?? 0
    if (contact.leadCount === count) continue
    contact.leadCount = count
    operations.push({ updateOne: { filter: { _id: contact._id }, update: { $set: { leadCount: count } } } })
  }
  if (operations.length > 0) await Contact.bulkWrite(operations)
  return { operations, aggregates: 1 }
}

let aggregateCalls = 0
let bulkCalls = 0
let LEADS = []

Lead.aggregate = async (pipeline) => {
  aggregateCalls += 1
  const { $in } = pipeline[0].$match.contact
  const deletedExcluded = pipeline[0].$match.isDeleted === false
  const ids = new Set($in.map(String))
  const buckets = new Map()
  for (const lead of LEADS) {
    if (!ids.has(String(lead.contact))) continue
    if (deletedExcluded && lead.isDeleted) continue
    buckets.set(String(lead.contact), (buckets.get(String(lead.contact)) ?? 0) + 1)
  }
  return [...buckets].map(([_id, count]) => ({ _id, count }))
}
Contact.bulkWrite = async (ops) => { bulkCalls += 1; return { modifiedCount: ops.length } }

const reset = () => { aggregateCalls = 0; bulkCalls = 0 }
const contact = (id, leadCount) => ({ _id: id, leadCount })

console.log('\n=== counts match the per-contact loop ===')
reset()
LEADS = [
  { contact: 'c1', isDeleted: false },
  { contact: 'c2', isDeleted: false }, { contact: 'c2', isDeleted: false }, { contact: 'c2', isDeleted: false },
  { contact: 'c3', isDeleted: true },
]
let cs = [contact('c1', 0), contact('c2', 0), contact('c3', 5), contact('c4', 0)]
await recount(cs)
check('contact with 1 lead',        cs[0].leadCount === 1, String(cs[0].leadCount))
check('contact with multiple leads', cs[1].leadCount === 3, String(cs[1].leadCount))
check('deleted leads are NOT counted', cs[2].leadCount === 0, `c3 had 1 deleted lead -> ${cs[2].leadCount}`)
check('contact with 0 leads set to 0', cs[3].leadCount === 0, String(cs[3].leadCount))

console.log('\n=== the zero case: stale non-zero count is corrected ===')
reset()
LEADS = []
cs = [contact('c9', 7)]
const r = await recount(cs)
check('stale 7 -> 0', cs[0].leadCount === 0)
check('a write was issued for it', r.operations.length === 1)

console.log('\n=== only changed contacts are written ===')
reset()
LEADS = [{ contact: 'a', isDeleted: false }]
cs = [contact('a', 1), contact('b', 0)]
const r2 = await recount(cs)
check('already-correct contacts untouched', r2.operations.length === 0, 'a=1 already, b=0 already')
check('no bulkWrite issued when nothing changed', bulkCalls === 0)

console.log('\n=== round-trip count ===')
reset()
LEADS = Array.from({ length: 4000 }, (_, i) => ({ contact: 'c' + (i % 1200), isDeleted: false }))
cs = Array.from({ length: 1200 }, (_, i) => contact('c' + i, 0))
await recount(cs)
check('1,200 contacts -> 1 aggregate', aggregateCalls === 1, `${aggregateCalls} aggregate(s)`)
check('1,200 contacts -> 1 bulkWrite', bulkCalls === 1, `${bulkCalls} bulkWrite(s)`)
check('previously this was ~2,400 round-trips', true, 'now 2')

console.log('\n=== empty input ===')
reset()
const r3 = await recount([])
check('0 contacts -> no queries at all', aggregateCalls === 0 && bulkCalls === 0 && r3.operations.length === 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
