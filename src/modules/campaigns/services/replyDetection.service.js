/**
 * Reply detection and follow-up sequencing.
 *
 * ## Why classification matters more than detection
 *
 * Detecting that *something* came back is easy. The valuable judgement is what
 * kind of something: a genuine reply means stop the sequence and hand the lead
 * to a human, while an out-of-office means the person has not read the message
 * and the sequence must continue. Treating the second as the first silently
 * drops live leads — the most expensive failure this module can have.
 *
 * ## Detection is heuristic, and says so
 *
 * There is no reliable machine-readable signal for "this is an auto-responder".
 * RFC 3834 defines `Auto-Submitted`, but Exchange, Gmail and most ticketing
 * systems do not set it consistently. So classification combines several weak
 * signals — headers where present, subject prefixes, body phrasing — and each
 * match is recorded, so a misclassification can be explained rather than
 * guessed at.
 */

import { Campaign } from '../../../models/campaign.model.js'
import { CampaignEvent } from '../../../models/campaignEvent.model.js'
import { CampaignRecipient } from '../../../models/campaignRecipient.model.js'
import { CampaignSequence } from '../../../models/campaignSequence.model.js'
import { Contact } from '../../../models/contact.model.js'
import {
  CAMPAIGN_EVENT,
  RECIPIENT_STATUS,
  REPLY_KIND,
  SEQUENCE_STOPPING_REPLIES,
  TERMINAL_RECIPIENT_STATUSES,
} from '../constants/campaignConstants.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('reply-detection')

/**
 * Subject prefixes that mark a reply, across the languages a European sales
 * team actually encounters. Outlook localises these.
 */
const REPLY_PREFIXES = /^\s*(re|aw|antw|sv|vs|odp|rif|res)\s*:/i
const FORWARD_PREFIXES = /^\s*(fw|fwd|wg|tr|rv|i)\s*:/i

/** Out-of-office phrasing, again across common localisations. */
const OUT_OF_OFFICE_SUBJECT =
  /(out of (the )?office|automatic reply|autoreply|auto[- ]?response|abwesenheit|absence du bureau|fuori sede|ausencia)/i

const OUT_OF_OFFICE_BODY =
  /(i am (currently )?(out of|away from) the office|on annual leave|on holiday|will be back on|returning on|currently unavailable)/i

/** Other automated senders — ticketing, no-reply, delivery agents. */
const AUTOMATED_SENDER = /(no-?reply|do-?not-?reply|postmaster|mailer-daemon|notifications?|support@|helpdesk@|ticket)/i

const BOUNCE_INDICATORS =
  /(undeliverable|delivery (has )?failed|returned to sender|address not found|recipient rejected|mailbox (is )?full|550|user unknown)/i

/**
 * Classifies an inbound message against a campaign send.
 *
 * @param {object} message A `ProviderMessage`-shaped object.
 * @returns {{ kind: string, confidence: number, signals: string[] }}
 */
export function classifyReply(message) {
  const subject = String(message?.subject ?? '')
  const body = String(message?.bodyText ?? message?.bodyPreview ?? '').slice(0, 2000)
  const from = String(message?.from?.address ?? '').toLowerCase()
  const headers = message?.headers ?? {}

  const signals = []

  // --- Bounces first ------------------------------------------------------
  //
  // A bounce is not a reply at all, and misreading one as engagement would both
  // stop a sequence and inflate the reply rate.
  if (BOUNCE_INDICATORS.test(subject) || /mailer-daemon|postmaster/i.test(from)) {
    signals.push('bounce_indicator')
    return { kind: REPLY_KIND.BOUNCE, confidence: 0.9, signals }
  }

  // --- Explicit machine-readable markers, where present -------------------
  const autoSubmitted = String(headers['auto-submitted'] ?? '').toLowerCase()

  if (autoSubmitted && autoSubmitted !== 'no') {
    signals.push(`auto-submitted:${autoSubmitted}`)
  }

  if (headers['x-autoreply'] || headers['x-autorespond'] || headers['x-auto-response-suppress']) {
    signals.push('autoreply_header')
  }

  // --- Out of office ------------------------------------------------------
  const looksOoo = OUT_OF_OFFICE_SUBJECT.test(subject) || OUT_OF_OFFICE_BODY.test(body)

  if (looksOoo) {
    signals.push(OUT_OF_OFFICE_SUBJECT.test(subject) ? 'ooo_subject' : 'ooo_body')

    return {
      kind: REPLY_KIND.OUT_OF_OFFICE,
      // Higher when a header corroborates the phrasing.
      confidence: signals.length > 1 ? 0.95 : 0.75,
      signals,
    }
  }

  // A header-declared automatic reply with no out-of-office phrasing is some
  // other robot — a ticket acknowledgement, typically.
  if (signals.length > 0) {
    return { kind: REPLY_KIND.AUTO_REPLY, confidence: 0.85, signals }
  }

  if (AUTOMATED_SENDER.test(from)) {
    signals.push('automated_sender_address')
    return { kind: REPLY_KIND.AUTO_REPLY, confidence: 0.7, signals }
  }

  // --- Human replies ------------------------------------------------------
  if (FORWARD_PREFIXES.test(subject)) {
    signals.push('forward_prefix')
    return { kind: REPLY_KIND.FORWARD, confidence: 0.9, signals }
  }

  if (REPLY_PREFIXES.test(subject)) {
    signals.push('reply_prefix')

    // More than one recipient on the reply suggests reply-all.
    const isReplyAll = (message?.to?.length ?? 0) + (message?.cc?.length ?? 0) > 1
    if (isReplyAll) signals.push('multiple_recipients')

    return {
      kind: isReplyAll ? REPLY_KIND.REPLY_ALL : REPLY_KIND.REPLY,
      confidence: 0.9,
      signals,
    }
  }

  /**
   * No prefix, but it arrived in the same conversation as something we sent.
   * Some clients strip the prefix, and a message on our own thread from the
   * person we mailed is a reply by any reasonable reading.
   */
  if (message?.conversationId) {
    signals.push('same_conversation')
    return { kind: REPLY_KIND.REPLY, confidence: 0.6, signals }
  }

  signals.push('no_signal')
  return { kind: REPLY_KIND.REPLY, confidence: 0.3, signals }
}

