/**
 * An immutable record of something that happened to a recipient.
 *
 * The append-only audit trail behind the campaign. `CampaignRecipient` holds the
 * *current* state; this holds how it got there — which is what answers "why did
 * this person receive three emails" or "when exactly did that bounce arrive".
 *
 * ## Retention
 *
 * Swept after 90 days by a TTL index. Events are operational telemetry: a
 * campaign to 10,000 people generates 30,000+ of them, and nobody reads the
 * detail of a send from last quarter. The aggregate counters on the campaign
 * survive indefinitely.
 */

import mongoose from 'mongoose'

import { CAMPAIGN_EVENT_VALUES } from '../modules/campaigns/constants/campaignConstants.js'

const { Schema } = mongoose

const campaignEventSchema = new Schema(
  {
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    recipient: { type: Schema.Types.ObjectId, ref: 'CampaignRecipient', default: null, index: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: { type: String, enum: CAMPAIGN_EVENT_VALUES, required: true, index: true },

    /** The address involved, denormalised so a timeline needs no joins. */
    email: { type: String, default: null, trim: true, lowercase: true },

    mailbox: { type: Schema.Types.ObjectId, ref: 'Mailbox', default: null },

    /**
     * Type-specific detail: the failure kind, the reply classification, the
     * retry delay. Deliberately loose — constraining it would mean a schema
     * change for every new event type.
     */
    detail: { type: Schema.Types.Mixed, default: null },

    // Not `index: true` here: the TTL index below already covers this field,
    // and declaring both makes Mongoose build two identical indexes.
    occurredAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
)

/** Drives the campaign timeline: this campaign's events, newest first. */
campaignEventSchema.index({ campaign: 1, occurredAt: -1 })

/** Supports per-recipient history on the recipient detail view. */
campaignEventSchema.index({ recipient: 1, occurredAt: -1 })

/** Automatic expiry after 90 days — see the note above. */
campaignEventSchema.index({ occurredAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 })

campaignEventSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    type: this.type,
    email: this.email,
    detail: this.detail,
    mailbox: this.mailbox?.toString() ?? null,
    recipient: this.recipient?.toString() ?? null,
    occurredAt: this.occurredAt,
  }
}

export const CampaignEvent = mongoose.model('CampaignEvent', campaignEventSchema)

export default CampaignEvent
