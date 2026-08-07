/**
 * Outbound mail record.
 *
 * Every send attempt is written here, successful or not. That is the point of
 * the collection: it is the CRM's own audit trail, independent of the mailbox.
 * A message that Graph rejected never reaches Sent Items, so without this record
 * there would be no trace that the user tried at all.
 *
 * ## What is deliberately not stored
 *
 * Attachment *content* is not persisted. Base64 payloads would grow the
 * collection without bound — a 3 MB attachment costs 4 MB per row — and the
 * bytes are already in the sent message. Only the metadata needed to describe
 * what was attached is kept, which is what the history view actually renders.
 */

import mongoose from 'mongoose'

import { MAIL_STATUS, MAIL_STATUS_LABELS, MAIL_STATUS_VALUES } from '../constants/mailStatus.js'
import { FOLDER_VALUES, FOLDERS } from '../modules/provider/constants/folderTypes.js'

const { Schema } = mongoose

/**
 * A recipient as Graph reports it.
 *
 * Stored as a subdocument rather than a bare string so a display name survives
 * the round trip; `_id: false` keeps Mongoose from minting an ObjectId for
 * every address, which would triple the size of a large recipient list.
 */
const recipientSchema = new Schema(
  {
    address: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    name: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false },
)

/** Attachment metadata — never the bytes. */
const attachmentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    contentType: { type: String, trim: true, default: 'application/octet-stream' },
    /** Decoded size in bytes, computed server-side from the base64 payload. */
    size: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
)

/**
 * Why a send failed.
 *
 * Graph's own `code` is preserved verbatim because it is the only value precise
 * enough to diagnose a failure after the fact — `ErrorSendAsDenied` and
 * `MailboxNotEnabledForRESTAPI` both surface to the user as "could not send",
 * but they need completely different fixes.
 */
