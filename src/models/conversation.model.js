/**
 * A business conversation about one enquiry.
 *
 * The thread the sales team actually works: everything said to and by one
 * customer about one quotation. It is deliberately anchored to a **lead**, not
 * to a mailbox folder — this is a CRM, not an inbox. A reply that cannot be
 * tied to an enquiry is still recorded, but it is flagged as unmatched rather
 * than filed somewhere plausible.
 *
 * ## Why the counters and last-message pointers are denormalised
 *
 * The conversation list is the screen the team lives in, and every row shows a
 * preview, a reply count and a timestamp. Deriving those from the message
 * collection would be an aggregation per row on every page view. They are
 * maintained by `recalculate()`, which is also the reconciliation path.
 */

import mongoose from 'mongoose'

import {
  CONVERSATION_STATUS,
  CONVERSATION_STATUS_LABELS,
  CONVERSATION_STATUS_VALUES,

  MATCH_STRATEGY_LABELS,
  MATCH_STRATEGY_VALUES,
} from '../modules/conversations/constants/conversationConstants.js'

const { Schema } = mongoose

/** A denormalised pointer to one end of the thread, for the list view. */
const messagePointerSchema = new Schema(
  {
    message: { type: Schema.Types.ObjectId, ref: 'ConversationMessage', default: null },
    at: { type: Date, default: null },
    preview: { type: String, default: null, maxlength: 512 },
    from: { type: String, default: null },
  },
  { _id: false },
)

const conversationSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // --- What this conversation is about -----------------------------------
    /**
     * The enquiry. Null only while a message is unmatched.
     *
     * Nullable on purpose: refusing to store a reply we cannot place would
     * lose customer mail, which is the one thing this module must never do.
     */
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },
    company: { type: Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', default: null, index: true },

    /** The campaign whose send started this, when there was one. */
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true },

    subject: { type: String, trim: true, default: '', maxlength: 998 },

    /** The customer's address. Denormalised so the list needs no join. */
    counterpartyEmail: { type: String, trim: true, lowercase: true, default: null, index: true },
    counterpartyName: { type: String, trim: true, default: null },

    // --- Provider identity --------------------------------------------------
    provider: { type: String, trim: true, default: null },

    /**
     * The provider's own thread key (Graph's `conversationId`).
     *
     * Unique per owner so two syncs of the same thread converge on one
     * conversation instead of racing to create two.
     */
    providerConversationId: { type: String, trim: true, default: null, index: true },
    providerThreadId: { type: String, trim: true, default: null },

    /**
     * Every RFC 5322 message id seen in this thread.
     *
     * The index on this array is what makes In-Reply-To and References matching
     * a single indexed lookup rather than a scan. It grows by one per message,
     * which is small next to the bodies.
     */
    messageIds: { type: [String], default: [] },

    // --- State --------------------------------------------------------------
    status: {
      type: String,
      enum: CONVERSATION_STATUS_VALUES,
      default: CONVERSATION_STATUS.AWAITING_REPLY,
      index: true,
    },

    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /** Unread incoming messages. Drives the bold rows and the badge. */
    unreadCount: { type: Number, default: 0, min: 0 },

    isPinned: { type: Boolean, default: false },

    /**
     * How the first inbound message was tied to its lead, and how sure we are.
     *
     * Kept so a wrong match can be explained. "Matched on the sender's address
     * because they had one open enquiry" is a defensible answer; a bare link is
     * not.
     */
    matchStrategy: {
      type: String,
      enum: [...MATCH_STRATEGY_VALUES, null],
      default: null,
    },
    matchConfidence: { type: Number, default: 0, min: 0, max: 1 },

    // --- Denormalised roll-ups ---------------------------------------------
    lastActivityAt: { type: Date, default: Date.now, index: true },
    lastIncomingMessage: { type: messagePointerSchema, default: () => ({}) },
    lastOutgoingMessage: { type: messagePointerSchema, default: () => ({}) },

    messageCount: { type: Number, default: 0, min: 0 },
    replyCount: { type: Number, default: 0, min: 0 },
    attachmentCount: { type: Number, default: 0, min: 0 },

    /**
     * Time from our last outgoing message to the customer's first answer.
     *
     * Stored per conversation rather than recomputed, because "average response
     * time" is a dashboard widget and averaging over a join is expensive.
     */
    firstResponseMs: { type: Number, default: null },

    closedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, versionKey: false },
)

/** One conversation per provider thread. Partial so a soft delete frees the key. */
conversationSchema.index(
  { owner: 1, providerConversationId: 1 },
  { unique: true, partialFilterExpression: { providerConversationId: { $type: 'string' }, isDeleted: false } },
)

/** The working list: newest activity first. */
conversationSchema.index({ owner: 1, isDeleted: 1, lastActivityAt: -1 })

/** "Assigned to me", "needs a response". */
conversationSchema.index({ owner: 1, assignedTo: 1, status: 1, lastActivityAt: -1 })

/** A lead's conversations. */
conversationSchema.index({ owner: 1, lead: 1, lastActivityAt: -1 })

/** Reply matching by message id — the hot path on every inbound message. */
conversationSchema.index({ owner: 1, messageIds: 1 })

/** Global search. */
conversationSchema.index(
  { subject: 'text', counterpartyEmail: 'text', counterpartyName: 'text' },
  { name: 'conversation_search', weights: { subject: 8, counterpartyEmail: 6, counterpartyName: 4 } },
)

