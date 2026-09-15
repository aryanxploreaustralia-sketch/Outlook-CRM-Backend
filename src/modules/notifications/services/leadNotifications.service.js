/**
 * Notifications for the enquiry lifecycle: assignment, sharing, stage.
 *
 * A thin layer over `notify()`, which does the writing, the idempotency and the
 * never-throw guarantee. What lives here is the part `notifyFromAudit` cannot
 * express: the recipients of these events are not the actor, the subject or
 * the organization, but people named by the change itself — the new owner, the
 * users added to or removed from `sharedWith`, the people who hold the enquiry.
 *
 * ## Recipients are always derived on the server
 *
 * Every function takes the enquiry as loaded and saved by the controller, and
 * the added/removed lists the controller computed from the stored document. No
 * id here comes from a request body unless the controller has already checked
 * it, and the actor is always removed — nobody is told what they just did.
 *
 * ## Bulk operations notify each person once
 *
 * Sharing a register of 500 enquiries with five people raises five
 * notifications, not 2,500. Moving 40 enquiries' stage raises one per person
 * who holds any of them, carrying the count.
 *
 * ## Duplicates
 *
 * `(owner, dedupeKey)` is unique. Stage keys use the stage-history length, so a
 * retried save of the same transition is a no-op. Sharing is naturally
 * idempotent because a repeat save computes empty added/removed lists; its key
 * carries a timestamp so that a genuine re-share after a revoke is announced.
 */

import { NOTIFICATION_TYPE } from '../../../models/notification.model.js'
import { LEAD_STAGE_LABELS } from '../../leads/constants/leadConstants.js'
import { linkFor, notify } from './notifier.service.js'

/** "ABC Education (XA123)", or whichever half exists. */
function leadName(lead) {
  const company = lead?.companyName?.trim()
  const reference = lead?.reference

  if (company && reference) return `${company} (${reference})`
  return company || reference || 'an enquiry'
}

const actorNameOf = (actor) => actor?.displayName || actor?.email || 'A colleague'
const actorIdOf = (actor) => (actor?._id ? String(actor._id) : null)
const stageLabel = (stage) => LEAD_STAGE_LABELS[stage] ?? stage ?? 'Unknown'

/** Distinct string ids, never including the actor. */
function recipientsExcept(ids, actor) {
  const me = actorIdOf(actor)
  return [...new Set((ids ?? []).filter(Boolean).map(String))].filter((id) => id !== me)
}

const leadRefs = (lead) => ({
  lead: lead._id,
  company: lead.company ?? null,
  contact: lead.contact ?? null,
})

/**
 * A new enquiry was created for somebody other than its creator.
 *
 * This is the "lead created" notification as well: an enquiry you create for
 * yourself needs no bell, and one created for a colleague is an assignment.
 */
export function notifyLeadAssigned({ lead, assignee, actor }) {
  const recipients = recipientsExcept([assignee], actor)
  if (!lead?._id || recipients.length === 0) return Promise.resolve(0)

  const type = NOTIFICATION_TYPE.LEAD_ASSIGNED

  return notify({
    type,
    recipients,
    title: 'New Lead Assigned',
    body: `${actorNameOf(actor)} assigned you the Lead ${leadName(lead)}.`,
    link: linkFor(type, { id: lead._id }),
    // An enquiry is assigned once, at creation; ownership never moves after.
    dedupeKey: `lead:${lead._id}:assigned`,
    target: { type: 'lead', id: lead._id },
    actorEmail: actor?.email ?? null,
    refs: leadRefs(lead),
  })
}

/** One enquiry's `sharedWith` changed. */
export async function notifyLeadSharingChanged({ lead, added = [], removed = [], actor, at = new Date() }) {
  if (!lead?._id) return 0

  const stamp = at.getTime()
  const name = leadName(lead)
  let written = 0

  const gained = recipientsExcept(added, actor)
  if (gained.length > 0) {
    written += await notify({
      type: NOTIFICATION_TYPE.LEAD_SHARED,
      recipients: gained,
      title: 'Lead Shared With You',
      body: `${actorNameOf(actor)} shared the Lead ${name} with you.`,
      link: linkFor(NOTIFICATION_TYPE.LEAD_SHARED, { id: lead._id }),
      dedupeKey: `lead:${lead._id}:shared:${stamp}`,
      target: { type: 'lead', id: lead._id },
      actorEmail: actor?.email ?? null,
      refs: leadRefs(lead),
    })
  }

  const lost = recipientsExcept(removed, actor)
  if (lost.length > 0) {
    written += await notify({
      type: NOTIFICATION_TYPE.LEAD_SHARING_REVOKED,
      recipients: lost,
      title: 'Lead Access Removed',
      body: `Your access to the Lead ${name} has been removed.`,
      link: null,
      dedupeKey: `lead:${lead._id}:revoked:${stamp}`,
      target: { type: 'lead', id: lead._id },
      actorEmail: actor?.email ?? null,
      // Deliberately no `lead` ref: the bell would offer to open an enquiry the
      // reader can no longer see.
    })
  }

  return written
}

