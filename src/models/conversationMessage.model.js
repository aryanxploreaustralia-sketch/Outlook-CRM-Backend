/**
 * One message inside a conversation.
 *
 * ## Why this is not simply the Phase 4 `Mail` record
 *
 * `Mail` is the mailbox's view: what was sent or synced, keyed to a mailbox and
 * a provider id. This is the *business* view: what was said about an enquiry,
 * keyed to a conversation and a lead. The two differ in ways that matter — a
 * campaign send produces one `Mail` per recipient but belongs to a different
 * conversation for each, and an inbound reply may arrive before any `Mail`
 * record exists for it.
 *
 * The link is kept (`mail`) so provenance is never lost, but the body lives
 * here. That duplicates storage, and it is deliberate: the thread view reads
 * dozens of messages at once and is the most-used screen in the module, so a
 * join per message on the hot path would be paid thousands of times a day to
 * save disk that costs nothing.
 */

import mongoose from 'mongoose'

import {
  MESSAGE_DIRECTION,
  MESSAGE_DIRECTION_VALUES,
  MESSAGE_IMPORTANCE,
  MESSAGE_IMPORTANCE_VALUES,
  MESSAGE_SYNC_STATUS,
  MESSAGE_SYNC_STATUS_VALUES,
} from '../modules/conversations/constants/conversationConstants.js'
import { REPLY_KIND_VALUES } from '../modules/campaigns/constants/campaignConstants.js'

const { Schema } = mongoose

/** One address on a message. */
const participantSchema = new Schema(
  {
    address: { type: String, trim: true, lowercase: true, default: null },
    name: { type: String, trim: true, default: null },
  },
  { _id: false },
)

const conversationMessageSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },

    /** Denormalised from the conversation so a lead timeline needs no join. */
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },

    direction: { type: String, enum: MESSAGE_DIRECTION_VALUES, required: true, index: true },

    from: { type: participantSchema, default: () => ({}) },
    to: { type: [participantSchema], default: [] },
    cc: { type: [participantSchema], default: [] },
    /** Only ever populated on messages this account sent. */
    bcc: { type: [participantSchema], default: [] },

    subject: { type: String, trim: true, default: '', maxlength: 998 },
    bodyHtml: { type: String, default: '' },
    bodyText: { type: String, default: '' },

    /**
     * The body with the quoted history removed.
     *
     * Computed once at write time. Every reply repeats the whole thread, so a
     * list of twenty messages would otherwise render the first one twenty
     * times, and a preview would show our own words back to us.
     */
    bodyStripped: { type: String, default: '' },

    // --- RFC 5322 threading -------------------------------------------------
    internetMessageId: { type: String, trim: true, default: null, index: true },
    inReplyTo: { type: String, trim: true, default: null },
    references: { type: [String], default: [] },

    // --- Provider -----------------------------------------------------------
    provider: { type: String, trim: true, default: null },
    providerMessageId: { type: String, trim: true, default: null },
    providerConversationId: { type: String, trim: true, default: null },

    /** The Phase 4 record this came from, when there is one. */
    mail: { type: Schema.Types.ObjectId, ref: 'Mail', default: null },
    /** The campaign send that produced it, for an outgoing message. */
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null },

    /**
     * When it happened — received for inbound, sent for outbound.
     *
     * One field rather than two nullable ones, because the thread sorts by it
     * and a sort over "receivedAt or sentAt" cannot use an index.
     */
    occurredAt: { type: Date, required: true, index: true },
    receivedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },

    importance: {
      type: String,
      enum: MESSAGE_IMPORTANCE_VALUES,
      default: MESSAGE_IMPORTANCE.NORMAL,
    },

    /** Reply, reply-all, forward, out-of-office… from the Phase 7 classifier. */
    replyKind: { type: String, enum: [...REPLY_KIND_VALUES, null], default: null },

    isRead: { type: Boolean, default: false },
    hasAttachments: { type: Boolean, default: false },
    attachmentCount: { type: Number, default: 0, min: 0 },

    syncStatus: {
      type: String,
      enum: MESSAGE_SYNC_STATUS_VALUES,
      default: MESSAGE_SYNC_STATUS.SYNCED,
    },
    syncError: { type: String, default: null },

    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
)

