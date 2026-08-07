/**
 * Ties an inbound message back to the enquiry that produced it.
 *
 * This is the piece the whole module rests on. Get it right and the sales team
 * never opens Outlook; get it wrong and a customer's answer about their Dubai
 * quotation lands on somebody else's Bali enquiry.
 *
 * ## The strategies, strongest first
 *
 * | Strategy | Signal | Why it ranks there |
 * |---|---|---|
 * | `in_reply_to` | The In-Reply-To header names a message we sent | Unambiguous. The sender's own client asserts the parent |
 * | `references` | A References entry names a message we sent | Same guarantee, one step further up the chain |
 * | `thread_id` | The provider's thread key matches | Reliable within one mail system, absent across systems |
 * | `lead_reference` | The subject carries `XAMP01` | The team quotes it deliberately; survives any client |
 * | `sender_single_lead` | Known contact with exactly one open enquiry | Inference, but there is only one thing it can mean |
 * | `sender_and_subject` | Known contact, subject matches an enquiry | Weaker inference |
 * | `sender_ambiguous` | Known contact, several open enquiries | Refuses to guess; a human decides |
 * | `unmatched` | Nothing | Stored anyway, flagged for triage |
 *
 * ## Why it stops at the first hit
 *
 * The order is a strict confidence ranking, so a later strategy can only ever
 * be a weaker claim about the same message. Continuing after a header match to
 * "confirm" it with a subject guess would let the guess override the certainty.
 *
 * ## Why an ambiguous sender is not resolved by picking the newest
 *
 * `pooja@flamingotravels.co.in` has 183 enquiries in the real data. "Most
 * recent" would be right often enough to be trusted and wrong often enough to
 * put a booking confirmation on the wrong file. An honest `sender_ambiguous`
 * that a person resolves in one click is better than a silent coin flip.
 */

import { Contact } from '../../../models/contact.model.js'
import { Conversation } from '../../../models/conversation.model.js'
import { ConversationMessage } from '../../../models/conversationMessage.model.js'
import { Lead } from '../../../models/lead.model.js'
import { Mail } from '../../../models/mail.model.js'
import { CAMPAIGN_ELIGIBLE_STAGES, TERMINAL_STAGES } from '../../leads/constants/leadConstants.js'
import { MATCH_CONFIDENCE, MATCH_STRATEGY } from '../constants/conversationConstants.js'

/**
 * Reply prefixes across the languages this business actually meets.
 *
 * Indian and Australian agencies correspond in English, but forwarded threads
 * routinely carry a European client's prefix. Stripping only `Re:` would leave
 * `AW: Re: XAMP01` unmatched on subject.
 */
const SUBJECT_PREFIX = /^\s*((re|aw|antw|sv|vs|odp|rif|res|fw|fwd|wg|tr|rv)\s*(\[\d+\])?\s*:\s*)+/i

/** A lead reference: two to six letters then digits, e.g. XAMP01, XNZMP110. */
const LEAD_REFERENCE = /\b([A-Z]{2,6}\d{1,6})\b/gi

