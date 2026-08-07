/**
 * The lead timeline.
 *
 * One append-only record of everything that has happened to an enquiry:
 * imported, campaigned, mailed, replied to, noted, assigned, moved. It is the
 * business history the sales team reads, so it deliberately mixes machine
 * events with human ones — a note and a bounce belong on the same line, in the
 * order they happened.
 *
 * ## Notes live here too
 *
 * An internal note is an activity with a body. Giving notes their own
 * collection would mean two queries and a merge sort to render one timeline,
 * and the ordering would be a client-side guess whenever timestamps tie.
 *
 * ## Retention
 *
 * Kept indefinitely, unlike the 90-day campaign events. A campaign event is
 * telemetry; this is the record of a commercial relationship, and deleting the
 * note explaining why a deal was lost would be destroying the thing the CRM
 * exists to remember.
 */

import mongoose from 'mongoose'

import {
  ACTIVITY_TYPE,
  ACTIVITY_TYPE_LABELS,
  ACTIVITY_TYPE_VALUES,
} from '../modules/conversations/constants/conversationConstants.js'

const { Schema } = mongoose

/** Activity kinds that carry a human-written body. */
const NOTE_TYPES = new Set([ACTIVITY_TYPE.NOTE_ADDED])

const conversationActivitySchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** At least one of these is always set; usually both. */
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null, index: true },

    company: { type: Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', default: null },

    type: { type: String, enum: ACTIVITY_TYPE_VALUES, required: true, index: true },

    /** One line for the timeline. Always present, even for machine events. */
    summary: { type: String, required: true, trim: true, maxlength: 512 },

    /** The note text, for a note. Rich text is stored as sanitised HTML. */
    body: { type: String, default: null, maxlength: 20_000 },

    /**
     * Notes are internal by construction.
     *
     * Declared rather than assumed, so a future "share with customer" feature
     * has to opt in explicitly instead of silently leaking years of candid
     * commentary.
     */
    isInternal: { type: Boolean, default: true },

    isPinned: { type: Boolean, default: false },

    /** Users named with @ in a note. Drives the mention notification. */
    mentions: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },

    /** Whoever caused it. Null for anything the system did on its own. */
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /** Related records, so the timeline can link out. */
    message: { type: Schema.Types.ObjectId, ref: 'ConversationMessage', default: null },
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null },
    task: { type: Schema.Types.ObjectId, ref: 'LeadTask', default: null },
    attachment: { type: Schema.Types.ObjectId, ref: 'ConversationAttachment', default: null },

    /** Type-specific extras: old and new stage, failure reason, and so on. */
    detail: { type: Schema.Types.Mixed, default: null },

    occurredAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true, versionKey: false },
)

/** The lead timeline: newest first. */
conversationActivitySchema.index({ owner: 1, lead: 1, occurredAt: -1 })

/** A conversation's own activity strip. */
conversationActivitySchema.index({ owner: 1, conversation: 1, occurredAt: -1 })

/** "What did this person do", and the mention inbox. */
conversationActivitySchema.index({ owner: 1, actor: 1, occurredAt: -1 })
conversationActivitySchema.index({ mentions: 1, occurredAt: -1 })

/** Pinned notes surface above the timeline. */
conversationActivitySchema.index({ owner: 1, lead: 1, isPinned: 1 })

/** Notes are searchable; machine summaries are too, and cheaply. */
conversationActivitySchema.index(
  { summary: 'text', body: 'text' },
  { name: 'activity_search', weights: { body: 4, summary: 2 } },
)

conversationActivitySchema.methods.isNote = function isNote() {
  return NOTE_TYPES.has(this.type)
}

conversationActivitySchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    type: this.type,
    typeLabel: ACTIVITY_TYPE_LABELS[this.type] ?? this.type,
    summary: this.summary,
    body: this.body,
    isNote: this.isNote(),
    isInternal: this.isInternal,
    isPinned: this.isPinned,
    mentions: this.mentions.map((id) => id.toString()),
    actor: this.actor?.toString() ?? null,
    lead: this.lead?.toString() ?? null,
    conversation: this.conversation?.toString() ?? null,
    company: this.company?.toString() ?? null,
    message: this.message?.toString() ?? null,
    campaign: this.campaign?.toString() ?? null,
    task: this.task?.toString() ?? null,
    attachment: this.attachment?.toString() ?? null,
    detail: this.detail,
    occurredAt: this.occurredAt,
  }
}

/**
 * Appends an activity.
 *
 * A static rather than a bare `create` so every caller writes the same shape
 * and the timeline cannot fill with rows missing a summary.
 */
conversationActivitySchema.statics.record = async function record({
  owner,
  type,
  summary,
  lead = null,
  conversation = null,
  company = null,
  contact = null,
  actor = null,
  message = null,
  campaign = null,
  task = null,
  attachment = null,
  body = null,
  mentions = [],
  isPinned = false,
  detail = null,
  occurredAt = null,
}) {
  return this.create({
    owner,
    type,
    summary: String(summary).slice(0, 512),
    lead,
    conversation,
    company,
    contact,
    actor,
    message,
    campaign,
    task,
    attachment,
    body,
    mentions,
    isPinned,
    detail,
    occurredAt: occurredAt ?? new Date(),
  })
}

export const ConversationActivity = mongoose.model(
  'ConversationActivity',
  conversationActivitySchema,
)

export default ConversationActivity