/** A manager's whole register was shared or unshared. One bell per person. */
export async function notifyBulkSharingChanged({
  owner,
  added = [],
  removed = [],
  leadCount = 0,
  actor,
  at = new Date(),
}) {
  if (!owner || leadCount <= 0) return 0

  const stamp = at.getTime()
  const who = actorNameOf(actor)
  const noun = leadCount === 1 ? 'Lead' : 'Leads'
  let written = 0

  const gained = recipientsExcept(added, actor)
  if (gained.length > 0) {
    written += await notify({
      type: NOTIFICATION_TYPE.LEAD_SHARED,
      recipients: gained,
      title: 'Leads Shared With You',
      body: `${who} shared ${leadCount} ${noun} with you.`,
      link: '/leads',
      dedupeKey: `bulk-share:${owner}:${stamp}`,
      target: { type: 'user', id: owner },
      actorEmail: actor?.email ?? null,
    })
  }

  const lost = recipientsExcept(removed, actor)
  if (lost.length > 0) {
    written += await notify({
      type: NOTIFICATION_TYPE.LEAD_SHARING_REVOKED,
      recipients: lost,
      title: 'Lead Access Removed',
      body: `Your access to ${leadCount} ${noun} shared by ${who} has been removed.`,
      link: null,
      dedupeKey: `bulk-revoke:${owner}:${stamp}`,
      target: { type: 'user', id: owner },
      actorEmail: actor?.email ?? null,
    })
  }

  return written
}

/** One enquiry moved stage. Its owner and the people it is shared with hear. */
export function notifyLeadStageChanged({ lead, from, actor }) {
  if (!lead?._id || !lead.stage || lead.stage === from) return Promise.resolve(0)

  const recipients = recipientsExcept([lead.owner, ...(lead.sharedWith ?? [])], actor)
  if (recipients.length === 0) return Promise.resolve(0)

  const type = NOTIFICATION_TYPE.LEAD_STAGE_CHANGED

  return notify({
    type,
    recipients,
    title: 'Lead Status Updated',
    body: `${leadName(lead)} moved from ${stageLabel(from)} to ${stageLabel(lead.stage)}.`,
    link: linkFor(type, { id: lead._id }),
    // One key per transition: the history only grows, so a retried save of the
    // same move cannot raise a second bell.
    dedupeKey: `lead:${lead._id}:stage:${lead.stageHistory?.length ?? 0}:${lead.stage}`,
    target: { type: 'lead', id: lead._id },
    actorEmail: actor?.email ?? null,
    refs: leadRefs(lead),
  })
}

/**
 * Many enquiries moved to one stage.
 *
 * Grouped by recipient, so a person holding 30 of the 40 gets one bell saying
 * 30, not 30 bells. A single enquiry per person reads exactly like the
 * single-enquiry notification, with its link.
 */
export async function notifyBulkStageChanged({ leads = [], stage, actor, at = new Date() }) {
  const byRecipient = new Map()

  for (const lead of leads) {
    for (const id of recipientsExcept([lead.owner, ...(lead.sharedWith ?? [])], actor)) {
      if (!byRecipient.has(id)) byRecipient.set(id, [])
      byRecipient.get(id).push(lead)
    }
  }

  const type = NOTIFICATION_TYPE.LEAD_STAGE_CHANGED
  const stamp = at.getTime()
  let written = 0

  for (const [recipient, held] of byRecipient) {
    const single = held.length === 1 ? held[0] : null

    written += await notify({
      type,
      recipients: [recipient],
      title: 'Lead Status Updated',
      body: single
        ? `${leadName(single)} moved to ${stageLabel(stage)}.`
        : `${actorNameOf(actor)} moved ${held.length} Leads to ${stageLabel(stage)}.`,
      link: single ? linkFor(type, { id: single._id }) : '/leads',
      dedupeKey: single
        ? `lead:${single._id}:stage:${single.stageHistory?.length ?? 0}:${stage}`
        : `bulk-stage:${actorIdOf(actor)}:${stamp}`,
      target: single ? { type: 'lead', id: single._id } : { type: 'lead', id: null },
      actorEmail: actor?.email ?? null,
      refs: single ? leadRefs(single) : {},
    })
  }

  return written
}

export default {
  notifyLeadAssigned,
  notifyLeadSharingChanged,
  notifyBulkSharingChanged,
  notifyLeadStageChanged,
  notifyBulkStageChanged,
}
