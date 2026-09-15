/**
 * Enquiry lifecycle notifications: assignment, sharing, revoke, stage.
 *
 * Runs the real `leadNotifications.service` and the real `notifier` with
 * `Notification.insertMany` intercepted and backed by an in-memory store that
 * enforces the same `(owner, dedupeKey)` uniqueness the index does. The
 * repository's owner-scoped queries are then run against that store, so the
 * unread count and cross-user isolation are asserted through the real filter.
 *
 * The controller wiring is checked from source.
 *
 * Nothing here touches a database.
 */

import { readFileSync } from 'node:fs'

const B = new URL('../src', import.meta.url).href
const { Notification, NOTIFICATION_TYPE, NOTIFICATION_DEFINITIONS } = await import(
  `${B}/models/notification.model.js`
)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}
const section = (title) => console.log(`\n=== ${title} ===`)

// --- the store ---------------------------------------------------------------

let store = []

Notification.insertMany = async (documents) => {
  let inserted = 0
  const duplicates = []

  for (const doc of documents) {
    const clash = store.some((row) => String(row.owner) === String(doc.owner) && row.dedupeKey === doc.dedupeKey)
    if (clash) {
      duplicates.push({ err: { code: 11_000 } })
      continue
    }
    store.push({ _id: `n${store.length + 1}`, isRead: false, isDeleted: false, ...doc })
    inserted += 1
  }

  if (duplicates.length > 0) {
    const error = new Error('E11000 duplicate key')
    error.writeErrors = duplicates
    error.result = { nInserted: inserted }
    throw error
  }
  return { insertedCount: inserted }
}

/** The repository's visibility filter, evaluated in memory. */
const { buildFilter } = await import(`${B}/modules/notifications/repositories/notification.repository.js`)
const visibleTo = (owner) => {
  const filter = buildFilter(owner, {})
  return store.filter(
    (row) => String(row.owner) === String(filter.owner) && row.isDeleted !== true,
  )
}
const unreadOf = (owner) => visibleTo(owner).filter((row) => !row.isRead).length
const forUser = (owner) => store.filter((row) => String(row.owner) === owner)

const svc = await import(`${B}/modules/notifications/services/leadNotifications.service.js`)

// --- the cast ----------------------------------------------------------------

const ARYAN = { _id: '0000000000000000000a0001', displayName: 'Aryan', email: 'aryan@example.test' }
const MANAGER = '0000000000000000000b0002'
const USER_B = '0000000000000000000c0003'
const USER_C = '0000000000000000000d0004'
const LEAD_ID = '00000000000000000000beef'

const lead = (over = {}) => ({
  _id: LEAD_ID,
  reference: 'XA123',
  companyName: 'ABC Education',
  owner: MANAGER,
  sharedWith: [],
  stage: 'active',
  stageHistory: [],
  company: null,
  contact: null,
  ...over,
})

// ---------------------------------------------------------------------------
section('1–2. Created for a colleague = assigned')

store = []
await svc.notifyLeadAssigned({ lead: lead(), assignee: MANAGER, actor: ARYAN })
const assigned = forUser(MANAGER)
check('the new owner is notified', assigned.length === 1)
check('with the assignment type', assigned[0]?.type === NOTIFICATION_TYPE.LEAD_ASSIGNED)
check('naming the enquiry', assigned[0]?.body?.includes('ABC Education (XA123)'), assigned[0]?.body)
check('nobody else is', store.length === 1)

store = []
await svc.notifyLeadAssigned({ lead: lead({ owner: ARYAN._id }), assignee: ARYAN._id, actor: ARYAN })
check('an enquiry created for yourself raises nothing', store.length === 0)

// ---------------------------------------------------------------------------
section('3–4. Sharing and revoking')

store = []
await svc.notifyLeadSharingChanged({ lead: lead(), added: [USER_B], removed: [USER_C], actor: ARYAN })
const shared = forUser(USER_B)
const revoked = forUser(USER_C)
check('3. the recipient of access is notified', shared.length === 1 && shared[0].type === NOTIFICATION_TYPE.LEAD_SHARED)
check('   "Aryan shared the Lead ABC Education (XA123) with you."', shared[0]?.body === 'Aryan shared the Lead ABC Education (XA123) with you.', shared[0]?.body)
check('4. the person who lost access is notified', revoked.length === 1 && revoked[0].type === NOTIFICATION_TYPE.LEAD_SHARING_REVOKED)
check('   and it offers no link to an enquiry they cannot open', revoked[0]?.link === null && revoked[0]?.lead === null)
check('   the owner, who changed nothing about their access, hears nothing', forUser(MANAGER).length === 0)

