/**
 * A follow-up sequence: an ordered set of messages sent over days.
 *
 * ## Stopping on reply is the whole point
 *
 * A sequence that keeps sending after someone has replied is worse than no
 * sequence at all — it reads as automated spam to a person who was actively
 * engaging. `stopOnReply` defaults to true and every step honours it.
 *
 * Out-of-office replies deliberately do NOT stop a sequence: the recipient has
 * not read the message, and treating an auto-responder as engagement drops a
 * live lead. See `SEQUENCE_STOPPING_REPLIES`.
 */

import mongoose from 'mongoose'

const { Schema } = mongoose

const sequenceStepSchema = new Schema(
  {
    /** Days after the previous step. 0 for the initial send. */
    delayDays: { type: Number, required: true, min: 0, max: 365 },

    template: { type: Schema.Types.ObjectId, ref: 'CampaignTemplate', required: true },

    /** Overrides the template's subject for this step, when set. */
    subjectOverride: { type: String, default: null, trim: true, maxlength: 998 },

    name: { type: String, default: null, trim: true, maxlength: 200 },

    /**
     * Send this step only to recipients who have not opened the previous one.
     *
     * The common shape for a "did you see this?" follow-up, and the reason a
     * sequence needs per-step conditions rather than just delays.
     */
    onlyIfNotOpened: { type: Boolean, default: false },
  },
  { _id: false },
)

const campaignSequenceSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, default: null, maxlength: 1000 },

    steps: {
      type: [sequenceStepSchema],
      default: [],
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0 && value.length <= 10,
        message: 'A sequence needs between 1 and 10 steps.',
      },
    },

    stopOnReply: { type: Boolean, default: true },

    /** Stop the sequence for a contact who unsubscribes. Always honoured. */
    stopOnUnsubscribe: { type: Boolean, default: true },

    useCount: { type: Number, default: 0, min: 0 },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, versionKey: false },
)

campaignSequenceSchema.index(
  { owner: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
)

/** Total span in days, for the builder's summary. */
campaignSequenceSchema.methods.totalDays = function totalDays() {
  return this.steps.reduce((sum, step) => sum + step.delayDays, 0)
}

campaignSequenceSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    description: this.description,
    steps: this.steps.map((step, index) => ({
      index,
      delayDays: step.delayDays,
      template: step.template?.toString() ?? null,
      subjectOverride: step.subjectOverride,
      name: step.name ?? `Step ${index + 1}`,
      onlyIfNotOpened: step.onlyIfNotOpened,
    })),
    stepCount: this.steps.length,
    totalDays: this.totalDays(),
    stopOnReply: this.stopOnReply,
    stopOnUnsubscribe: this.stopOnUnsubscribe,
    useCount: this.useCount,
    createdAt: this.createdAt,
  }
}

export const CampaignSequence = mongoose.model('CampaignSequence', campaignSequenceSchema)

export default CampaignSequence