/** The thread view: one conversation, oldest first. */
conversationMessageSchema.index({ conversation: 1, occurredAt: 1 })

/**
 * Deduplication.
 *
 * A message can be seen twice — a delta replay, or an overlapping full sync.
 * Sparse because a locally composed message has no provider id yet.
 */
conversationMessageSchema.index(
  { owner: 1, providerMessageId: 1 },
  { unique: true, sparse: true },
)

/** Reply matching, and "have we already stored this". */
conversationMessageSchema.index({ owner: 1, internetMessageId: 1 }, { sparse: true })

/** A lead's message history. */
conversationMessageSchema.index({ owner: 1, lead: 1, occurredAt: -1 })

/** Unread counts and the "today's replies" widget. */
conversationMessageSchema.index({ owner: 1, direction: 1, isRead: 1, occurredAt: -1 })

/** Full-text search across message bodies. */
conversationMessageSchema.index(
  { subject: 'text', bodyStripped: 'text' },
  { name: 'message_search', weights: { subject: 6, bodyStripped: 1 } },
)

/**
 * Patterns that mark the start of quoted history.
 *
 * Ordered longest-first so a specific pattern wins over a generic one. These
 * cover Outlook, Gmail and the common mobile clients; anything unmatched simply
 * keeps its quoted text, which is a cosmetic loss rather than a data one.
 */
const QUOTE_MARKERS = [
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^_{5,}$/m,
  /^From:\s.+\nSent:\s/im,
  /^From:\s.+\nDate:\s/im,
  /^On\s.+\swrote:$/im,
  /^On\s.+,\s.+\s<[^>]+>\s*wrote:/im,
  /^\s*>{1,}\s/m,
  /^Sent from my \w+/im,
]

/**
 * Removes quoted history from a plain-text body.
 *
 * Deliberately conservative: it cuts at the first marker and keeps everything
 * above. Trying to interleave quoted and new text is how these algorithms start
 * deleting the customer's actual words.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripQuotedText(text) {
  const body = String(text ?? '')
  if (!body.trim()) return ''

  let cut = body.length

  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(body)
    if (match && match.index < cut) cut = match.index
  }

  const stripped = body.slice(0, cut).trim()

  // If stripping left nothing, the whole message was quoted history — a bare
  // "+1" on top of a thread, or a client that quotes before replying. Keeping
  // the original is more useful than showing an empty message.
  return stripped.length > 0 ? stripped : body.trim()
}

conversationMessageSchema.pre('save', async function deriveStripped() {
  if (this.isModified('bodyText') || this.isNew) {
    this.bodyStripped = stripQuotedText(this.bodyText)
  }
})

conversationMessageSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    conversation: this.conversation.toString(),
    lead: this.lead?.toString() ?? null,
    direction: this.direction,
    isIncoming: this.direction === MESSAGE_DIRECTION.INCOMING,
    from: this.from,
    to: this.to,
    cc: this.cc,
    bcc: this.bcc,
    subject: this.subject,
    bodyHtml: this.bodyHtml,
    bodyText: this.bodyText,
    bodyStripped: this.bodyStripped,
    internetMessageId: this.internetMessageId,
    inReplyTo: this.inReplyTo,
    references: this.references,
    providerMessageId: this.providerMessageId,
    occurredAt: this.occurredAt,
    receivedAt: this.receivedAt,
    sentAt: this.sentAt,
    importance: this.importance,
    replyKind: this.replyKind,
    isRead: this.isRead,
    hasAttachments: this.hasAttachments,
    attachmentCount: this.attachmentCount,
    syncStatus: this.syncStatus,
    syncError: this.syncError,
    createdAt: this.createdAt,
  }
}

export const ConversationMessage = mongoose.model('ConversationMessage', conversationMessageSchema)

export default ConversationMessage