store = []
await svc.notifyLeadSharingChanged({ lead: lead(), added: [ARYAN._id, USER_B], removed: [], actor: ARYAN })
check('the actor is never told about their own change', forUser(ARYAN._id).length === 0 && forUser(USER_B).length === 1)

// ---------------------------------------------------------------------------
section('7. Stage change')

store = []
const moved = lead({ owner: MANAGER, sharedWith: [USER_B], stage: 'confirmed', stageHistory: [{ from: 'active', to: 'confirmed' }] })
await svc.notifyLeadStageChanged({ lead: moved, from: 'active', actor: ARYAN })
check('the owner is notified', forUser(MANAGER).length === 1)
check('the shared user is notified', forUser(USER_B).length === 1)
check('an unrelated user is not', forUser(USER_C).length === 0)
check('"ABC Education (XA123) moved from Active to Confirmed."', forUser(MANAGER)[0]?.body === 'ABC Education (XA123) moved from Active to Confirmed.', forUser(MANAGER)[0]?.body)

store = []
await svc.notifyLeadStageChanged({ lead: lead({ stage: 'active' }), from: 'active', actor: ARYAN })
check('no move, no notification', store.length === 0)

store = []
await svc.notifyLeadStageChanged({ lead: moved, from: 'active', actor: { _id: MANAGER, displayName: 'Manager' } })
check('the owner moving their own enquiry notifies only the shared user', forUser(MANAGER).length === 0 && forUser(USER_B).length === 1)

// ---------------------------------------------------------------------------
section('9–10. Unread, and where a click goes')

store = []
await svc.notifyLeadAssigned({ lead: lead(), assignee: MANAGER, actor: ARYAN })
await svc.notifyLeadSharingChanged({ lead: lead(), added: [USER_B], actor: ARYAN })
await svc.notifyLeadStageChanged({ lead: moved, from: 'active', actor: ARYAN })
check('9. every one is unread when written', store.every((row) => row.isRead === false))
check('10. assignment opens the Lead detail', forUser(MANAGER).find((r) => r.type === 'lead_assigned')?.link === `/leads/${LEAD_ID}`)
check('    sharing opens the Lead detail', forUser(USER_B).find((r) => r.type === 'lead_shared')?.link === `/leads/${LEAD_ID}`)
check('    stage opens the Lead detail', forUser(USER_B).find((r) => r.type === 'lead_stage_changed')?.link === `/leads/${LEAD_ID}`)
check('    and each carries the lead reference', store.filter((r) => r.type !== 'lead_sharing_revoked').every((r) => String(r.lead) === LEAD_ID))

// ---------------------------------------------------------------------------
section('11. Duplicates')

store = []
for (let i = 0; i < 3; i += 1) {
  await svc.notifyLeadAssigned({ lead: lead(), assignee: MANAGER, actor: ARYAN })
}
check('a retried assignment writes one row', forUser(MANAGER).length === 1)

store = []
for (let i = 0; i < 3; i += 1) {
  await svc.notifyLeadStageChanged({ lead: moved, from: 'active', actor: ARYAN })
}
check('a retried stage move writes one row per person', forUser(MANAGER).length === 1 && forUser(USER_B).length === 1)

store = []
const at = new Date('2026-09-15T10:00:00Z')
await svc.notifyLeadSharingChanged({ lead: lead(), added: [USER_B], actor: ARYAN, at })
await svc.notifyLeadSharingChanged({ lead: lead(), added: [USER_B], actor: ARYAN, at })
check('the same share delivered twice writes one row', forUser(USER_B).length === 1)

await svc.notifyLeadSharingChanged({ lead: lead(), removed: [USER_B], actor: ARYAN, at: new Date(at.getTime() + 1000) })
await svc.notifyLeadSharingChanged({ lead: lead(), added: [USER_B], actor: ARYAN, at: new Date(at.getTime() + 2000) })
check('a genuine re-share after a revoke is announced again', forUser(USER_B).filter((r) => r.type === 'lead_shared').length === 2)

// ---------------------------------------------------------------------------
section('12. Bulk operations do not spam')

store = []
const five = [USER_B, USER_C, '0000000000000000000e0005', '0000000000000000000f0006', '000000000000000000100007']
await svc.notifyBulkSharingChanged({ owner: MANAGER, added: five, leadCount: 500, actor: { _id: MANAGER, displayName: 'Manager' } })
check('500 Leads shared with 5 users writes 5 notifications, not 2,500', store.length === 5, `${store.length}`)
check('"Manager shared 500 Leads with you."', store[0]?.body === 'Manager shared 500 Leads with you.', store[0]?.body)
check('each opens the Leads list', store.every((r) => r.link === '/leads'))

