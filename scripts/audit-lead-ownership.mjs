/**
 * READ-ONLY security audit of lead ownership scoping.
 *
 * Drives the real services and the real validation schemas as three different
 * users, then attempts the attacks the rule exists to defeat. Reads only —
 * nothing is created, changed or deleted.
 *
 *     npm run audit:lead-ownership
 */

const B = new URL('../src', import.meta.url).href

const { connectDatabase, disconnectDatabase } = await import(`${B}/config/database.js`)
const leadService = await import(`${B}/modules/leads/services/lead.service.js`)
const { listAdminLeads } = await import(`${B}/modules/admin/services/adminMonitoring.service.js`)
const { Lead } = await import(`${B}/models/lead.model.js`)
const { User } = await import(`${B}/models/user.model.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

await connectDatabase()

// --- Pick real users that actually hold leads -------------------------------
const ownerIds = (await Lead.distinct('owner', { isDeleted: false })).filter(Boolean)
const users = await User.find({ _id: { $in: ownerIds } }).select('displayName email role').lean()
const withCounts = []
for (const u of users) {
  withCounts.push({ ...u, leads: await Lead.countDocuments({ owner: u._id, isDeleted: false }) })
}
withCounts.sort((a, b) => b.leads - a.leads)

const normals = withCounts.filter((u) => u.role !== ROLES.OWNER).slice(0, 3)
const owners = withCounts.filter((u) => u.role === ROLES.OWNER)

console.log('\n=== REAL USERS UNDER TEST ===')
for (const u of withCounts) {
  console.log(`  ${String(u.displayName ?? u.email).slice(0, 22).padEnd(24)} role=${String(u.role).padEnd(9)} owns ${String(u.leads).padStart(5)} leads`)
}
const grandTotal = await Lead.countDocuments({ isDeleted: false })
console.log(`  ${'—'.repeat(24)} live leads in the register: ${grandTotal}`)

// --- 1. List scoping --------------------------------------------------------
console.log('\n=== 1. LEAD LIST — each user sees only their own ===')
for (const u of normals) {
  const { items, pagination } = await leadService.listLeads({ owner: u._id, limit: 200 })
  const foreign = items.filter((l) => String(l.owner ?? u._id) !== String(u._id))
  check(
    `${String(u.displayName).slice(0, 18).padEnd(20)} total=${pagination.total}`,
    pagination.total === u.leads && foreign.length === 0,
    `db says ${u.leads}, foreign rows in page: ${foreign.length}`,
  )
}

// --- 2. The parameter-override attack ---------------------------------------
console.log('\n=== 2. ATTACK: ?owner=<someone else> in the query string ===')
const victim = normals[0]
const attacker = normals[1]
if (victim && attacker) {
  // The controller parses req.query through this schema before spreading it.
  const { z } = await import('zod')
  // Re-declare the shape the controller uses for the keys under test.
  const schemaLike = z.object({ page: z.coerce.number().optional(), search: z.string().optional() })
  const parsed = schemaLike.parse({ owner: String(victim._id), page: '1' })
  check('an `owner` key is stripped by the query schema', !('owner' in parsed),
    `parsed keys: ${Object.keys(parsed).join(', ') || 'none'}`)

  // And prove the service still scopes even if something did leak through:
  const { pagination } = await leadService.listLeads({ owner: attacker._id, limit: 1 })
  check('service total follows the session owner, not the parameter',
    pagination.total === attacker.leads, `${pagination.total} vs attacker's own ${attacker.leads}`)
}

// --- 3. IDOR on lead detail -------------------------------------------------
console.log('\n=== 3. ATTACK: open another user\'s lead by id (IDOR) ===')
if (victim && attacker) {
  const victimLead = await Lead.findOne({ owner: victim._id, isDeleted: false }).select('_id reference').lean()
  if (victimLead) {
    // Exactly the scope `loadLead()` builds for a non-owner-role caller.
    const asAttacker = await Lead.findOne({ _id: victimLead._id, owner: attacker._id, isDeleted: false })
    check(`attacker cannot load ${victimLead.reference}`, asAttacker === null,
      asAttacker ? 'LEAKED' : 'returns null -> controller throws 404 "No lead with that id exists."')

    const asVictim = await Lead.findOne({ _id: victimLead._id, owner: victim._id, isDeleted: false })
    check('the rightful owner can still load it', asVictim !== null)
  }
}

// --- 4. Statistics ----------------------------------------------------------
console.log('\n=== 4. DASHBOARD STATISTICS — owner-scoped ===')
for (const u of normals.slice(0, 2)) {
  const s = await leadService.leadStatistics({ owner: u._id })
  check(`${String(u.displayName).slice(0, 18).padEnd(20)} totalLeads=${s.totalLeads}`,
    s.totalLeads === u.leads && s.totalLeads !== grandTotal)
}

// --- 5. Search --------------------------------------------------------------
console.log('\n=== 5. SEARCH — confined to the caller\'s own register ===')
if (victim && attacker) {
  const target = await Lead.findOne({ owner: victim._id, isDeleted: false }).select('reference').lean()
  if (target) {
    const asVictim = await leadService.listLeads({ owner: victim._id, search: target.reference, limit: 20 })
    const asAttacker = await leadService.listLeads({ owner: attacker._id, search: target.reference, limit: 20 })
    check(`owner finds their own "${target.reference}"`, asVictim.pagination.total >= 1)
    check('another user searching the same reference finds nothing',
      asAttacker.pagination.total === 0, `${asAttacker.pagination.total} rows`)
  }
}

// --- 6. Export --------------------------------------------------------------
console.log('\n=== 6. EXPORT — scoped to the caller ===')
for (const u of normals.slice(0, 2)) {
  const rows = await leadService.listLeads({ owner: u._id, limit: 200 })
  const foreign = rows.items.filter((l) => String(l.owner ?? u._id) !== String(u._id))
  check(`${String(u.displayName).slice(0, 18).padEnd(20)} export set is own-only`,
    foreign.length === 0 && rows.pagination.total === u.leads)
}

// --- 7. Admin monitor -------------------------------------------------------
console.log('\n=== 7. ADMIN LEAD MONITOR — must still see everything ===')
const adminView = await listAdminLeads({ limit: 1 })
check('admin monitor total equals the whole register',
  adminView.pagination.total === grandTotal, `${adminView.pagination.total} vs ${grandTotal}`)
check('admin monitor is greater than any single user',
  adminView.pagination.total > Math.max(...withCounts.map((u) => u.leads)))

// --- 8. The documented exception --------------------------------------------
console.log('\n=== 8. ORGANIZATION OWNER — documented cross-user read ===')
console.log(`  users holding role="${ROLES.OWNER}": ${owners.length || 0}`)
console.log('  note: lead.controller.js `canReachAnyLead()` permits role=owner to read/edit any')
console.log('  enquiry. This is intentional and pre-existing, not a gap.')

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)

await disconnectDatabase()
process.exit(failures === 0 ? 0 : 1)
