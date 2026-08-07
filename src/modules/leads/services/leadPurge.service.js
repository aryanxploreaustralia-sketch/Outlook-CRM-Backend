/**
 * Removes every lead, and only lead data.
 *
 * A development convenience: re-import a workbook, test, clear, repeat. It is
 * deliberately narrow, because the collections around leads are shared and
 * deleting one row too many costs a Microsoft reconnect or a customer's
 * correspondence history.
 *
 * ## What goes
 *
 * Leads, and everything embedded in them — stage history, field history and the
 * auto-mail record all live on the document and leave with it. Plus the lead
 * timeline entries and lead tasks that exist for no other reason.
 *
 * ## What stays, and how orphans are avoided
 *
 * Companies, contacts, campaigns, mail history, conversations, import history
 * and every authentication record are untouched. But five collections carry a
 * `lead` reference, and deleting the leads under them would leave pointers to
 * documents that no longer exist. Each is handled explicitly:
 *
 *   - an activity or task that belongs **only** to a lead is deleted with it;
 *   - one that also belongs to a conversation keeps its conversation and has
 *     its `lead` cleared, because the customer's correspondence is not lead
 *     data and must survive;
 *   - conversations, messages and attachments have `lead` cleared and become
 *     unmatched, which is what they honestly now are.
 *
 * Nothing is left pointing at a deleted document.
 */

import { Conversation } from '../../../models/conversation.model.js'
import { ConversationActivity } from '../../../models/conversationActivity.model.js'
import { ConversationAttachment } from '../../../models/conversationAttachment.model.js'
import { ConversationMessage } from '../../../models/conversationMessage.model.js'
import { Company } from '../../../models/company.model.js'
import { Contact } from '../../../models/contact.model.js'
import { Lead } from '../../../models/lead.model.js'
import { LeadTask } from '../../../models/leadTask.model.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('leads')

/**
 * Counts what a purge would remove, without removing it.
 *
 * Used by the confirmation dialog so the number shown to the user is measured
 * rather than guessed.
 */
export async function previewPurge({ owner }) {
  const [leads, timeline, tasks, conversations] = await Promise.all([
    Lead.countDocuments({ owner }),
    ConversationActivity.countDocuments({ owner, lead: { $ne: null } }),
    LeadTask.countDocuments({ owner, lead: { $ne: null } }),
    Conversation.countDocuments({ owner, lead: { $ne: null } }),
  ])

  return { leads, timelineEntries: timeline, tasks, conversationsToUnlink: conversations }
}

/**
 * Deletes every lead belonging to one owner.
 *
 * @param {{ owner: any }} params
 * @returns {Promise<object>} Per-collection detail, for the audit record.
 */
export async function purgeLeads({ owner }) {
  const startedAt = Date.now()

  const leadCount = await Lead.countDocuments({ owner })

  // Nothing to do is a success, not a failure — the caller asked for an empty
  // register and an empty register is what they have.
  if (leadCount === 0) {
    return {
      deletedLeads: 0,
      empty: true,
      detail: {
        timelineDeleted: 0,
        timelineUnlinked: 0,
        tasksDeleted: 0,
        tasksUnlinked: 0,
        conversationsUnlinked: 0,
        messagesUnlinked: 0,
        attachmentsUnlinked: 0,
        companiesRecounted: 0,
        contactsRecounted: 0,
      },
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    }
  }

  // --- 1. Timeline entries -------------------------------------------------
  //
  // Split by whether they also belong to a conversation. A "reply received"
  // entry is part of the customer's correspondence and survives; a "lead
  // imported" entry has no meaning once the lead is gone.
  const [timelineDeleted, timelineUnlinked] = await Promise.all([
    ConversationActivity.deleteMany({ owner, lead: { $ne: null }, conversation: null }),
    ConversationActivity.updateMany(
      { owner, lead: { $ne: null }, conversation: { $ne: null } },
      { $set: { lead: null } },
    ),
  ])

  // --- 2. Tasks and follow-ups ---------------------------------------------
  const [tasksDeleted, tasksUnlinked] = await Promise.all([
    LeadTask.deleteMany({ owner, lead: { $ne: null }, conversation: null }),
    LeadTask.updateMany(
      { owner, lead: { $ne: null }, conversation: { $ne: null } },
      { $set: { lead: null } },
    ),
  ])

  // --- 3. Conversations become unmatched -----------------------------------
  //
  // The thread survives — it is the customer's mail, not lead data. Its match
  // strategy is reset alongside the reference, because a conversation claiming
  // it was "matched on the reply header" while pointing at nothing would be a
  // lie the UI then repeats.
  const conversationsUnlinked = await Conversation.updateMany(
    { owner, lead: { $ne: null } },
    { $set: { lead: null, matchStrategy: 'unmatched', matchConfidence: 0 } },
  )

  const [messagesUnlinked, attachmentsUnlinked] = await Promise.all([
    ConversationMessage.updateMany({ owner, lead: { $ne: null } }, { $set: { lead: null } }),
    ConversationAttachment.updateMany({ owner, lead: { $ne: null } }, { $set: { lead: null } }),
  ])

  // --- 4. The leads themselves ---------------------------------------------
  //
  // Last, so nothing above can find a lead already gone. Stage history, field
  // history and the auto-mail record are embedded and leave with the document.
  const deleted = await Lead.deleteMany({ owner })

  // --- 5. Roll-ups the leads fed ------------------------------------------
  //
  // Companies and contacts stay, but their lead counters would otherwise keep
  // claiming enquiries that no longer exist.
  const [companies, contacts] = await Promise.all([
    Company.updateMany({ owner }, { $set: { leadCount: 0, lastLeadAt: null } }),
    Contact.updateMany({ owner }, { $set: { leadCount: 0 } }),
  ])

  const result = {
    deletedLeads: deleted.deletedCount,
    empty: false,
    detail: {
      timelineDeleted: timelineDeleted.deletedCount,
      timelineUnlinked: timelineUnlinked.modifiedCount,
      tasksDeleted: tasksDeleted.deletedCount,
      tasksUnlinked: tasksUnlinked.modifiedCount,
      conversationsUnlinked: conversationsUnlinked.modifiedCount,
      messagesUnlinked: messagesUnlinked.modifiedCount,
      attachmentsUnlinked: attachmentsUnlinked.modifiedCount,
      companiesRecounted: companies.modifiedCount,
      contactsRecounted: contacts.modifiedCount,
    },
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  }

  log.warn('All leads deleted', { owner: String(owner), ...result.detail, deletedLeads: result.deletedLeads })

  return result
}

export default { purgeLeads, previewPurge }
