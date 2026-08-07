/**
 * Turns mailbox traffic into lead conversations.
 *
 * Sits downstream of the Phase 5 sync engine, which already fetches messages
 * and stores them as `Mail` records. This module does the part that makes them
 * a CRM rather than an inbox: match each message to an enquiry, thread it, and
 * write the business history.
 *
 * ## Nothing is ever dropped
 *
 * A message that cannot be matched still becomes a conversation — with
 * `lead: null` and a stated reason. Refusing to store customer mail because the
 * algorithm was unsure is the one failure this module must not have.
 *
 * ## Idempotent
 *
 * Keyed on `providerMessageId`, so a delta replay or an overlapping full sync
 * converges instead of duplicating. That matters because Graph delta tokens
 * expire with a 410 and the recovery is a full resync of the same window.
 */

import { Conversation } from '../../../models/conversation.model.js'
import { ConversationActivity } from '../../../models/conversationActivity.model.js'
import { ConversationAttachment, screenAttachment } from '../../../models/conversationAttachment.model.js'
import { ConversationMessage } from '../../../models/conversationMessage.model.js'
import { Lead } from '../../../models/lead.model.js'
import { Notification, NOTIFICATION_TYPE } from '../../../models/notification.model.js'
import { createContextLogger } from '../../../utils/logger.js'
import { classifyReply } from '../../campaigns/services/replyDetection.service.js'
import { REPLY_KIND } from '../../campaigns/constants/campaignConstants.js'
import {
  ACTIVITY_TYPE,
  CONVERSATION_STATUS,
  MATCH_STRATEGY,
  MESSAGE_DIRECTION,
  MESSAGE_SYNC_STATUS,
} from '../constants/conversationConstants.js'
import { matchInboundMessage } from './replyMatching.service.js'
import { applyReplyToLead } from './leadWorkflow.service.js'

const log = createContextLogger('conversations')

/**
 * Reply kinds worth interrupting somebody for (Phase H4).
 *
 * A human wrote back. An out-of-office, an auto-responder and a bounce did not,
 * and each still lands on the timeline where it belongs.
 */
const NOTIFIABLE_REPLIES = new Set([REPLY_KIND.REPLY, REPLY_KIND.REPLY_ALL, REPLY_KIND.FORWARD])

/** Maps a reply classification onto the activity written to the timeline. */
const ACTIVITY_FOR_REPLY = {
  [REPLY_KIND.REPLY]: ACTIVITY_TYPE.REPLY_RECEIVED,
  [REPLY_KIND.REPLY_ALL]: ACTIVITY_TYPE.REPLY_RECEIVED,
  [REPLY_KIND.FORWARD]: ACTIVITY_TYPE.FORWARD_RECEIVED,
  [REPLY_KIND.OUT_OF_OFFICE]: ACTIVITY_TYPE.AUTO_REPLY_RECEIVED,
  [REPLY_KIND.AUTO_REPLY]: ACTIVITY_TYPE.AUTO_REPLY_RECEIVED,
  [REPLY_KIND.BOUNCE]: ACTIVITY_TYPE.BOUNCE_RECEIVED,
}

/**
 * Ingests one provider message.
 *
 * @param {{ owner, message, provider, direction, campaign?, actor? }} params
 * @returns {Promise<{ outcome, conversation, message, match }>}
 */