/**
 * Matches inbound messages against outstanding campaign recipients.
 *
 * Matching is on the sender's address rather than the conversation id, because
 * `sendMail` returns no message id (Phase 4's finding) and so there is no
 * conversation to correlate against for the initial send.
 *
 * @param {object} params
 * @param {object[]} params.messages Inbound `ProviderMessage` objects.
 * @returns {Promise<{ matched: number, stopped: number, details: object[] }>}
 */
export async function processInboundMessages({ owner, messages }) {
  const details = []
  let matched = 0
  let stopped = 0

  for (const message of messages) {
    const from = String(message?.from?.address ?? '').toLowerCase()
    if (!from) continue

    /**
     * Only recipients that were actually sent to are candidates. A queued
     * recipient cannot have replied, and matching one would corrupt the funnel.
     */
    const recipients = await CampaignRecipient.find({
      owner,
      email: from,
      status: { $in: [RECIPIENT_STATUS.SENT, RECIPIENT_STATUS.DELIVERED, RECIPIENT_STATUS.OPENED, RECIPIENT_STATUS.CLICKED] },
    })

    if (recipients.length === 0) continue

    const classification = classifyReply(message)

    for (const recipient of recipients) {
      // A message that predates the send cannot be a reply to it.
      const receivedAt = message.receivedAt ? new Date(message.receivedAt) : new Date()
      if (recipient.sentAt && receivedAt < recipient.sentAt) continue

      matched += 1

      if (classification.kind === REPLY_KIND.BOUNCE) {
        recipient.status = RECIPIENT_STATUS.BOUNCED
        recipient.lastError = {
          kind: 'permanent',
          message: `Bounce detected: ${message.subject}`,
          occurredAt: receivedAt,
        }
        await recipient.save()

        await CampaignEvent.create({
          campaign: recipient.campaign, recipient: recipient._id, owner,
          type: CAMPAIGN_EVENT.BOUNCED, email: from,
          detail: { source: 'inbound_scan', signals: classification.signals },
        })

        details.push({ email: from, kind: classification.kind, action: 'marked_bounced' })
        continue
      }

      const stopsSequence = SEQUENCE_STOPPING_REPLIES.has(classification.kind)

      recipient.replyKind = classification.kind
      recipient.repliedAt = receivedAt
      recipient.conversationId = message.conversationId ?? recipient.conversationId

      if (stopsSequence) {
        recipient.status = RECIPIENT_STATUS.REPLIED
        stopped += 1
      }

      await recipient.save()

      await CampaignEvent.create({
        campaign: recipient.campaign, recipient: recipient._id, owner,
        type: CAMPAIGN_EVENT.REPLIED, email: from,
        detail: {
          kind: classification.kind,
          confidence: classification.confidence,
          signals: classification.signals,
          stoppedSequence: stopsSequence,
          subject: message.subject,
        },
      })

      if (stopsSequence) {
        // A person who replied is engaged; the lead status should say so, and
        // any queued follow-up must stop.
        await Contact.updateOne(
          { _id: recipient.contact, owner, leadStatus: { $in: ['new', 'contacted'] } },
          { $set: { leadStatus: 'engaged', lastInteraction: receivedAt } },
        )

        await stopSequenceFor({ owner, contactId: recipient.contact, reason: classification.kind })
      }

      details.push({
        email: from,
        kind: classification.kind,
        confidence: classification.confidence,
        action: stopsSequence ? 'sequence_stopped' : 'recorded_only',
      })
    }
  }

  log.info('Inbound messages processed', { messages: messages.length, matched, stopped })

  return { matched, stopped, details }
}

/**
 * Removes a contact from every queued follow-up.
 *
 * The behaviour that makes sequences safe to use: once someone replies, no
 * further automated message reaches them, however many steps were scheduled.
 *
 * @returns {Promise<number>} Recipients skipped.
 */
