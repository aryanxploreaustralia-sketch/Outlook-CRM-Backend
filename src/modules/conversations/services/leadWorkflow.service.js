/**
 * What a reply does to the enquiry behind it.
 *
 * A customer answering a quotation is the strongest buying signal the business
 * gets, and the pipeline should reflect it without anyone retyping. But an
 * automatic stage change rewrites a salesperson's own judgement, so this is
 * deliberately narrow:
 *
 *   1. **Only forward.** A reply can move `new → interested`; it can never pull
 *      `negotiation` back to `interested`. The person working the deal knows
 *      more than the inbox does.
 *   2. **Only from a confident match.** Below `AUTO_ADVANCE_THRESHOLD` the reply
 *      is recorded and nothing moves. Guessing which of 183 enquiries a message
 *      belongs to and then advancing that guess compounds one error into two.
 *   3. **Never on a machine reply.** An out-of-office is not interest. Treating
 *      a holiday responder as engagement is how a pipeline fills with deals
 *      nobody is working.
 *   4. **Never past a decision.** A `booked`, `completed`, `cancelled` or `lost`
 *      enquiry is left alone; those states were reached by a human.
 */

import { Lead } from '../../../models/lead.model.js'
import { Mail } from '../../../models/mail.model.js'
import { ConversationActivity } from '../../../models/conversationActivity.model.js'
import { ConversationMessage } from '../../../models/conversationMessage.model.js'
import { MAIL_STATUS } from '../../../constants/mailStatus.js'
import { createContextLogger } from '../../../utils/logger.js'
import { REPLY_KIND } from '../../campaigns/constants/campaignConstants.js'
import { LEAD_STAGE, TERMINAL_STAGES } from '../../leads/constants/leadConstants.js'
import {
  ACTIVITY_TYPE,
  AUTO_ADVANCE_THRESHOLD,
  MESSAGE_DIRECTION,
} from '../constants/conversationConstants.js'

const log = createContextLogger('conversations')

/**
 * Where a genuine human reply moves an enquiry.
 *
 * A map rather than "advance one step", so that each stage states its own
 * answer and a stage with nothing to say says so explicitly.
 *
 * Under the four-stage vocabulary only one transition is left, and it is the
 * one that matters: a customer answering a dormant enquiry has just made it a
 * live one, so `inactive` becomes `active`. An enquiry that is already active
 * stays put — a further reply is conversation, not progress — and `confirmed`
 * and `closed` are handled by the terminal check below, which a reply must
 * never reverse.
 */
export const REPLY_STAGE_TRANSITIONS = Object.freeze({
  [LEAD_STAGE.INACTIVE]: LEAD_STAGE.ACTIVE,
  [LEAD_STAGE.ACTIVE]: null,
})

/** Reply kinds that count as a human being interested. */
const ENGAGING_REPLIES = new Set([REPLY_KIND.REPLY, REPLY_KIND.REPLY_ALL, REPLY_KIND.FORWARD])

/**
 * Applies a reply to its enquiry.
 *
 * @param {{ owner, leadId, conversation, message, replyKind, confidence, actor }} params
 * @returns {Promise<{ moved: boolean, from: ?string, to: ?string, reason: string }>}
 */
export async function applyReplyToLead({
  owner,
  leadId,
  conversation,
  message,
  replyKind,
  confidence = 0,
  actor = null,
}) {
  const lead = await Lead.findOne({ _id: leadId, owner, isDeleted: false })

  if (!lead) return { moved: false, from: null, to: null, reason: 'The enquiry no longer exists.' }

  /**
   * Engagement timestamps are recorded whatever the reply kind.
   *
   * Even an out-of-office proves the address is live and reached a mailbox,
   * which is worth knowing. Only the *stage* is withheld.
   */
  lead.repliedAt = message?.occurredAt ?? new Date()
  lead.lastContactedAt = lead.lastContactedAt ?? lead.repliedAt

  // Phase H4: the denormalised reply state the list view reads.
  await recordInboundOnLead({ owner, lead, conversation, message })

  if (!ENGAGING_REPLIES.has(replyKind)) {
    await lead.save()
    return {
      moved: false,
      from: lead.stage,
      to: null,
      reason: `A ${replyKind ?? 'non-human'} reply does not move the pipeline.`,
    }
  }

  if (confidence < AUTO_ADVANCE_THRESHOLD) {
    await lead.save()
    return {
      moved: false,
      from: lead.stage,
      to: null,
      reason:
        `The reply was matched with ${Math.round(confidence * 100)}% confidence, below the ` +
        `${Math.round(AUTO_ADVANCE_THRESHOLD * 100)}% needed to change a stage automatically.`,
    }
  }

  // `confirmed` sits alongside the terminal stages here, not in them: a
  // confirmed booking is not finished, but a reply must not drag it backwards
  // to `active` as though the deal were still being won.
  if (TERMINAL_STAGES.includes(lead.stage) || lead.stage === LEAD_STAGE.CONFIRMED) {
    await lead.save()
    return {
      moved: false,
      from: lead.stage,
      to: null,
      reason: `The enquiry is ${lead.stage}; a reply does not reopen a decided deal.`,
    }
  }

  const next = REPLY_STAGE_TRANSITIONS[lead.stage] ?? null

  if (!next) {
    await lead.save()
    return { moved: false, from: lead.stage, to: null, reason: 'Already engaged; no stage change is due.' }
  }

  const from = lead.stage
  lead.moveToStage(next, { by: actor, reason: 'Customer replied' })
  await lead.save()

  await ConversationActivity.record({
    owner,
    type: ACTIVITY_TYPE.STAGE_CHANGED,
    summary: `Moved from ${from} to ${next} — the customer replied`,
    lead: lead._id,
    conversation: conversation?._id ?? null,
    company: lead.company,
    message: message?._id ?? null,
    actor,
    detail: { from, to: next, automatic: true, confidence },
  })

  log.info('Reply advanced a lead', {
    leadId: lead._id.toString(),
    reference: lead.reference,
    from,
    to: next,
    confidence,
  })

  return { moved: true, from, to: next, reason: 'The customer replied.' }
}