export async function ingestMessage({
  owner,
  message,
  provider = null,
  direction = MESSAGE_DIRECTION.INCOMING,
  campaign = null,
  actor = null,
}) {
  const providerMessageId = message?.providerMessageId ?? null

  // Already stored — a replayed delta or an overlapping window.
  if (providerMessageId) {
    const existing = await ConversationMessage.findOne({ owner, providerMessageId })
    if (existing) {
      return { outcome: 'duplicate', conversation: null, message: existing, match: null }
    }
  }

  const isIncoming = direction === MESSAGE_DIRECTION.INCOMING

  /**
   * Matching runs on inbound mail only.
   *
   * An outgoing message already knows its conversation — the caller sent it and
   * passes the thread. Running the matcher on our own mail would try to infer
   * from our own address and reach `sender_ambiguous` every time.
   */
  const match = isIncoming
    ? await matchInboundMessage({ owner, message })
    : { strategy: MATCH_STRATEGY.THREAD_ID, confidence: 1, lead: null, conversation: null, candidates: [], detail: null }

  const conversation = await resolveConversation({ owner, message, match, provider, campaign })

  const classification = isIncoming
    ? classifyReply({
        subject: message?.subject,
        bodyText: message?.bodyText,
        headers: message?.headers ?? {},
        to: message?.to ?? [],
        cc: message?.cc ?? [],
      })
    : { kind: null }

  const occurredAt =
    (isIncoming ? message?.receivedAt : message?.sentAt) ?? message?.sentAt ?? message?.receivedAt ?? new Date()

  const stored = await ConversationMessage.create({
    owner,
    conversation: conversation._id,
    lead: conversation.lead,
    direction,
    from: message?.from ?? {},
    to: message?.to ?? [],
    cc: message?.cc ?? [],
    bcc: message?.bcc ?? [],
    subject: message?.subject ?? '',
    bodyHtml: message?.bodyHtml ?? '',
    bodyText: message?.bodyText ?? '',
    internetMessageId: message?.internetMessageId ?? null,
    inReplyTo: message?.inReplyTo ?? null,
    references: message?.references ?? [],
    provider,
    providerMessageId,
    providerConversationId: message?.conversationId ?? null,
    mail: message?.mailId ?? null,
    campaign,
    occurredAt,
    receivedAt: isIncoming ? (message?.receivedAt ?? occurredAt) : null,
    sentAt: isIncoming ? (message?.sentAt ?? null) : (message?.sentAt ?? occurredAt),
    importance: message?.importance ?? 'normal',
    replyKind: classification.kind,
    isRead: isIncoming ? Boolean(message?.isRead) : true,
    hasAttachments: Boolean(message?.hasAttachments),
    attachmentCount: (message?.attachments ?? []).length,
    syncStatus: message?.bodyHtml || message?.bodyText ? MESSAGE_SYNC_STATUS.SYNCED : MESSAGE_SYNC_STATUS.PARTIAL,
  })

  await recordAttachments({ owner, conversation, message: stored, attachments: message?.attachments ?? [] })

  // The thread's id set must include this message, or a reply naming it will
  // not match.
  if (stored.internetMessageId && !conversation.messageIds.includes(stored.internetMessageId)) {
    conversation.messageIds.push(stored.internetMessageId)
  }

  await conversation.recalculate()

  if (isIncoming) {
    await ConversationActivity.record({
      owner,
      type: ACTIVITY_FOR_REPLY[classification.kind] ?? ACTIVITY_TYPE.REPLY_RECEIVED,
      summary: replySummary(classification.kind, message),
      lead: conversation.lead,
      conversation: conversation._id,
      company: conversation.company,
      contact: conversation.contact,
      message: stored._id,
      actor,
      detail: {
        replyKind: classification.kind,
        matchStrategy: match.strategy,
        matchConfidence: match.confidence,
      },
      occurredAt,
    })

    // Advancing the enquiry is a separate concern with its own rules.
    if (conversation.lead) {
      await applyReplyToLead({
        owner,
        leadId: conversation.lead,
        conversation,
        message: stored,
        replyKind: classification.kind,
        confidence: match.confidence,
        actor,
      })
    }

    /**
     * Telling somebody (Phase H4).
     *
     * Last, and deliberately so: a notification is worth nothing if the reply
     * it points at was not stored, and everything above this line is what
     * stores it. `raiseReplyNotification` also never throws — a bell that
     * failed to ring must not roll back a customer's answer.
     */
    await raiseReplyNotification({
      owner,
      conversation,
      message: stored,
      replyKind: classification.kind,
    })
  }

  return { outcome: 'created', conversation, message: stored, match }
}

