/**
 * READ-ONLY audit of the User Dashboard's figures.
 *
 * Calls the same service the API calls, then recomputes every number with an
 * independently written query and compares. Creates nothing, changes nothing,
 * deletes nothing.
 */

const B = new URL('../src', import.meta.url).href

const { connectDatabase, disconnectDatabase } = await import(`${B}/config/database.js`)
const { leadStatistics } = await import(`${B}/modules/leads/services/lead.service.js`)
const { Lead } = await import(`${B}/models/lead.model.js`)
const { Company } = await import(`${B}/models/company.model.js`)
const { Contact } = await import(`${B}/models/contact.model.js`)
const { User } = await import(`${B}/models/user.model.js`)
const { LEAD_STAGE_ORDER, CAMPAIGN_ELIGIBLE_STAGES } = await import(
  `${B}/modules/leads/constants/leadConstants.js`
)

await connectDatabase()

console.log('\n=== STAGE INTEGRITY (whole register) ===')
const allStages = await Lead.aggregate([
  { $match: { isDeleted: false } },
  { $group: { _id: '$stage', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
])
const known = new Set(LEAD_STAGE_ORDER)
console.log('  stages present in the data:')
for (const row of allStages) {
  const flag = row._id === null ? '  ⚠ NULL' : known.has(row._id) ? '' : '  ⚠ NOT IN LEAD_STAGE_ORDER'
  console.log(`    ${String(row._id).padEnd(16)} ${String(row.count).padStart(6)}${flag}`)
}
const liveTotal = await Lead.countDocuments({ isDeleted: false })
const stageSum = allStages.reduce((a, r) => a + r.count, 0)
const unknownSum = allStages.filter((r) => !known.has(r._id)).reduce((a, r) => a + r.count, 0)
console.log(`  live leads: ${liveTotal} · stage rows sum: ${stageSum} · outside the six: ${unknownSum}`)
console.log(`  → the six displayed stages ${unknownSum === 0 ? 'DO' : 'DO NOT'} account for every lead`)

console.log('\n=== PER-OWNER: service output vs independent queries ===')
const owners = await Lead.distinct('owner', { isDeleted: false })
const named = await User.find({ _id: { $in: owners.filter(Boolean) } }).select('displayName email').lean()
const nameOf = new Map(named.map((u) => [String(u._id), u.displayName ?? u.email]))

let mismatches = 0
const rows = []

for (const owner of owners.filter(Boolean)) {
  const s = await leadStatistics({ owner })

  // Independently written, not copied from the service.
  const thirty = new Date(Date.now() - 30 * 86_400_000)
  const [xTotal, xCompanies, xContacts, xRecent, xCampaign] = await Promise.all([
    Lead.countDocuments({ owner, isDeleted: false }),
    Company.countDocuments({ owner, isDeleted: false }),
    Contact.countDocuments({ owner, isDeleted: false }),
    Lead.countDocuments({ owner, isDeleted: false, createdAt: { $gte: thirty } }),
    Lead.countDocuments({
      owner, isDeleted: false, doNotContact: false,
      stage: { $in: [...CAMPAIGN_ELIGIBLE_STAGES] },
      email: { $nin: [null, ''] },
    }),
  ])

  const displayedStageSum = LEAD_STAGE_ORDER.reduce((a, k) => a + (s.byStage[k] ?? 0), 0)

  const cmp = [
    ['totalLeads', s.totalLeads, xTotal],
    ['companies', s.companies, xCompanies],
    ['contacts', s.contacts, xContacts],
    ['recentLeads', s.recentLeads, xRecent],
    ['campaignReady', s.campaignReady, xCampaign],
  ]
  const bad = cmp.filter(([, a, b]) => a !== b)
  if (bad.length) mismatches += bad.length

  rows.push({
    owner: nameOf.get(String(owner)) ?? String(owner).slice(-6),
    total: s.totalLeads,
    stageSum: displayedStageSum,
    new30: s.recentLeads,
    companies: s.companies,
    contacts: s.contacts,
    campaignReady: s.campaignReady,
    active: s.byStage.active ?? 0,
    agrees: bad.length === 0,
    totalMatchesStages: s.totalLeads === displayedStageSum,
  })
}

console.log(
  '  ' + 'OWNER'.padEnd(20) + 'TOTAL'.padStart(7) + 'ΣSTAGE'.padStart(8) + 'NEW30'.padStart(7) +
  'COMP'.padStart(7) + 'CONT'.padStart(7) + 'CAMPRDY'.padStart(9) + 'ACTIVE'.padStart(8) + '  SERVICE=DB  Σ=TOTAL',
)
for (const r of rows) {
  console.log(
    '  ' + String(r.owner).slice(0, 19).padEnd(20) +
    String(r.total).padStart(7) + String(r.stageSum).padStart(8) + String(r.new30).padStart(7) +
    String(r.companies).padStart(7) + String(r.contacts).padStart(7) +
    String(r.campaignReady).padStart(9) + String(r.active).padStart(8) +
    (r.agrees ? '        yes' : '         NO') + (r.totalMatchesStages ? '      yes' : '       NO'),
  )
}

console.log(`\n  service-vs-database mismatches: ${mismatches}`)
console.log(`  owners where Σstages ≠ totalLeads: ${rows.filter((r) => !r.totalMatchesStages).length}`)

console.log('\n=== "CAMPAIGN READY" — what entity is it? ===')
const campaignsCollection = (await Lead.db.db.listCollections().toArray()).map((c) => c.name)
console.log('  campaign collections present:', campaignsCollection.filter((n) => /campaign/i.test(n)).join(', ') || 'none')
const totalCampaigns = campaignsCollection.includes('campaigns')
  ? await Lead.db.db.collection('campaigns').countDocuments({})
  : null
console.log('  actual campaign documents  :', totalCampaigns === null ? 'n/a' : totalCampaigns)
console.log('  campaign-eligible stages   :', [...CAMPAIGN_ELIGIBLE_STAGES].join(', '))
console.log('  → campaignReady counts LEADS, not campaigns')

console.log('\n=== RECENT ENQUIRIES: does sort=-created exist? ===')
const newest = await Lead.find({ isDeleted: false })
  .sort({ createdAt: -1 }).limit(6)
  .select('reference contactPerson companyName travelDate travelDateText stage internalNotes createdAt')
  .lean()
for (const l of newest) {
  console.log(`    ${String(l.reference).padEnd(11)} ${String(l.contactPerson ?? '—').slice(0, 22).padEnd(24)} stage=${String(l.stage).padEnd(14)} travel=${l.travelDate ? l.travelDate.toISOString().slice(0, 10) : (l.travelDateText ?? '—')}`)
}

console.log('\n=== NULL/EMPTY FIELD EXPOSURE ON RECENT ROWS ===')
const [noContact, noRef, noTravel, noNotes] = await Promise.all([
  Lead.countDocuments({ isDeleted: false, $or: [{ contactPerson: null }, { contactPerson: '' }] }),
  Lead.countDocuments({ isDeleted: false, $or: [{ reference: null }, { reference: '' }] }),
  Lead.countDocuments({ isDeleted: false, travelDate: null }),
  Lead.countDocuments({ isDeleted: false, $or: [{ internalNotes: null }, { internalNotes: '' }] }),
])
console.log(`  leads with no contactPerson: ${noContact}`)
console.log(`  leads with no reference    : ${noRef}`)
console.log(`  leads with no travelDate   : ${noTravel}`)
console.log(`  leads with no remark       : ${noNotes}`)

await disconnectDatabase()
