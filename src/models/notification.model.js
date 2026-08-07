/**
 * Something that happened which a person should know about.
 *
 * ## Why this is not the activity timeline
 *
 * `ConversationActivity` already records everything that happens to an enquiry,
 * and it would be tempting to render the bell from it. They answer different
 * questions:
 *
 *   - **Activity** is the *history of a lead*. Complete, permanent, per-enquiry,
 *     and read by someone who has already opened that enquiry.
 *   - **Notification** is an *unread item of work*. Per-person, dismissible, and
 *     read by someone who has not opened anything yet.
 *
 * Rendering the bell from the timeline would mean "mark as read" writing to the
 * business history, and a cleared notification erasing the record that a
 * customer replied. Those are the same table doing two jobs badly.
 *
 * ## Never twice
 *
 * `(owner, dedupeKey)` is unique. For a reply the key is the inbound message's
 * id, so the same message can only ever produce one notification however many
 * times it is ingested — by the timer, by a manual sync racing it, by a delta
 * replay after a 410, or by a restart mid-run. The uniqueness is enforced by
 * the database, not by a check-then-insert that two workers can interleave.
 */

import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * How urgent a notification is, and how it is coloured.
 *
 * Five categories rather than a boolean, because "a campaign finished" and "a
 * mailbox disconnected" both need the bell but need very different attention.
 * `SECURITY` is deliberately separate from `WARNING`: an operator filtering for
 * things that went wrong should not have to wade through role changes, and
 * somebody auditing access should not have to wade through failed sends.
 */
export const NOTIFICATION_CATEGORY = Object.freeze({
  INFORMATION: 'information',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error',
  SECURITY: 'security',
})

export const NOTIFICATION_CATEGORY_VALUES = Object.freeze(Object.values(NOTIFICATION_CATEGORY))

const C = NOTIFICATION_CATEGORY

/**
 * What happened.
 *
 * ## The two original values are unchanged
 *
 * `reply_received` and `reply_unmatched` keep their exact strings. Forty-six
 * documents already carry them, and renaming would orphan every one — the same
 * rule the audit registry follows.
 *
 * ## Each type declares its own category
 *
 * Held in `NOTIFICATION_DEFINITIONS` below rather than passed at the call site,
 * so "a disconnected mailbox is a warning" is decided once. A call site that
 * chose its own category would let the same event arrive as information from
 * one module and as an error from another.
 */
export const NOTIFICATION_TYPE = Object.freeze({
  /** A customer answered. The reason this collection exists. */
  REPLY_RECEIVED: 'reply_received',
  /** An inbound message could not be tied to any enquiry. */
  REPLY_UNMATCHED: 'reply_unmatched',

  // --- Phase 15.1 ---------------------------------------------------------
  USER_INVITED: 'user_invited',
  ROLE_CHANGED: 'role_changed',
  USER_DELETED: 'user_deleted',
  USER_RESTORED: 'user_restored',
  MAILBOX_CONNECTED: 'mailbox_connected',
  MAILBOX_DISCONNECTED: 'mailbox_disconnected',
  MAILBOX_ASSIGNED: 'mailbox_assigned',
  CAMPAIGN_STARTED: 'campaign_started',
  CAMPAIGN_COMPLETED: 'campaign_completed',
  CAMPAIGN_FAILED: 'campaign_failed',
  LEAD_ASSIGNED: 'lead_assigned',
  LEAD_IMPORTED: 'lead_imported',
  WORKBOOK_UPLOADED: 'workbook_uploaded',
  WORKBOOK_SYNC_FINISHED: 'workbook_sync_finished',
  TEMPLATE_UPDATED: 'template_updated',
  ORGANIZATION_UPDATED: 'organization_updated',
  PERMISSION_DENIED: 'permission_denied',
  SYSTEM_WARNING: 'system_warning',
  ANALYTICS_READY: 'analytics_ready',

  // --- Phase 18 -----------------------------------------------------------
  TASK_ASSIGNED: 'task_assigned',
  TASK_UPDATED: 'task_updated',
  TASK_COMPLETED: 'task_completed',
  TASK_OVERDUE: 'task_overdue',
  TASK_COMMENTED: 'task_commented',
  GOAL_ASSIGNED: 'goal_assigned',
  GOAL_ACHIEVED: 'goal_achieved',
})

export const NOTIFICATION_TYPE_VALUES = Object.freeze(Object.values(NOTIFICATION_TYPE))

/**
 * Label and category per type. The single source both the API and the bell read.
 *
 * @type {Readonly<Record<string, { label: string, category: string }>>}
 */