/**
 * Raises the "new customer reply" notification.
 *
 * ## What is deliberately not notified
 *
 * Out-of-office and bounce messages. They are recorded on the timeline, because
 * they are true and occasionally useful, but a bell that lights up for every
 * holiday responder is a bell people stop looking at — and the one morning it
 * means a real customer answered, nobody notices.
 *
 * ## Duplicates
 *
 * Impossible by construction, twice over. `ingestMessage` returns early for a
 * provider message it has already stored, so this is reached once per message;
 * and `dedupeKey` is uniquely indexed, so even a concurrent second call loses
 * at the database rather than producing a second entry.
 */
async function raiseReplyNotification({ owner, conversation, message, replyKind }) {
  // A machine reply is not news.
  if (!NOTIFIABLE_REPLIES.has(replyKind)) return null

  const sender = message?.from?.name || message?.from?.address || 'A customer'

  try {
    /**
     * An unmatched reply is notified too, and says so.
     *
     * This is the triage prompt. A message the matcher could not place is
     * exactly the case where a human needs to look, and silently filing it in a
     * list nobody opens is how "we never lose a reply" quietly stops being true.
     */
    if (!conversation.lead) {
      return await Notification.raise({
        owner,
        type: NOTIFICATION_TYPE.REPLY_UNMATCHED,
        dedupeKey: message._id.toString(),
        title: `Unmatched reply from ${sender}`,
        body: message.subject || '(no subject)',
        conversation: conversation._id,
        message: message._id,
        senderEmail: message?.from?.address ?? null,
        subject: message.subject ?? null,
        occurredAt: message.occurredAt,
      })
    }

    // Denormalised at write time so the bell renders from one query.
    const lead = await Lead.findById(conversation.lead).select('reference companyName contactPerson')

    return await Notification.raise({
      owner,
      type: NOTIFICATION_TYPE.REPLY_RECEIVED,
      dedupeKey: message._id.toString(),
      title: `${sender} replied${lead?.reference ? ` — ${lead.reference}` : ''}`,
      body: message.subject || '(no subject)',
      lead: conversation.lead,
      company: conversation.company,
      contact: conversation.contact,
      conversation: conversation._id,
      message: message._id,
      leadReference: lead?.reference ?? null,
      companyName: lead?.companyName ?? null,
      contactName: lead?.contactPerson ?? null,
      senderEmail: message?.from?.address ?? null,
      subject: message.subject ?? null,
      occurredAt: message.occurredAt,
    })
  } catch (error) {
    log.warn('A reply notification could not be raised', {
      message: message?._id?.toString(),
      error: error?.message,
    })
    return null
  }
}

/** One line for the timeline, worded for the kind of reply it was. */
function replySummary(kind, message) {
  const who = message?.from?.name || message?.from?.address || 'Someone'

  switch (kind) {
    case REPLY_KIND.OUT_OF_OFFICE:
      return `${who} is out of office`
    case REPLY_KIND.AUTO_REPLY:
      return `Automatic reply from ${who}`
    case REPLY_KIND.BOUNCE:
      return `Message to ${who} bounced`
    case REPLY_KIND.FORWARD:
      return `${who} forwarded the thread`
    case REPLY_KIND.REPLY_ALL:
      return `${who} replied to all`
    default:
      return `${who} replied`
  }
}

/**
 * Finds or creates the conversation a message belongs to.
 *
 * Order matters: an existing conversation from the matcher wins, then the
 * provider thread key, and only then is a new one created. Creating first and
 * merging later would leave the thread split for however long the merge took.
 */
