/**
 * One person's place in one campaign.
 *
 * A document per recipient rather than an array on the campaign — see the note
 * in `campaign.model.js` for why. The practical consequence is that this
 * collection is the largest in the system: 20 campaigns to 5,000 people each is
 * 100,000 documents, so every field here is chosen for what it costs.
 *
 * ## The claim pattern
 *
 * The queue claims work with a single atomic `findOneAndUpdate` that moves a
 * recipient from `queued` to `sending`. That is what makes concurrent workers
 * safe: two processes cannot claim the same recipient, because only one update
 * can match a document whose status is still `queued`.
 */

import mongoose from 'mongoose'

import {
  FAILURE_KIND_VALUES,
  RECIPIENT_STATUS,
  RECIPIENT_STATUS_LABELS,
  RECIPIENT_STATUS_VALUES,
  REPLY_KIND_VALUES,
} from '../modules/campaigns/constants/campaignConstants.js'

const { Schema } = mongoose

const campaignRecipientSchema = new Schema(
  {
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    contact: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },

    /**
     * The address, copied from the contact at build time.
     *
     * Denormalised so sending needs no join, and so the record shows where the
     * message actually went even if the contact's address changes later.
     */
    email: { type: String, required: true, trim: true, lowercase: true },

    /** Personalisation values resolved at build time, for the audit trail. */
    variables: { type: Map, of: String, default: undefined },

    status: {
      type: String,
      enum: RECIPIENT_STATUS_VALUES,
      default: RECIPIENT_STATUS.QUEUED,
      index: true,
    },

    /** Mailbox the message was sent from, for per-mailbox analytics. */
    sentFromMailbox: { type: Schema.Types.ObjectId, ref: 'Mailbox', default: null },

    /** The `Mail` record this send produced, linking to Phase 4's audit trail. */
    mail: { type: Schema.Types.ObjectId, ref: 'Mail', default: null },

    /** Correlates with the provider's own logs. */
    providerMessageId: { type: String, default: null },
    conversationId: { type: String, default: null, index: true },

    attempts: { type: Number, default: 0, min: 0 },

    /** When the next retry becomes eligible. Null when none is scheduled. */
    nextAttemptAt: { type: Date, default: null, index: true },

    lastError: {
      kind: { type: String, enum: [...FAILURE_KIND_VALUES, null], default: null },
      message: { type: String, default: null },
      occurredAt: { type: Date, default: null },
    },

    queuedAt: { type: Date, default: Date.now },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    clickedAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },

    replyKind: { type: String, enum: [...REPLY_KIND_VALUES, null], default: null },

    /** Why a recipient was skipped, so the decision is auditable. */
    skipReason: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
)

/**
 * A contact appears once per campaign.
 *
 * Enforced at the database rather than by the builder, because a campaign
 * assembled from overlapping groups and tags will contain the same person
 * several times — and sending them four copies is the kind of mistake that
 * loses an account.
 */
campaignRecipientSchema.index({ campaign: 1, contact: 1 }, { unique: true })

/**
 * The claim query's index.
 *
 * Ordered to match exactly how the queue selects work: this campaign, still
 * queued, and either never attempted or due for retry.
 */
campaignRecipientSchema.index({ campaign: 1, status: 1, nextAttemptAt: 1 })

/** Supports the recipient list, filtered by status. */
campaignRecipientSchema.index({ campaign: 1, status: 1, createdAt: 1 })

/** Reply detection matches inbound mail against outstanding recipients. */
campaignRecipientSchema.index({ owner: 1, email: 1, status: 1 })

campaignRecipientSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    contact: this.contact?.toString() ?? null,
    email: this.email,
    status: this.status,
    statusLabel: RECIPIENT_STATUS_LABELS[this.status] ?? this.status,
    attempts: this.attempts,
    nextAttemptAt: this.nextAttemptAt,
    lastError: this.lastError?.message ? this.lastError : null,
    sentFromMailbox: this.sentFromMailbox?.toString() ?? null,
    queuedAt: this.queuedAt,
    sentAt: this.sentAt,
    deliveredAt: this.deliveredAt,
    openedAt: this.openedAt,
    repliedAt: this.repliedAt,
    replyKind: this.replyKind,
    skipReason: this.skipReason,
  }
}

export const CampaignRecipient = mongoose.model('CampaignRecipient', campaignRecipientSchema)

export default CampaignRecipient
