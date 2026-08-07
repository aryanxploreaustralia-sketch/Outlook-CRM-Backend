/**
 * A reusable email template.
 *
 * Templates are versioned by copy, not by reference: a campaign captures its
 * subject and body at launch (see `campaign.model.js`), so editing a template
 * never changes what a running or completed campaign sent. Without that, the
 * analytics on an old campaign would describe a message that no longer exists.
 */

import mongoose from 'mongoose'

import {
  TEMPLATE_CATEGORY,
  TEMPLATE_CATEGORY_LABELS,
  TEMPLATE_CATEGORY_VALUES,
} from '../modules/campaigns/constants/campaignConstants.js'
import {
  TEMPLATE_STATUS,
  TEMPLATE_STATUS_LABELS,
  TEMPLATE_STATUS_VALUES,
} from '../modules/templates/constants/templateConstants.js'

const { Schema } = mongoose

/** A variable the template expects, with a fallback for contacts missing it. */
const variableSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    /**
     * Used when the contact has no value.
     *
     * The reason personalisation is safe to use at all: without a fallback,
     * "Dear {{FirstName}}" becomes "Dear " for every contact whose name the
     * spreadsheet omitted, which is worse than not personalising.
     */
    fallback: { type: String, default: '', trim: true },
    /** Where the value comes from: a Contact field, or supplied per campaign. */
    source: { type: String, enum: ['contact', 'campaign', 'custom'], default: 'contact' },
    description: { type: String, default: null, trim: true },
  },
  { _id: false },
)

const campaignTemplateSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, default: null, maxlength: 1000 },

    category: {
      type: String,
      enum: TEMPLATE_CATEGORY_VALUES,
      default: TEMPLATE_CATEGORY.CUSTOM,
      index: true,
    },

    subject: { type: String, required: true, trim: true, maxlength: 998 },
    bodyHtml: { type: String, required: true, maxlength: 500_000 },

    /**
     * Plain-text alternative.
     *
     * Derived from the HTML when absent. Sending HTML alone raises a message's
     * spam score measurably, which for a cold-outreach campaign is the
     * difference between the inbox and the junk folder.
     */
    bodyText: { type: String, default: '', maxlength: 500_000 },

    variables: { type: [variableSchema], default: [] },

    /** Values for `source: 'campaign'` variables, e.g. the agent's name. */
    defaults: { type: Map, of: String, default: undefined },

    /** Maintained so the library can surface what actually gets used. */
    useCount: { type: Number, default: 0, min: 0 },
    lastUsedAt: { type: Date, default: null },

    /** Aggregate performance, updated when a campaign using it completes. */
    performance: {
      campaigns: { type: Number, default: 0, min: 0 },
      sent: { type: Number, default: 0, min: 0 },
      replied: { type: Number, default: 0, min: 0 },
    },

    isDeleted: { type: Boolean, default: false, index: true },

    // --- Phase 11: the template engine ---------------------------------------
    //
    // Additive. Every field has a default that describes what a template written
    // before this phase already is, so existing rows read back correctly with no
    // migration and no query changes meaning.

    /**
     * Lifecycle. Exactly one template per owner may be `active`.
     *
     * Defaults to `inactive` rather than `active`: a template that existed
     * before this phase was never chosen as *the* automatic introduction, and
     * silently promoting one to that role would start emailing customers with
     * whatever happened to be first in the collection.
     */
    status: {
      type: String,
      enum: TEMPLATE_STATUS_VALUES,
      default: TEMPLATE_STATUS.INACTIVE,
      index: true,
    },

    /**
     * Incremented whenever the subject or either body changes.
     *
     * Mail history records the version it sent, so a message sent last month
     * can still be described accurately after the template has been rewritten
     * twice. The rendered content is stored on the mail record itself, so this
     * is the label rather than the evidence — but without it, "which version of
     * the introduction did this customer get?" has no answer.
     */
    version: { type: Number, default: 1, min: 1 },

    activatedAt: { type: Date, default: null },
    activatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * Marks the introduction seeded on first use.
     *
     * Only used to tell a workspace that has never configured anything from one
     * that has deliberately deactivated everything — the first should be given a
     * working default, the second should be left alone and told.
     */
    isSeeded: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
)