async function resolveConversation({ owner, message, match, provider, campaign }) {
  if (match.conversation) {
    // A later message may reveal the lead an earlier unmatched one lacked.
    if (!match.conversation.lead && match.lead) {
      await attachLead({ owner, conversation: match.conversation, leadId: match.lead, match })
    }
    return match.conversation
  }

  if (message?.conversationId) {
    const existing = await Conversation.findOne({
      owner,
      providerConversationId: message.conversationId,
      isDeleted: false,
    })

    if (existing) {
      if (!existing.lead && match.lead) {
        await attachLead({ owner, conversation: existing, leadId: match.lead, match })
      }
      return existing
    }
  }

  const counterparty = message?.from?.address ?? message?.to?.[0]?.address ?? null

  /**
   * `findOneAndUpdate` with upsert rather than `create`.
   *
   * Two messages of the same thread can be ingested back to back, and the
   * unique index on `providerConversationId` would reject the second `create`
   * outright. An upsert turns that race into the reuse it should have been.
   */
  const conversation = message?.conversationId
    ? await Conversation.findOneAndUpdate(
        { owner, providerConversationId: message.conversationId },
        {
          $setOnInsert: {
            owner,
            provider,
            providerConversationId: message.conversationId,
            providerThreadId: message.threadId ?? message.conversationId,
            subject: message?.subject ?? '',
            counterpartyEmail: counterparty,
            counterpartyName: message?.from?.name ?? null,
            campaign,
            status: CONVERSATION_STATUS.AWAITING_US,
            isDeleted: false,
          },
        },
        { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
      )
    : await Conversation.create({
        owner,
        provider,
        subject: message?.subject ?? '',
        counterpartyEmail: counterparty,
        counterpartyName: message?.from?.name ?? null,
        campaign,
        status: CONVERSATION_STATUS.AWAITING_US,
      })

  if (match.lead) {
    await attachLead({ owner, conversation, leadId: match.lead, match })
  } else {
    conversation.matchStrategy = match.strategy
    conversation.matchConfidence = match.confidence
    await conversation.save()
  }

  return conversation
}

/**
 * Links a conversation to its enquiry, and denormalises the company and contact.
 *
 * Exported because the triage screen calls it when a person resolves an
 * ambiguous match by hand — that path must produce exactly the same state as
 * an automatic match, or the two would diverge.
 */
export async function attachLead({ owner, conversation, leadId, match = null, actor = null }) {
  const lead = await Lead.findOne({ _id: leadId, owner, isDeleted: false })
  if (!lead) return conversation

  const wasUnmatched = !conversation.lead

  conversation.lead = lead._id
  conversation.company = lead.company ?? null
  conversation.contact = lead.contact ?? null

  if (match) {
    conversation.matchStrategy = match.strategy
    conversation.matchConfidence = match.confidence
  }

  if (!conversation.counterpartyEmail && lead.email) conversation.counterpartyEmail = lead.email

  await conversation.save()

  // Backfill the messages already stored under this conversation, so the lead
  // timeline is complete rather than starting from the moment of the match.
  await ConversationMessage.updateMany(
    { conversation: conversation._id, lead: null },
    { $set: { lead: lead._id } },
  )
  await ConversationAttachment.updateMany(
    { conversation: conversation._id, lead: null },
    { $set: { lead: lead._id } },
  )

  if (wasUnmatched && actor) {
    await ConversationActivity.record({
      owner,
      type: ACTIVITY_TYPE.CONVERSATION_MERGED,
      summary: `Conversation linked to ${lead.reference}`,
      lead: lead._id,
      conversation: conversation._id,
      company: lead.company,
      actor,
      detail: { manual: true },
    })
  }

  return conversation
}

/**
 * Records the attachment metadata.
 *
 * Every attachment gets a row, including the ones policy refuses — a customer
 * who sent a file should never appear not to have. Bytes are fetched later by
 * the download worker, so a slow or failing provider cannot stall the sync.
 */
async function recordAttachments({ owner, conversation, message, attachments }) {
  if (attachments.length === 0) return

  for (const file of attachments) {
    const screening = screenAttachment({ fileName: file.name, size: file.size })

    try {
      await ConversationAttachment.create({
        owner,
        conversation: conversation._id,
        message: message._id,
        lead: conversation.lead,
        fileName: file.name ?? 'attachment',
        mimeType: file.contentType ?? 'application/octet-stream',
        size: file.size ?? 0,
        providerAttachmentId: file.id ?? null,
        isInline: Boolean(file.isInline),
        contentId: file.contentId ?? null,
        downloadStatus: screening.status,
        downloadError: screening.reason,
      })
    } catch (error) {
      // The unique index rejected a re-sync of the same attachment. Expected.
      if (error?.code !== 11000) throw error
    }
  }

  if (conversation.lead) {
    await ConversationActivity.record({
      owner,
      type: ACTIVITY_TYPE.ATTACHMENT_ADDED,
      summary: `${attachments.length} attachment(s) received: ${attachments.map((f) => f.name).slice(0, 3).join(', ')}`,
      lead: conversation.lead,
      conversation: conversation._id,
      company: conversation.company,
      message: message._id,
      detail: { count: attachments.length },
    })
  }
}

/**
 * Ingests a batch of messages.
 *
 * Sequential rather than parallel: two messages of one thread arriving together
 * would otherwise race to create the conversation, and while the upsert makes
 * that safe it would still produce interleaved `recalculate` writes and a
 * conversation whose counters briefly disagree with its messages.
 */
export async function ingestBatch({ owner, messages, provider = null, direction = MESSAGE_DIRECTION.INCOMING }) {
  const outcome = { total: messages.length, created: 0, duplicates: 0, failed: 0, matched: 0, unmatched: 0 }
  const errors = []

  for (const message of messages) {
    try {
      const { outcome: kind, conversation, match } = await ingestMessage({ owner, message, provider, direction })

      if (kind === 'duplicate') {
        outcome.duplicates += 1
        continue
      }

      outcome.created += 1
      if (conversation?.lead) outcome.matched += 1
      else outcome.unmatched += 1

      if (match && !match.lead && match.strategy !== MATCH_STRATEGY.UNMATCHED) {
        // Ambiguous rather than unknown; worth surfacing separately in the log.
        log.debug('Message needs triage', {
          strategy: match.strategy,
          candidates: match.candidates?.length ?? 0,
        })
      }
    } catch (error) {
      outcome.failed += 1
      errors.push({ providerMessageId: message?.providerMessageId ?? null, message: error?.message })
      log.warn('Message ingestion failed', {
        providerMessageId: message?.providerMessageId,
        error: error?.message,
      })
    }
  }

  log.info('Conversation sync complete', outcome)

  return { ...outcome, errors }
}

/**
 * Records a message this CRM sent.
 *
 * Called by the reply composer and by the campaign engine, so an outgoing
 * message joins the thread immediately rather than waiting for the sent folder
 * to sync — the salesperson must see their own reply the moment they send it.
 */
export async function recordOutgoing({
  owner,
  conversation,
  message,
  provider = null,
  campaign = null,
  actor = null,
}) {
  const stored = await ConversationMessage.create({
    owner,
    conversation: conversation._id,
    lead: conversation.lead,
    direction: MESSAGE_DIRECTION.OUTGOING,
    from: message.from ?? {},
    to: message.to ?? [],
    cc: message.cc ?? [],
    bcc: message.bcc ?? [],
    subject: message.subject ?? '',
    bodyHtml: message.bodyHtml ?? '',
    bodyText: message.bodyText ?? '',
    internetMessageId: message.internetMessageId ?? null,
    inReplyTo: message.inReplyTo ?? null,
    references: message.references ?? [],
    provider,
    providerMessageId: message.providerMessageId ?? null,
    mail: message.mailId ?? null,
    campaign,
    occurredAt: message.sentAt ?? new Date(),
    sentAt: message.sentAt ?? new Date(),
    isRead: true,
    hasAttachments: (message.attachments ?? []).length > 0,
    attachmentCount: (message.attachments ?? []).length,
    // Composed here rather than read from a mailbox; the sent-folder sync will
    // reconcile it and fill in the provider ids.
    syncStatus: message.providerMessageId ? MESSAGE_SYNC_STATUS.SYNCED : MESSAGE_SYNC_STATUS.LOCAL,
  })

  await conversation.recalculate()

  await ConversationActivity.record({
    owner,
    type: ACTIVITY_TYPE.MAIL_SENT,
    summary: `Replied to ${message.to?.[0]?.address ?? 'the customer'}`,
    lead: conversation.lead,
    conversation: conversation._id,
    company: conversation.company,
    message: stored._id,
    campaign,
    actor,
  })

  return stored
}

export default { ingestMessage, ingestBatch, recordOutgoing, attachLead }