const mailErrorSchema = new Schema(
  {
    code: { type: String, trim: true, default: null },
    message: { type: String, trim: true, default: null },
    statusCode: { type: Number, default: null },
    failedAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

const mailSchema = new Schema(
  {
    /**
     * Owner of the record. Every query in the service layer filters on this —
     * it is what stops one user reading another's mail history.
     */
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /**
     * Mailbox the message was sent from.
     *
     * Kept alongside `userId` because a user may reconnect a different mailbox
     * later; without it, history would misattribute older messages to whichever
     * account happens to be connected now.
     */
    outlookAccountId: {
      type: Schema.Types.ObjectId,
      ref: 'OutlookAccount',
      default: null,
    },

    from: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    to: {
      type: [recipientSchema],
      validate: {
        /**
         * A recipient is required to *send*, but not to save a draft — an
         * unaddressed draft is the normal state of a message someone is still
         * writing. Declared with `function` so `this` is the document.
         */
        validator: function requiresRecipientUnlessDraft(value) {
          if (this.status === MAIL_STATUS.DRAFT) return true
          return Array.isArray(value) && value.length > 0
        },
        message: 'At least one recipient is required.',
      },
    },
    cc: { type: [recipientSchema], default: [] },
    bcc: { type: [recipientSchema], default: [] },

    subject: {
      type: String,
      trim: true,
      default: '',
      maxlength: 998, // RFC 5322 line-length ceiling for a header.
    },

    /** Rendered HTML body, as submitted to Graph. */
    html: { type: String, default: '' },

    /**
     * Plain-text equivalent.
     *
     * Derived from `html` when the client does not supply one, so history search
     * and previews have something readable to work with regardless of how the
     * message was composed.
     */
    text: { type: String, default: '' },

    attachments: { type: [attachmentSchema], default: [] },

    /**
     * Graph's identifier for the message.
     *
     * Populated for drafts, which are created with `POST /me/messages` and do
     * return an id. It stays null for sends: `POST /me/sendMail` answers 202
     * with an empty body and exposes no id at all. `graphRequestId` below is the
     * correlation handle for those.
     */
    graphMessageId: {
      type: String,
      trim: true,
      default: null,
      index: true,
      sparse: true,
    },

    /**
     * The `client-request-id` sent with the Graph call.
     *
     * This is the value Microsoft support asks for when investigating a delivery
     * problem, and it is the only thread tying a row here to a request in
     * Graph's own logs.
     */
    graphRequestId: {
      type: String,
      trim: true,
      default: null,
    },

    status: {
      type: String,
      enum: MAIL_STATUS_VALUES,
      default: MAIL_STATUS.PENDING,
      index: true,
    },

    error: {
      type: mailErrorSchema,
      default: null,
    },

    // --- Phase 5: synchronisation ------------------------------------------
    //
    // Added additively, every field with a default that describes what an
    // existing Phase 4 document already is. A row written before this phase
    // reads back as an outbound, read, unstarred message in the sent folder —
    // which is exactly what it is — so no migration is needed and no existing
    // query changes meaning.

    /**
     * Which way the message travelled.
     *
     * Defaults to `outbound` because every record written before Phase 5 was
     * created by the send path.
     */
    direction: {
      type: String,
      enum: ['outbound', 'inbound'],
      default: 'outbound',
      index: true,
    },

    /** Mailbox this message was synchronised from. Null for locally-composed mail. */
    mailbox: {
      type: Schema.Types.ObjectId,
      ref: 'Mailbox',
      default: null,
      index: true,
    },

    /** Which adapter produced it, so provider-specific ids stay interpretable. */
    provider: {
      type: String,
      default: null,
    },

    /**
     * The provider's message id.
     *
     * Distinct from `graphMessageId`, which is retained untouched for backward
     * compatibility. New code writes both for Microsoft; only this one is read
     * by provider-independent logic.
     */
    providerMessageId: {
      type: String,
      trim: true,
      default: null,
    },

    /**
     * Provider version marker (Graph calls it `changeKey`).
     *
     * The basis for conflict detection: an unchanged key means the remote copy
     * has not moved, so a local edit can be kept without inspecting fields.
     */
    changeKey: { type: String, default: null },

    conversationId: { type: String, trim: true, default: null, index: true },
    threadId: { type: String, trim: true, default: null },

    /**
     * The RFC 5322 Message-ID this mail carries.
     *
     * Added in Phase 9. It is the only thread key that survives leaving the
     * Microsoft estate: a customer replying from Gmail names it in In-Reply-To,
     * and that header is how the reply is tied back to the enquiry it answers.
     *
     * Populated by the sent-folder sync, not at send time — Graph's `sendMail`
     * returns 202 with no body and no id.
     */
    internetMessageId: { type: String, trim: true, default: null },

    /** Canonical folder. Existing sent mail is, correctly, in `sent`. */
    folder: {
      type: String,
      enum: FOLDER_VALUES,
      default: FOLDERS.SENT,
      index: true,
    },

    labels: { type: [String], default: [] },

    /** True for anything this user sent — they have necessarily seen it. */
    isRead: { type: Boolean, default: true },
    isStarred: { type: Boolean, default: false },

    /** Soft delete. Excluded from history unless explicitly requested. */
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },

    /** When a scheduled message should be sent. Null for immediate sends. */
    scheduledAt: { type: Date, default: null },

    receivedAt: { type: Date, default: null },
    lastSyncedAt: { type: Date, default: null },

    /** When Graph accepted the message. Null until then. */
    sentAt: { type: Date, default: null },

    /**
     * When the customer answered this message (Phase H4).
     *
     * Additive and nullable, so every record written before this phase reads
     * back as "no reply recorded" — which is exactly what it is. Set once and
     * never cleared; a second reply is more conversation on a thread already
     * known to have been answered.
     */
    repliedAt: { type: Date, default: null },

    /** How many times a send has been attempted for this record. */
    attemptCount: { type: Number, default: 0, min: 0 },

    // --- Phase 11: template provenance -------------------------------------
    //
    // Additive, all nullable. A record written before this phase reads back
    // with no template, which is exactly what it is — composed by hand.
    //
    // Note what is *not* needed here: the rendered subject and body are already
    // stored, verbatim, in `subject` and `html`. So a template being rewritten
    // afterwards cannot change what history shows a customer received — that
    // was already true and remains true. These fields answer the separate
    // question of *which* template, and which version of it, produced them.

    /** The template used, if any. Null for a hand-composed message. */
    template: {
      type: Schema.Types.ObjectId,
      ref: 'CampaignTemplate',
      default: null,
      index: true,
    },

    /**
     * The template's name at send time.
     *
     * Denormalised on purpose: a template can be archived or deleted, and
     * history reading "sent with a template that no longer exists" is useless
     * where "sent with B2B Introduction" is not.
     */
    templateName: { type: String, trim: true, default: null },

    /** Which version of that template. Incremented when its content changes. */
    templateVersion: { type: Number, default: null },

    /**
     * The variable values substituted into this message.
     *
     * Kept because "why did this customer get a blank greeting?" is otherwise
     * unanswerable after the lead has been edited — the rendered HTML shows the
     * gap but not which variable was empty at the time.
     */
    renderedVariables: { type: Map, of: String, default: undefined },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/**
 * Drives the history list, which is always "this user's mail, newest first".
 *
 * Compound and ordered to match that query exactly, so MongoDB can satisfy both
 * the filter and the sort from the index without an in-memory sort.
 */
mailSchema.index({ userId: 1, createdAt: -1 })

/** Supports the status-filtered history view and the dashboard counters. */
mailSchema.index({ userId: 1, status: 1, createdAt: -1 })

/**
 * Duplicate detection for synchronisation.
 *
 * `unique` with `partialFilterExpression` is what makes re-syncing idempotent:
 * a second attempt to insert the same provider message fails at the database
 * rather than relying on the engine's own bookkeeping being correct. The partial
 * filter is essential — without it, every locally-composed message (which has no
 * `providerMessageId`) would collide on null.
 */
mailSchema.index(
  { mailbox: 1, providerMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      mailbox: { $type: 'objectId' },
      providerMessageId: { $type: 'string' },
    },
  },
)

/** Drives the folder views: this user's inbox, newest first, excluding deleted. */
mailSchema.index({ userId: 1, folder: 1, isDeleted: 1, createdAt: -1 })

/** Groups a conversation thread. */
mailSchema.index({ userId: 1, conversationId: 1 })

/** Reply matching resolves In-Reply-To and References through this. */
mailSchema.index({ internetMessageId: 1 }, { sparse: true })

/** Maps a recipient subdocument to a plain address string. */
const toAddresses = (recipients) => (recipients ?? []).map((entry) => entry.address)

/**
 * Full representation for the detail endpoint.
 *
 * `html` is included here but omitted from `toSummaryJSON`, because a history
 * list of 50 messages should not ship 50 message bodies to the browser.
 */
mailSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    ...this.toSummaryJSON(),
    html: this.html,
    text: this.text,
    cc: toAddresses(this.cc),
    bcc: toAddresses(this.bcc),
    graphMessageId: this.graphMessageId,
    graphRequestId: this.graphRequestId,
    attemptCount: this.attemptCount,

    // --- Phase 5 ---
    provider: this.provider,
    providerMessageId: this.providerMessageId,
    conversationId: this.conversationId,
    threadId: this.threadId,
    internetMessageId: this.internetMessageId,
    labels: this.labels,
    receivedAt: this.receivedAt,
    lastSyncedAt: this.lastSyncedAt,

    // --- Phase 11 ---
    template: this.template ? this.template.toString() : null,
    templateName: this.templateName,
    templateVersion: this.templateVersion,
    renderedVariables: this.renderedVariables ? Object.fromEntries(this.renderedVariables) : null,
  }
}