/**
 * Writes the reply state onto the enquiry (Phase H4).
 *
 * Mutates `lead` in place; the caller saves it. Kept here rather than in
 * `ingestMessage` because this is the one function that already owns "what a
 * reply does to a lead", and splitting that across two modules is how the two
 * end up disagreeing.
 *
 * ## Why `replyCount` is counted, not incremented
 *
 * `$inc` is only correct if this runs exactly once per message, and that is a
 * property of the *caller* — true today, one refactor away from not being.
 * A count over `{ owner, lead, direction }` is an indexed query whose answer
 * cannot drift: replay it, run it twice, run it after a partial restore, and
 * the number is still the number of inbound messages on this enquiry.
 *
 * This is the difference between a counter that is idempotent because of how it
 * is called and one that is idempotent because of what it is.
 */
async function recordInboundOnLead({ owner, lead, conversation, message }) {
  const occurredAt = message?.occurredAt ?? new Date()

  lead.replyReceived = true
  lead.replyCount = await ConversationMessage.countDocuments({
    owner,
    lead: lead._id,
    direction: MESSAGE_DIRECTION.INCOMING,
  })

  /**
   * Only ever moves forward.
   *
   * A backfill of an old thread, or a message that arrived out of order, must
   * not rewrite "last reply" to something older than one already recorded.
   */
  if (!lead.lastReplyAt || occurredAt > lead.lastReplyAt) {
    lead.lastReplyAt = occurredAt
    lead.lastInboundMail = message?._id ?? lead.lastInboundMail
  }

  if (!lead.lastActivityAt || occurredAt > lead.lastActivityAt) {
    lead.lastActivityAt = occurredAt
  }

  if (conversation?._id) lead.conversation = conversation._id

  await markOriginalReplied({ owner, lead })
}

/**
 * Marks the message this customer is answering as replied-to.
 *
 * Scoped to the enquiry's own introduction — `autoMail.mail` is the record the
 * auto-mailer wrote, and `autoMail.conversationId` is the thread it started.
 * Deliberately narrow: a broad "mark everything on this thread" sweep would
 * also re-status campaign sends to other people who happen to share it.
 *
 * Never throws outward. Mail history is a reporting surface; failing to relabel
 * a row must not cost us the reply that prompted it.
 */
async function markOriginalReplied({ owner, lead }) {
  const mailId = lead.autoMail?.mail ?? null
  if (!mailId) return

  try {
    await Mail.updateOne(
      /**
       * `userId`, not `owner` — the mail collection has been scoped by
       * `userId` since Phase 4 and every index on it is built that way.
       *
       * `status: SENT` is the guard that makes this idempotent and one-way: a
       * second reply finds the row already `replied` and matches nothing.
       */
      { _id: mailId, userId: owner, status: MAIL_STATUS.SENT },
      { $set: { status: MAIL_STATUS.REPLIED, repliedAt: new Date() } },
    )
  } catch (error) {
    log.warn('Could not mark the original message as replied', {
      lead: lead._id.toString(),
      error: error?.message,
    })
  }
}

/**
 * Moves an enquiry by hand.
 *
 * Separate from the automatic path because the rules differ: a person may move
 * a lead anywhere, including backwards and into a terminal state. The shared
 * part is the activity record, so both show up identically on the timeline.
 */
export async function moveLeadStage({ owner, leadId, stage, actor = null, reason = null, conversation = null }) {
  const lead = await Lead.findOne({ _id: leadId, owner, isDeleted: false })
  if (!lead) return null

  const from = lead.stage
  if (from === stage) return lead

  lead.moveToStage(stage, { by: actor, reason: reason ?? 'Changed in the CRM' })
  await lead.save()

  await ConversationActivity.record({
    owner,
    type: ACTIVITY_TYPE.STAGE_CHANGED,
    summary: `Moved from ${from} to ${stage}`,
    lead: lead._id,
    conversation: conversation?._id ?? null,
    company: lead.company,
    actor,
    detail: { from, to: stage, automatic: false, reason },
  })

  return lead
}

export default { applyReplyToLead, moveLeadStage, REPLY_STAGE_TRANSITIONS }