/** Template names are unique per user, case-insensitively. */
campaignTemplateSchema.index(
  { owner: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
)

/**
 * At most one ACTIVE template per owner, enforced by the database.
 *
 * Application code deactivates the incumbent before promoting a successor, but
 * that is two writes and something can always land between them. This index
 * makes a second active template impossible rather than unlikely, which matters
 * because "which template does the morning run use?" must have exactly one
 * answer — an ambiguous one would email customers unpredictably.
 *
 * The partial filter is essential: without it every non-active template would
 * collide with every other on `(owner, status)`.
 */
campaignTemplateSchema.index(
  { owner: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: TEMPLATE_STATUS.ACTIVE },
    name: 'one_active_template_per_owner',
  },
)

/** The library list: this owner's templates, newest first, excluding deleted. */
campaignTemplateSchema.index({ owner: 1, isDeleted: 1, updatedAt: -1 })

/**
 * Bumps the version when the sent content changes.
 *
 * Renaming a template or editing its description is not a new version — nothing
 * a recipient would ever see has changed, and inflating the number would make it
 * useless as a description of what went out.
 */
campaignTemplateSchema.pre('save', async function bumpVersion() {
  if (this.isNew) return

  if (this.isModified('subject') || this.isModified('bodyHtml') || this.isModified('bodyText')) {
    this.version += 1
  }
})

/** Reply rate, the metric that actually ranks an outreach template. */
campaignTemplateSchema.methods.replyRate = function replyRate() {
  if (this.performance.sent === 0) return null
  return Math.round((this.performance.replied / this.performance.sent) * 1000) / 10
}

campaignTemplateSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    description: this.description,
    category: this.category,
    categoryLabel: TEMPLATE_CATEGORY_LABELS[this.category] ?? this.category,
    subject: this.subject,
    bodyHtml: this.bodyHtml,
    bodyText: this.bodyText,
    variables: this.variables,
    defaults: this.defaults ? Object.fromEntries(this.defaults) : {},
    useCount: this.useCount,
    lastUsedAt: this.lastUsedAt,
    performance: {
      ...(this.performance.toObject?.() ?? this.performance),
      replyRate: this.replyRate(),
    },
    createdAt: this.createdAt,

    // --- Phase 11 ---
    status: this.status,
    statusLabel: TEMPLATE_STATUS_LABELS[this.status] ?? this.status,
    isActive: this.status === TEMPLATE_STATUS.ACTIVE,
    version: this.version,
    activatedAt: this.activatedAt,
    isSeeded: this.isSeeded,
    updatedAt: this.updatedAt,
  }
}

/**
 * List representation.
 *
 * Omits the bodies. A library of forty templates would otherwise ship forty
 * full HTML documents to the browser to render forty cards showing a name and a
 * subject line.
 */
campaignTemplateSchema.methods.toSummaryJSON = function toSummaryJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    description: this.description,
    category: this.category,
    categoryLabel: TEMPLATE_CATEGORY_LABELS[this.category] ?? this.category,
    subject: this.subject,
    status: this.status,
    statusLabel: TEMPLATE_STATUS_LABELS[this.status] ?? this.status,
    isActive: this.status === TEMPLATE_STATUS.ACTIVE,
    version: this.version,
    useCount: this.useCount,
    lastUsedAt: this.lastUsedAt,
    replyRate: this.replyRate(),
    activatedAt: this.activatedAt,
    isSeeded: this.isSeeded,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

export const CampaignTemplate = mongoose.model('CampaignTemplate', campaignTemplateSchema)

export default CampaignTemplate