/** Removes reply and forward prefixes, then normalises whitespace and case. */
export function normaliseSubject(subject) {
  let text = String(subject ?? '')
  let previous

  // Looped because clients stack prefixes: "RE: FW: RE: Quotation".
  do {
    previous = text
    text = text.replace(SUBJECT_PREFIX, '')
  } while (text !== previous)

  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Every lead reference mentioned in a subject or body fragment. */
export function extractLeadReferences(text) {
  const found = new Set()
  for (const match of String(text ?? '').matchAll(LEAD_REFERENCE)) {
    found.add(match[1].toUpperCase())
  }
  return [...found]
}

/** Wraps a result so every branch returns the same shape. */
function result(strategy, { lead = null, conversation = null, candidates = [], detail = null } = {}) {
  return {
    strategy,
    confidence: MATCH_CONFIDENCE[strategy] ?? 0,
    lead,
    conversation,
    /** Populated only when the match was ambiguous, for the triage UI. */
    candidates,
    detail,
  }
}

/**
 * Finds the conversation and lead an inbound message belongs to.
 *
 * @param {{ owner: any, message: object }} params
 *   `message` is a provider-mapped message: `internetMessageId`, `inReplyTo`,
 *   `references[]`, `conversationId`, `subject`, `from`.
 * @returns {Promise<{strategy, confidence, lead, conversation, candidates, detail}>}
 */
export async function matchInboundMessage({ owner, message }) {
  const senderAddress = String(message?.from?.address ?? '').toLowerCase().trim()

  // --- 1. In-Reply-To -------------------------------------------------------
  if (message?.inReplyTo) {
    const found = await findByMessageId({ owner, messageId: message.inReplyTo })
    if (found) {
      return result(MATCH_STRATEGY.IN_REPLY_TO, {
        ...found,
        detail: { matchedOn: message.inReplyTo },
      })
    }
  }

  // --- 2. References --------------------------------------------------------
  //
  // Walked newest-first: the nearest ancestor is the most specific claim about
  // which thread this belongs to.
  for (const reference of [...(message?.references ?? [])].reverse()) {
    const found = await findByMessageId({ owner, messageId: reference })
    if (found) {
      return result(MATCH_STRATEGY.REFERENCES, { ...found, detail: { matchedOn: reference } })
    }
  }

  // --- 3. Provider thread id -----------------------------------------------
  if (message?.conversationId) {
    const conversation = await Conversation.findOne({
      owner,
      providerConversationId: message.conversationId,
      isDeleted: false,
    })

    if (conversation) {
      return result(MATCH_STRATEGY.THREAD_ID, {
        conversation,
        lead: conversation.lead,
        detail: { matchedOn: message.conversationId },
      })
    }

    // The thread may be known to the Phase 4/5 mail records before a
    // conversation exists for it — the campaign send is stored there first.
    const mail = await Mail.findOne({ conversationId: message.conversationId }).sort({ createdAt: 1 })
    if (mail) {
      const viaMail = await leadFromMail({ owner, mail })
      if (viaMail) {
        return result(MATCH_STRATEGY.THREAD_ID, {
          lead: viaMail,
          detail: { matchedOn: message.conversationId, via: 'mail record' },
        })
      }
    }
  }

  // --- 4. Lead reference in the subject ------------------------------------
  const references = extractLeadReferences(message?.subject)

  if (references.length > 0) {
    const leads = await Lead.find({ owner, reference: { $in: references }, isDeleted: false })

    if (leads.length === 1) {
      return result(MATCH_STRATEGY.LEAD_REFERENCE, {
        lead: leads[0]._id,
        detail: { matchedOn: leads[0].reference },
      })
    }

    if (leads.length > 1) {
      // Several references quoted — a merged thread. Refuse to pick.
      return result(MATCH_STRATEGY.SENDER_AMBIGUOUS, {
        candidates: leads.map((lead) => lead._id),
        detail: {
          reason: `The subject quotes ${leads.length} references: ${leads.map((l) => l.reference).join(', ')}.`,
        },
      })
    }
  }

  // --- 5, 6, 7. The sender -------------------------------------------------
  if (!senderAddress) {
    return result(MATCH_STRATEGY.UNMATCHED, { detail: { reason: 'The message has no sender address.' } })
  }

  const contact = await Contact.findOne({ owner, primaryEmail: senderAddress, isDeleted: false })

  if (!contact) {
    return result(MATCH_STRATEGY.UNMATCHED, {
      detail: { reason: `${senderAddress} is not a known contact.` },
    })
  }

  const leads = await Lead.find({ owner, contact: contact._id, isDeleted: false }).sort({ quoteDate: -1 })

  if (leads.length === 0) {
    return result(MATCH_STRATEGY.UNMATCHED, {
      detail: { reason: `${senderAddress} is a contact but has no enquiries.` },
    })
  }

  /**
   * Only enquiries still in play are considered.
   *
   * A reply almost never concerns a trip that already departed, and matching to
   * a completed enquiry would resurrect a closed file. Open ones are tried
   * first; the closed set is the fallback when nothing is open.
   */
  const open = leads.filter((lead) => !TERMINAL_STAGES.includes(lead.stage))
  const pool = open.length > 0 ? open : leads

  if (pool.length === 1) {
    return result(MATCH_STRATEGY.SENDER_SINGLE_LEAD, {
      lead: pool[0]._id,
      detail: {
        matchedOn: senderAddress,
        reason:
          open.length > 0
            ? 'The sender has exactly one open enquiry.'
            : 'The sender has one enquiry, already closed.',
      },
    })
  }

  // --- 6. Sender plus a subject that matches one of their enquiries --------
  const subject = normaliseSubject(message?.subject)

  if (subject) {
    const scored = pool
      .map((lead) => ({ lead, score: subjectAffinity(subject, lead) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)

    // A clear winner only. Two enquiries scoring alike is exactly the case
    // where guessing does damage.
    if (scored.length > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
      return result(MATCH_STRATEGY.SENDER_AND_SUBJECT, {
        lead: scored[0].lead._id,
        candidates: pool.map((lead) => lead._id),
        detail: { matchedOn: senderAddress, subject, score: scored[0].score },
      })
    }
  }

  // --- 7. Known sender, unclear which enquiry ------------------------------
  return result(MATCH_STRATEGY.SENDER_AMBIGUOUS, {
    candidates: pool.slice(0, 20).map((lead) => lead._id),
    detail: {
      matchedOn: senderAddress,
      reason: `${senderAddress} has ${pool.length} open enquiries and nothing in the message says which.`,
    },
  })
}

/**
 * Locates a conversation or lead from an RFC message id we have seen before.
 *
 * Checks the conversation's id set first — one indexed lookup that covers every
 * message in the thread — then falls back to the message collection and finally
 * to the Phase 4 mail records, which hold campaign sends that predate any
 * conversation.
 */
async function findByMessageId({ owner, messageId }) {
  const id = String(messageId ?? '').trim()
  if (!id) return null

  const conversation = await Conversation.findOne({ owner, messageIds: id, isDeleted: false })
  if (conversation) return { conversation, lead: conversation.lead }

  const message = await ConversationMessage.findOne({ owner, internetMessageId: id })
  if (message) {
    const parent = await Conversation.findById(message.conversation)
    return { conversation: parent, lead: message.lead ?? parent?.lead ?? null }
  }

  const mail = await Mail.findOne({ internetMessageId: id })
  if (mail) {
    const lead = await leadFromMail({ owner, mail })
    if (lead) return { conversation: null, lead }
  }

  return null
}

/**
 * Derives the enquiry behind a Phase 4 mail record.
 *
 * A campaign send stores its recipient, and the recipient is a contact. Where
 * that contact has one open enquiry the link is unambiguous; where it has
 * several this returns null rather than choosing, and the caller falls through
 * to a weaker strategy that will report the ambiguity honestly.
 */
async function leadFromMail({ owner, mail }) {
  const address = String(mail?.to?.[0]?.address ?? mail?.to?.[0] ?? '').toLowerCase()
  if (!address) return null

  const contact = await Contact.findOne({ owner, primaryEmail: address, isDeleted: false })
  if (!contact) return null

  const leads = await Lead.find({ owner, contact: contact._id, isDeleted: false })
  const open = leads.filter((lead) => CAMPAIGN_ELIGIBLE_STAGES.includes(lead.stage))
  const pool = open.length > 0 ? open : leads

  return pool.length === 1 ? pool[0]._id : null
}

/**
 * Scores how well a subject matches an enquiry.
 *
 * Deliberately crude and explainable: a reference is worth far more than a city
 * name, and a city more than nothing. A fuzzy string distance would score
 * higher on paper and be impossible to justify to a salesperson asking why
 * their message landed on the wrong file.
 */
export function subjectAffinity(normalisedSubject, lead) {
  let score = 0

  if (lead.reference && normalisedSubject.includes(lead.reference.toLowerCase())) score += 100
  if (lead.city && normalisedSubject.includes(lead.city.toLowerCase())) score += 10
  if (lead.companyName && normalisedSubject.includes(lead.companyName.toLowerCase())) score += 8
  if (lead.travelDateText && normalisedSubject.includes(lead.travelDateText.toLowerCase())) score += 5

  return score
}

export default { matchInboundMessage, normaliseSubject, extractLeadReferences, subjectAffinity }
