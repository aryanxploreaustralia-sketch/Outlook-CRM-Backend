/**
 * A bulk outreach campaign.
 *
 * Holds the configuration and the running totals; the per-recipient state lives
 * in `CampaignRecipient`, one document each. That split is deliberate: a
 * campaign to 10,000 people cannot keep its recipients in an array — the
 * document would exceed MongoDB's 16 MB limit at around 40,000 recipients, and
 * long before that every status update would rewrite the whole thing.
 *
 * ## The counters are denormalised
 *
 * `stats` duplicates what could be derived by aggregating recipients. That is
 * intentional: the live dashboard polls every few seconds, and a `$group` over
 * 10,000 recipient documents per poll is far more expensive than incrementing
 * six numbers as sends complete. The aggregate remains the source of truth, and
 * `recomputeStats()` exists to reconcile them if they ever drift.
 */

import mongoose from 'mongoose'

import {
  CAMPAIGN_PRIORITY,
  CAMPAIGN_STATUS,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_VALUES,
  DEFAULT_BATCH_SIZE,
  DEFAULT_RATE_LIMITS,
  AUDIENCE_SOURCE_VALUES,
} from '../modules/campaigns/constants/campaignConstants.js'

const { Schema } = mongoose

/** How the recipient list was assembled, kept so a campaign can be re-targeted. */
const audienceSchema = new Schema(
  {
    source: { type: String, enum: AUDIENCE_SOURCE_VALUES, default: 'manual' },
    /**
     * Explicitly chosen contacts — the wizard's "Choose Contacts" step.
     *
     * Must be declared: this subdocument is strict, and an undeclared field is
     * silently dropped on save, which would make manual selection appear to work
     * and then produce a campaign with no recipients.
     */
    contactIds: { type: [Schema.Types.ObjectId], default: [] },
    /** The filter that produced the list, replayable for a clone. */
    filter: { type: Schema.Types.Mixed, default: null },
    groupIds: { type: [Schema.Types.ObjectId], default: [] },
    tags: { type: [String], default: [] },
    importJobId: { type: Schema.Types.ObjectId, ref: 'ImportJob', default: null },
    /**
     * Lead-register criteria — stage, city, travel month, company, market.
     *
     * Stored as the criteria rather than the resolved ids so a rebuild picks up
     * leads that have since moved into the targeted stage. Freezing the ids
     * would make "everyone at the quoted stage" mean "everyone who was quoted
     * on the afternoon the campaign was built".
     */
    leadCriteria: { type: Schema.Types.Mixed, default: null },
    /** Contacts excluded by hand after the list was built. */
    excludedContactIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { _id: false },
)

/** Throughput controls, per campaign so a large send can be slowed independently. */
const throttleSchema = new Schema(
  {
    perMinute: { type: Number, default: DEFAULT_RATE_LIMITS.perMinute, min: 1 },
    perHour: { type: Number, default: DEFAULT_RATE_LIMITS.perHour, min: 1 },
    perDay: { type: Number, default: DEFAULT_RATE_LIMITS.perDay, min: 1 },
    batchSize: { type: Number, default: DEFAULT_BATCH_SIZE, min: 1 },
  },
  { _id: false },
)

const campaignSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, default: null, maxlength: 2000 },

    status: {
      type: String,
      enum: CAMPAIGN_STATUS_VALUES,
      default: CAMPAIGN_STATUS.DRAFT,
      index: true,
    },

    priority: { type: Number, default: CAMPAIGN_PRIORITY.NORMAL, index: true },

    template: { type: Schema.Types.ObjectId, ref: 'CampaignTemplate', default: null },

    /**
     * Subject and body captured at launch.
     *
     * Copied from the template rather than referenced, so editing a template
     * later cannot retroactively change what a running campaign is sending —
     * which would make the audit trail a lie.
     */
    subject: { type: String, default: '', maxlength: 998 },
    bodyHtml: { type: String, default: '' },

    /**
     * Mailboxes to send from, used in rotation.
     *
     * An array rather than one, because sending 5,000 messages from a single
     * mailbox in a day is what triggers Exchange throttling and reputation
     * damage. Spreading across `enquiry@`, `sales@` and so on is the standard
     * mitigation.
     */
    senderMailboxes: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Mailbox' }],
      default: [],
    },

    audience: { type: audienceSchema, default: () => ({}) },
    throttle: { type: throttleSchema, default: () => ({}) },

    /**
     * Campaign-scoped personalisation values.
     *
     * `{{Destination}}` and `{{Agent}}` are the same for every recipient of one
     * campaign, so they belong here rather than duplicated across ten thousand
     * recipient documents. A per-recipient value still wins where one exists —
     * a spreadsheet column naming a different destination per row is legitimate
     * and must override the campaign default.
     */
    variables: { type: Map, of: String, default: undefined },

    /** Follow-up sequence, when one is attached. */
    sequence: { type: Schema.Types.ObjectId, ref: 'CampaignSequence', default: null },

    /** Step within the sequence this campaign represents. 0 is the initial send. */
    sequenceStep: { type: Number, default: 0, min: 0 },

    /** The campaign this one follows up on, for a generated sequence step. */
    parentCampaign: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true },

    scheduledFor: { type: Date, default: null, index: true },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },

    stats: {
      recipients: { type: Number, default: 0, min: 0 },
      queued: { type: Number, default: 0, min: 0 },
      sent: { type: Number, default: 0, min: 0 },
      delivered: { type: Number, default: 0, min: 0 },
      opened: { type: Number, default: 0, min: 0 },
      clicked: { type: Number, default: 0, min: 0 },
      replied: { type: Number, default: 0, min: 0 },
      failed: { type: Number, default: 0, min: 0 },
      bounced: { type: Number, default: 0, min: 0 },
      skipped: { type: Number, default: 0, min: 0 },
    },

    lastError: {
      message: { type: String, default: null },
      occurredAt: { type: Date, default: null },
    },

    /** Guards against two workers draining one campaign. Expires like a sync lock. */
    lockedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
)