/** Compact representation for list views. */
mailSchema.methods.toSummaryJSON = function toSummaryJSON() {
  return {
    id: this._id.toString(),
    from: this.from,
    to: toAddresses(this.to),
    ccCount: this.cc?.length ?? 0,
    bccCount: this.bcc?.length ?? 0,
    subject: this.subject,
    /** Enough body text for a list preview without sending the whole message. */
    preview: (this.text ?? '').slice(0, 160),
    attachments: (this.attachments ?? []).map((file) => ({
      name: file.name,
      contentType: file.contentType,
      size: file.size,
    })),
    attachmentCount: this.attachments?.length ?? 0,
    status: this.status,
    statusLabel: MAIL_STATUS_LABELS[this.status] ?? this.status,
    error: this.error
      ? { code: this.error.code, message: this.error.message, failedAt: this.error.failedAt }
      : null,
    sentAt: this.sentAt,
    /** Null on every message nobody has answered. */
    repliedAt: this.repliedAt ?? null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,

    // --- Phase 5 ---
    direction: this.direction,
    folder: this.folder,
    isRead: this.isRead,
    isStarred: this.isStarred,
    isDeleted: this.isDeleted,
    scheduledAt: this.scheduledAt,

    // --- Phase 11 --- The name only; the list shows provenance, not content.
    templateName: this.templateName,
    templateVersion: this.templateVersion,
  }
}

export const Mail = mongoose.model('Mail', mailSchema)

export default Mail