export async function stopSequenceFor({ owner, contactId, reason }) {
  const { modifiedCount } = await CampaignRecipient.updateMany(
    {
      owner,
      contact: contactId,
      status: RECIPIENT_STATUS.QUEUED,
    },
    {
      $set: {
        status: RECIPIENT_STATUS.SKIPPED,
        skipReason: `Contact replied (${reason}); follow-up stopped.`,
      },
    },
  )

  if (modifiedCount > 0) {
    log.info('Follow-up stopped for a contact who replied', {
      contactId: String(contactId),
      recipientsSkipped: modifiedCount,
      reason,
    })
  }

  return modifiedCount ?? 0
}

/**
 * Creates the next step of a sequence as its own campaign.
 *
 * Each step is a separate `Campaign` rather than a mode of the original. That
 * keeps every step's analytics independent — which step actually gets replies is
 * the question a sequence exists to answer — and means the queue needs no
 * special knowledge of sequences at all.
 *
 * @returns {Promise<?object>} The follow-up campaign, or null when none is due.
 */
export async function createSequenceStep({ campaign, owner, createdBy }) {
  if (!campaign.sequence) return null

  const sequence = await CampaignSequence.findOne({ _id: campaign.sequence, owner, isDeleted: false })
  if (!sequence) return null

  const nextIndex = campaign.sequenceStep + 1
  const step = sequence.steps[nextIndex]

  if (!step) return null

  const { CampaignTemplate } = await import('../../../models/campaignTemplate.model.js')
  const template = await CampaignTemplate.findOne({ _id: step.template, owner })

  if (!template) {
    log.warn('Sequence step references a template that no longer exists', {
      campaignId: campaign._id.toString(),
      step: nextIndex,
    })
    return null
  }

  /**
   * Only recipients who received the previous step and have not since replied,
   * bounced or been skipped. `TERMINAL_RECIPIENT_STATUSES` is exactly the set
   * that must never receive another message.
   */
  const eligible = await CampaignRecipient.find({
    campaign: campaign._id,
    status: { $nin: [...TERMINAL_RECIPIENT_STATUSES, RECIPIENT_STATUS.QUEUED, RECIPIENT_STATUS.FAILED] },
  }).select('contact')

  const filtered = step.onlyIfNotOpened
    ? await CampaignRecipient.find({
        campaign: campaign._id,
        status: RECIPIENT_STATUS.SENT, // sent but never progressed to opened
      }).select('contact')
    : eligible

  if (filtered.length === 0) {
    log.info('Sequence step has no eligible recipients', {
      campaignId: campaign._id.toString(),
      step: nextIndex,
    })
    return null
  }

  const scheduledFor = new Date(Date.now() + step.delayDays * 86_400_000)

  const followUp = await Campaign.create({
    owner,
    createdBy,
    name: step.name ?? `${campaign.name} — step ${nextIndex + 1}`,
    description: `Follow-up step ${nextIndex + 1} of "${sequence.name}".`,
    template: template._id,
    subject: step.subjectOverride ?? template.subject,
    bodyHtml: template.bodyHtml,
    senderMailboxes: campaign.senderMailboxes,
    throttle: campaign.throttle,
    priority: campaign.priority,
    sequence: sequence._id,
    sequenceStep: nextIndex,
    parentCampaign: campaign._id,
    status: 'scheduled',
    scheduledFor,
    audience: { source: 'manual', contactIds: filtered.map((r) => r.contact) },
  })

  const documents = filtered.map((recipient) => ({
    campaign: followUp._id,
    owner,
    contact: recipient.contact,
    email: '',
    status: RECIPIENT_STATUS.QUEUED,
  }))

  // Addresses are resolved from the contacts, so a corrected address since the
  // first step is used rather than the stale one.
  const contacts = await Contact.find({ _id: { $in: filtered.map((r) => r.contact) } }).select(
    '_id primaryEmail',
  )
  const emailById = new Map(contacts.map((contact) => [contact._id.toString(), contact.primaryEmail]))

  const withEmails = documents
    .map((document) => ({ ...document, email: emailById.get(document.contact.toString()) }))
    .filter((document) => Boolean(document.email))

  if (withEmails.length > 0) {
    await CampaignRecipient.insertMany(withEmails, { ordered: false }).catch(() => {})
  }

  await followUp.recomputeStats()

  await CampaignEvent.create({
    campaign: campaign._id, owner, type: CAMPAIGN_EVENT.SEQUENCE_ADVANCED,
    detail: { step: nextIndex, followUpCampaign: followUp._id.toString(), recipients: withEmails.length, scheduledFor },
  })

  log.info('Sequence step created', {
    parent: campaign._id.toString(),
    followUp: followUp._id.toString(),
    step: nextIndex,
    recipients: withEmails.length,
  })

  return followUp
}

export default { classifyReply, processInboundMessages, stopSequenceFor, createSequenceStep }