store = []
await svc.notifyBulkSharingChanged({ owner: MANAGER, removed: [USER_B, USER_C], leadCount: 500, actor: { _id: MANAGER, displayName: 'Manager' } })
check('bulk revoke: one per affected user', store.length === 2 && store.every((r) => r.type === 'lead_sharing_revoked'))

store = []
await svc.notifyBulkSharingChanged({ owner: MANAGER, added: [USER_B], leadCount: 0, actor: ARYAN })
check('a register with no enquiries raises nothing', store.length === 0)

store = []
const forty = Array.from({ length: 40 }, (_, i) =>
  lead({ _id: `00000000000000000000${String(1000 + i)}`, owner: ARYAN._id, sharedWith: i < 30 ? [USER_B] : [], stage: 'closed', stageHistory: [{}] }),
)
await svc.notifyBulkStageChanged({ leads: forty, stage: 'closed', actor: ARYAN })
check('40 moved, 30 shared with B: B gets exactly one', forUser(USER_B).length === 1)
check('   saying 30', forUser(USER_B)[0]?.body === 'Aryan moved 30 Leads to Closed.', forUser(USER_B)[0]?.body)
check('   the owner-actor gets none', forUser(ARYAN._id).length === 0)

store = []
await svc.notifyBulkStageChanged({ leads: [forty[0]], stage: 'closed', actor: ARYAN })
check('a bulk move touching one of theirs links to that Lead', forUser(USER_B)[0]?.link === `/leads/${forty[0]._id}`)

// ---------------------------------------------------------------------------
section('13–14. Isolation and the unread count')

store = []
await svc.notifyLeadSharingChanged({ lead: lead(), added: [USER_B], actor: ARYAN })
await svc.notifyLeadStageChanged({ lead: moved, from: 'active', actor: ARYAN })
check('13. user C sees none of B\'s notifications', visibleTo(USER_C).length === 0)
check('    the repository filter is owner-scoped', buildFilter(USER_B, { owner: USER_C }).owner === USER_B)
check('14. B\'s unread count is exactly their rows', unreadOf(USER_B) === 2, `${unreadOf(USER_B)}`)
check('    the manager\'s is theirs', unreadOf(MANAGER) === 1)
store.find((r) => String(r.owner) === USER_B).isRead = true
check('    marking one read lowers only B\'s count', unreadOf(USER_B) === 1 && unreadOf(MANAGER) === 1)

// ---------------------------------------------------------------------------
section('Never throws')

const original = Notification.insertMany
Notification.insertMany = async () => {
  throw new Error('connection lost')
}
let threw = false
try {
  await svc.notifyLeadAssigned({ lead: lead(), assignee: MANAGER, actor: ARYAN })
  await svc.notifyBulkStageChanged({ leads: forty, stage: 'closed', actor: ARYAN })
} catch {
  threw = true
}
check('a failed write never breaks the operation', !threw)
Notification.insertMany = original

// ---------------------------------------------------------------------------
section('Types and wiring')

for (const type of ['LEAD_SHARED', 'LEAD_SHARING_REVOKED', 'LEAD_STAGE_CHANGED']) {
  check(`${type} is a registered type with a label`, Boolean(NOTIFICATION_DEFINITIONS[NOTIFICATION_TYPE[type]]?.label))
}
check('8. reply notification types are unchanged', NOTIFICATION_TYPE.REPLY_RECEIVED === 'reply_received' && NOTIFICATION_TYPE.REPLY_UNMATCHED === 'reply_unmatched')

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const controller = strip(readFileSync(new URL('../src/modules/leads/controllers/lead.controller.js', import.meta.url), 'utf8'))
const sync = readFileSync(new URL('../src/modules/conversations/services/conversationSync.service.js', import.meta.url), 'utf8')

check('create notifies only when assigned to someone else', /String\(owner\) !== String\(creator\)\)\s*\{\s*void notifyLeadAssigned/.test(controller))
check('update and updateFull notify only on a real stage move', (controller.match(/lead\.stage !== stageBefore/g) ?? []).length === 2)
check('bulkStage raises one aggregated call', (controller.match(/notifyBulkStageChanged\(/g) ?? []).length === 1)
check('single sharing notifies from the computed diff', controller.includes('notifyLeadSharingChanged({ lead, added, removed'))
check('bulk sharing raises one aggregated call', (controller.match(/notifyBulkSharingChanged\(/g) ?? []).length === 1)
check('no recipient is read from the request body', !/notify\w+\(\{[^}]*req\.body/.test(controller))
check('8. reply notifications are still raised by the sync', sync.includes('type: NOTIFICATION_TYPE.REPLY_RECEIVED'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