export const NOTIFICATION_DEFINITIONS = Object.freeze({
  [NOTIFICATION_TYPE.REPLY_RECEIVED]: { label: 'New customer reply', category: C.INFORMATION },
  [NOTIFICATION_TYPE.REPLY_UNMATCHED]: { label: 'Unmatched reply', category: C.WARNING },

  [NOTIFICATION_TYPE.USER_INVITED]: { label: 'User invited', category: C.SECURITY },
  [NOTIFICATION_TYPE.ROLE_CHANGED]: { label: 'Role changed', category: C.SECURITY },
  [NOTIFICATION_TYPE.USER_DELETED]: { label: 'User deleted', category: C.SECURITY },
  [NOTIFICATION_TYPE.USER_RESTORED]: { label: 'User restored', category: C.SECURITY },
  [NOTIFICATION_TYPE.MAILBOX_CONNECTED]: { label: 'Mailbox connected', category: C.SUCCESS },
  [NOTIFICATION_TYPE.MAILBOX_DISCONNECTED]: { label: 'Mailbox disconnected', category: C.ERROR },
  [NOTIFICATION_TYPE.MAILBOX_ASSIGNED]: { label: 'Mailbox assigned', category: C.SECURITY },
  [NOTIFICATION_TYPE.CAMPAIGN_STARTED]: { label: 'Campaign started', category: C.INFORMATION },
  [NOTIFICATION_TYPE.CAMPAIGN_COMPLETED]: { label: 'Campaign completed', category: C.SUCCESS },
  [NOTIFICATION_TYPE.CAMPAIGN_FAILED]: { label: 'Campaign failed', category: C.ERROR },
  [NOTIFICATION_TYPE.LEAD_ASSIGNED]: { label: 'Enquiry assigned', category: C.INFORMATION },
  [NOTIFICATION_TYPE.LEAD_IMPORTED]: { label: 'Enquiries imported', category: C.SUCCESS },
  [NOTIFICATION_TYPE.WORKBOOK_UPLOADED]: { label: 'Workbook uploaded', category: C.INFORMATION },
  [NOTIFICATION_TYPE.WORKBOOK_SYNC_FINISHED]: { label: 'Workbook sync finished', category: C.SUCCESS },
  [NOTIFICATION_TYPE.TEMPLATE_UPDATED]: { label: 'Template updated', category: C.INFORMATION },
  [NOTIFICATION_TYPE.ORGANIZATION_UPDATED]: { label: 'Organization updated', category: C.SECURITY },
  [NOTIFICATION_TYPE.PERMISSION_DENIED]: { label: 'Permission denied', category: C.SECURITY },
  [NOTIFICATION_TYPE.SYSTEM_WARNING]: { label: 'System warning', category: C.WARNING },
  [NOTIFICATION_TYPE.ANALYTICS_READY]: { label: 'Analytics ready', category: C.INFORMATION },

  /*
   * Phase 18. `TASK_OVERDUE` is a warning and the rest are not: a deadline that
   * has passed is the only one of these that means something has gone wrong.
   * Grading an ordinary assignment as a warning would train people to dismiss
   * the bell.
   */
  [NOTIFICATION_TYPE.TASK_ASSIGNED]: { label: 'Task assigned', category: C.INFORMATION },
  [NOTIFICATION_TYPE.TASK_UPDATED]: { label: 'Task updated', category: C.INFORMATION },
  [NOTIFICATION_TYPE.TASK_COMPLETED]: { label: 'Task completed', category: C.SUCCESS },
  [NOTIFICATION_TYPE.TASK_OVERDUE]: { label: 'Task overdue', category: C.WARNING },
  [NOTIFICATION_TYPE.TASK_COMMENTED]: { label: 'New task comment', category: C.INFORMATION },
  [NOTIFICATION_TYPE.GOAL_ASSIGNED]: { label: 'Goal set', category: C.INFORMATION },
  [NOTIFICATION_TYPE.GOAL_ACHIEVED]: { label: 'Goal achieved', category: C.SUCCESS },
})

/** Retained: two call sites in the conversations module import this name. */
export const NOTIFICATION_TYPE_LABELS = Object.freeze(
  Object.fromEntries(
    Object.entries(NOTIFICATION_DEFINITIONS).map(([type, def]) => [type, def.label]),
  ),
)

/** Category for a type, falling back to information for anything unknown. */
export function categoryForType(type) {
  return NOTIFICATION_DEFINITIONS[type]?.category ?? C.INFORMATION
}

const notificationSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: { type: String, enum: NOTIFICATION_TYPE_VALUES, required: true, index: true },

    /**
     * The natural key of the thing this notifies about.
     *
     * For a reply, the `ConversationMessage` id. Chosen over the provider's
     * message id because it is what the rest of the system already treats as
     * the identity of an ingested message, and because `ingestMessage` has
     * already refused to create a second one for the same provider id.
     */
    dedupeKey: { type: String, required: true },

    /** One line, already written for a human. */
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, default: null, trim: true, maxlength: 512 },

    // --- What it points at ---------------------------------------------------
    //
    // All optional: an unmatched reply has a sender and nothing else, and a
    // notification that could not be created because the lead was missing would
    // be the one notification somebody most needed.

    lead: { type: Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },
    company: { type: Schema.Types.ObjectId, ref: 'Company', default: null },
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', default: null },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },
    message: { type: Schema.Types.ObjectId, ref: 'ConversationMessage', default: null },

    /** Denormalised so the bell renders without four populates per row. */
    leadReference: { type: String, default: null, trim: true },
    companyName: { type: String, default: null, trim: true },
    contactName: { type: String, default: null, trim: true },
    senderEmail: { type: String, default: null, trim: true, lowercase: true },
    subject: { type: String, default: null, trim: true, maxlength: 512 },

    // --- Phase 15.1 ------------------------------------------------------
    //
    // Every field below is additive with a default chosen so the forty-six
    // documents written before this phase read back unchanged: `category` is
    // derived from the type on read when absent, `link` is null, and
    // `isDeleted` is false.

    /**
     * Denormalised from the type at write time.
     *
     * Stored rather than derived on every read because it is a *filter* — an
     * index on `{owner, category, occurredAt}` cannot be built on a value the
     * database does not hold. Derived on read only for older documents.
     */
    category: {
      type: String,
      enum: NOTIFICATION_CATEGORY_VALUES,
      default: NOTIFICATION_CATEGORY.INFORMATION,
      index: true,
    },

    /**
     * Where clicking it goes — a client-relative path, never an absolute URL.
     *
     * Relative because an absolute URL stored in the database is an open
     * redirect waiting to happen: whoever can write a notification could send
     * every recipient to a site they chose. The client resolves it against its
     * own origin, so the worst a bad value can do is 404.
     */
    link: { type: String, default: null, trim: true, maxlength: 512 },

    /** Generic target, for types with no dedicated reference above. */
    entityType: { type: String, default: null, trim: true },
    entityId: { type: String, default: null, trim: true },

    /** Who caused it, when that is a person. Denormalised, never populated. */
    actorEmail: { type: String, default: null, trim: true, lowercase: true },

    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },

    /**
     * Dismissal, as a soft delete.
     *
     * The brief asks for "delete notification". A hard delete would let the
     * `(owner, dedupeKey)` uniqueness immediately re-create the same item on
     * the next sync — the reader dismisses a reply, the poller re-inserts it,
     * and it looks like the delete button does not work. Keeping the row keeps
     * the key claimed, so dismissed means dismissed.
     */
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },

    /** When the thing happened, not when the row was written. */
    occurredAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true, versionKey: false },
)

/**
 * The filtered list. Equality-then-sort so the sort is served by the index.
 *
 * `isDeleted` leads because every query carries it — a dismissed notification
 * must never appear, and putting it first keeps the other clauses selective.
 */
notificationSchema.index({ owner: 1, isDeleted: 1, occurredAt: -1 })
notificationSchema.index({ owner: 1, isDeleted: 1, category: 1, occurredAt: -1 })

/**
 * Free-text search over the two fields a person would actually search.
 *
 * A text index rather than a regex scan: `title` and `body` are unbounded, and
 * `$regex` over a growing collection is a scan on every keystroke. This is also
 * what lets notifications participate in global search.
 */
notificationSchema.index(
  { title: 'text', body: 'text' },
  { name: 'notification_search', weights: { title: 3, body: 1 } },
)

/** The bell: this workspace's notifications, newest first. */
notificationSchema.index({ owner: 1, occurredAt: -1 })

/** The unread badge count. */
notificationSchema.index({ owner: 1, isRead: 1, occurredAt: -1 })

/**
 * The duplicate guard.
 *
 * Unique, so a concurrent insert fails at the database rather than producing a
 * second bell entry for one customer reply.
 */
notificationSchema.index({ owner: 1, dedupeKey: 1 }, { unique: true })

/**
 * Creates a notification, or does nothing if one already exists.
 *
 * Returns `null` on a duplicate rather than throwing, because for every caller
 * "it was already there" is success — the point was for the notification to
 * exist, and it does.
 */
notificationSchema.statics.raise = async function raise(entry) {
  try {
    return await this.create(entry)
  } catch (error) {
    if (error?.code === 11_000) return null
    throw error
  }
}

notificationSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    type: this.type,
    typeLabel: NOTIFICATION_TYPE_LABELS[this.type] ?? this.type,
    category: this.category ?? categoryForType(this.type),
    link: this.link ?? null,
    entityType: this.entityType ?? null,
    entityId: this.entityId ?? null,
    actorEmail: this.actorEmail ?? null,
    title: this.title,
    body: this.body,

    /** Present only when there is an enquiry to open. */
    lead: this.lead?.toString() ?? null,
    leadReference: this.leadReference,
    companyName: this.companyName,
    contactName: this.contactName,
    senderEmail: this.senderEmail,
    subject: this.subject,
    conversation: this.conversation?.toString() ?? null,

    isRead: this.isRead,
    readAt: this.readAt,
    occurredAt: this.occurredAt,
  }
}

export const Notification = mongoose.model('Notification', notificationSchema)

export default Notification