/** Drives the campaign list: this user's campaigns, newest first. */
campaignSchema.index({ owner: 1, status: 1, createdAt: -1 })

/** Finds campaigns eligible to send, highest priority first. */
campaignSchema.index({ status: 1, priority: -1, scheduledFor: 1 })

/** A lock older than this belonged to a process that died. */
export const CAMPAIGN_LOCK_TTL_MS = 5 * 60 * 1000

campaignSchema.methods.isLocked = function isLocked() {
  if (!this.lockedAt) return false
  return Date.now() - this.lockedAt.getTime() < CAMPAIGN_LOCK_TTL_MS
}

/** Recipients still awaiting a send. */
campaignSchema.methods.remaining = function remaining() {
  const s = this.stats
  const finished = s.sent + s.failed + s.bounced + s.skipped
  return Math.max(0, s.recipients - finished)
}

/**
 * Estimated completion, derived from the configured rate rather than observed
 * throughput.
 *
 * Observed rate would be more accurate mid-run but is wildly unstable at the
 * start — the first batch completing in two seconds implies an ETA of minutes
 * for a job that will actually take hours. The configured ceiling is the honest
 * bound: the campaign cannot finish sooner than this.
 *
 * @returns {?Date}
 */
campaignSchema.methods.estimatedCompletion = function estimatedCompletion() {
  const remaining = this.remaining()
  if (remaining === 0) return null

  const perMinute = Math.max(1, this.throttle?.perMinute ?? DEFAULT_RATE_LIMITS.perMinute)
  const minutes = Math.ceil(remaining / perMinute)

  return new Date(Date.now() + minutes * 60_000)
}

/**
 * Recomputes the denormalised counters from the recipient documents.
 *
 * The reconciliation path for the deliberate denormalisation described at the
 * top of this file. Called after a bulk operation, and available to an operator
 * if the numbers ever look wrong.
 */
campaignSchema.methods.recomputeStats = async function recomputeStats() {
  const CampaignRecipient = mongoose.model('CampaignRecipient')

  const grouped = await CampaignRecipient.aggregate([
    { $match: { campaign: this._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ])

  const counts = Object.fromEntries(grouped.map(({ _id, count }) => [_id, count]))

  this.stats = {
    recipients: Object.values(counts).reduce((sum, count) => sum + count, 0),
    queued: counts.queued ?? 0,
    // `sent` counts everything that left the building, including recipients who
    // have since progressed to delivered/opened/replied — otherwise the sent
    // figure would fall as engagement rose, which reads as a bug.
    sent:
      (counts.sent ?? 0) +
      (counts.delivered ?? 0) +
      (counts.opened ?? 0) +
      (counts.clicked ?? 0) +
      (counts.replied ?? 0),
    delivered: (counts.delivered ?? 0) + (counts.opened ?? 0) + (counts.clicked ?? 0) + (counts.replied ?? 0),
    opened: (counts.opened ?? 0) + (counts.clicked ?? 0) + (counts.replied ?? 0),
    clicked: counts.clicked ?? 0,
    replied: counts.replied ?? 0,
    failed: counts.failed ?? 0,
    bounced: counts.bounced ?? 0,
    skipped: counts.skipped ?? 0,
  }

  await this.save()
  return this.stats
}

campaignSchema.methods.toSummaryJSON = function toSummaryJSON() {
  const s = this.stats
  const attempted = s.sent + s.failed + s.bounced

  return {
    id: this._id.toString(),
    name: this.name,
    description: this.description,
    status: this.status,
    statusLabel: CAMPAIGN_STATUS_LABELS[this.status] ?? this.status,
    priority: this.priority,
    subject: this.subject,
    stats: s,
    remaining: this.remaining(),
    percentComplete:
      s.recipients === 0 ? 0 : Math.min(100, Math.round(((s.recipients - this.remaining()) / s.recipients) * 100)),
    /** Percentages, rounded to one decimal. Null when nothing has been attempted. */
    rates: {
      delivery: attempted === 0 ? null : Math.round((s.delivered / attempted) * 1000) / 10,
      open: s.delivered === 0 ? null : Math.round((s.opened / s.delivered) * 1000) / 10,
      reply: s.delivered === 0 ? null : Math.round((s.replied / s.delivered) * 1000) / 10,
      bounce: attempted === 0 ? null : Math.round((s.bounced / attempted) * 1000) / 10,
      failure: attempted === 0 ? null : Math.round((s.failed / attempted) * 1000) / 10,
    },
    estimatedCompletion: this.estimatedCompletion(),
    scheduledFor: this.scheduledFor,
    startedAt: this.startedAt,
    completedAt: this.completedAt,
    sequenceStep: this.sequenceStep,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

campaignSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    ...this.toSummaryJSON(),
    bodyHtml: this.bodyHtml,
    template: this.template?.toString() ?? null,
    senderMailboxes: this.senderMailboxes.map((id) => id.toString()),
    audience: this.audience,
    throttle: this.throttle,
    variables: this.variables ? Object.fromEntries(this.variables) : {},
    sequence: this.sequence?.toString() ?? null,
    parentCampaign: this.parentCampaign?.toString() ?? null,
    lastError: this.lastError?.message ? this.lastError : null,
    isLocked: this.isLocked(),
  }
}

export const Campaign = mongoose.model('Campaign', campaignSchema)

export default Campaign