/** True when the customer is waiting on us. */
conversationSchema.methods.needsResponse = function needsResponse() {
  return this.status === CONVERSATION_STATUS.AWAITING_US
}

/**
 * Rebuilds the counters from the messages that exist.
 *
 * The reconciliation path for the denormalisation described at the top, and the
 * only place the derived fields are written — a second writer would guarantee
 * drift.
 */
conversationSchema.methods.recalculate = async function recalculate() {
  const ConversationMessage = mongoose.model('ConversationMessage')

  const messages = await ConversationMessage.find({ conversation: this._id })
    .sort({ occurredAt: 1 })
    .select('direction occurredAt bodyText subject from isRead hasAttachments attachmentCount internetMessageId')

  const incoming = messages.filter((message) => message.direction === 'incoming')
  const outgoing = messages.filter((message) => message.direction === 'outgoing')

  this.messageCount = messages.length
  this.replyCount = incoming.length
  this.attachmentCount = messages.reduce((sum, message) => sum + (message.attachmentCount ?? 0), 0)
  this.unreadCount = incoming.filter((message) => !message.isRead).length

  const newestIncoming = incoming.at(-1)
  const newestOutgoing = outgoing.at(-1)

  const pointer = (message) =>
    message
      ? {
          message: message._id,
          at: message.occurredAt,
          preview: String(message.bodyText ?? '').slice(0, 512),
          from: message.from?.address ?? null,
        }
      : {}

  this.lastIncomingMessage = pointer(newestIncoming)
  this.lastOutgoingMessage = pointer(newestOutgoing)

  const newest = messages.at(-1)
  if (newest) this.lastActivityAt = newest.occurredAt

  // Keep the id set complete, so later replies match on it.
  const ids = new Set(this.messageIds)
  for (const message of messages) {
    if (message.internetMessageId) ids.add(message.internetMessageId)
  }
  this.messageIds = [...ids]

  /**
   * First response time: our earliest send, to their earliest answer after it.
   *
   * Measured from the send rather than from conversation creation, because a
   * conversation may be created by an inbound message we never solicited, and
   * calling that a zero-second response would flatter the average.
   */
  if (this.firstResponseMs === null && outgoing.length > 0 && incoming.length > 0) {
    const firstSend = outgoing[0].occurredAt
    const firstAnswer = incoming.find((message) => message.occurredAt > firstSend)
    if (firstAnswer) this.firstResponseMs = firstAnswer.occurredAt - firstSend
  }

  // Status follows the traffic, unless a human has closed or archived it.
  if (![CONVERSATION_STATUS.CLOSED, CONVERSATION_STATUS.ARCHIVED].includes(this.status)) {
    if (!newest) this.status = CONVERSATION_STATUS.AWAITING_REPLY
    else if (newest.direction === 'incoming') this.status = CONVERSATION_STATUS.AWAITING_US
    else this.status = incoming.length > 0 ? CONVERSATION_STATUS.OPEN : CONVERSATION_STATUS.AWAITING_REPLY
  }

  await this.save()
  return this
}

conversationSchema.methods.toSummaryJSON = function toSummaryJSON() {
  return {
    id: this._id.toString(),
    subject: this.subject || '(no subject)',
    status: this.status,
    statusLabel: CONVERSATION_STATUS_LABELS[this.status] ?? this.status,
    counterpartyEmail: this.counterpartyEmail,
    counterpartyName: this.counterpartyName,
    lead: this.lead?.toString() ?? null,
    company: this.company?.toString() ?? null,
    contact: this.contact?.toString() ?? null,
    campaign: this.campaign?.toString() ?? null,
    assignedTo: this.assignedTo?.toString() ?? null,
    unreadCount: this.unreadCount,
    messageCount: this.messageCount,
    replyCount: this.replyCount,
    attachmentCount: this.attachmentCount,
    isPinned: this.isPinned,
    needsResponse: this.needsResponse(),
    lastActivityAt: this.lastActivityAt,
    lastIncomingAt: this.lastIncomingMessage?.at ?? null,
    lastOutgoingAt: this.lastOutgoingMessage?.at ?? null,
    preview:
      this.lastIncomingMessage?.preview ??
      this.lastOutgoingMessage?.preview ??
      null,
    matchStrategy: this.matchStrategy,
    matchStrategyLabel: this.matchStrategy ? MATCH_STRATEGY_LABELS[this.matchStrategy] : null,
    matchConfidence: this.matchConfidence,
    isMatched: this.lead !== null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

conversationSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    ...this.toSummaryJSON(),
    provider: this.provider,
    providerConversationId: this.providerConversationId,
    providerThreadId: this.providerThreadId,
    firstResponseMs: this.firstResponseMs,
    closedAt: this.closedAt,
    archivedAt: this.archivedAt,
  }
}

/** Statuses a caller may set by hand. Derived ones are managed by the engine. */
conversationSchema.statics.MANUAL_STATUSES = Object.freeze([
  CONVERSATION_STATUS.OPEN,
  CONVERSATION_STATUS.CLOSED,
  CONVERSATION_STATUS.ARCHIVED,
])

export const Conversation = mongoose.model('Conversation', conversationSchema)

export default Conversation
