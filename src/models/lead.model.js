/**
 * One quotation enquiry.
 *
 * Every row of the sales workbook becomes exactly one of these — not one
 * contact, not one company. That distinction is the whole design:
 * `pooja@flamingotravels.co.in` appears on 183 rows, and each is a separate
 * enquiry with its own travel dates, party size, pipeline stage and outcome.
 * Collapsing them onto the person would destroy 58% of the sales history.
 *
 * ## `reference` is the business primary key
 *
 * The team already assigns one (`XAMP01`, `XNMP110`), it appears on quotations
 * and correspondence, and it is what they use to discuss a deal. Keying on it
 * makes re-importing the monthly workbook idempotent: rows the team edited
 * update in place, new rows insert, and nothing duplicates. Email cannot do
 * that job — it is not unique per enquiry, by design.
 */

import mongoose from 'mongoose'

import {
  AUTO_MAIL_STATUS,
  AUTO_MAIL_STATUS_VALUES,
} from '../modules/leads/constants/syncConstants.js'
import {
  CAMPAIGN_ELIGIBLE_STAGES,
  LEAD_STAGE,
  LEAD_STAGE_LABELS,
  LEAD_STAGE_VALUES,
  MARKET,
  MARKET_VALUES,
  TERMINAL_STAGES,
  WON_STAGES,
} from '../modules/leads/constants/leadConstants.js'

const { Schema } = mongoose

/** One stage transition, so the pipeline can be audited and timed. */
const stageChangeSchema = new Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    at: { type: Date, default: Date.now },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, default: null, maxlength: 512 },
  },
  { _id: false },
)

/**
 * One field changing between two workbook uploads.
 *
 * Kept per field rather than as a document snapshot: the question the team asks
 * is "what changed on this enquiry and when", and a diff answers it directly
 * while a snapshot makes them compare two blobs by eye.
 */
const fieldChangeSchema = new Schema(
  {
    field: { type: String, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    at: { type: Date, default: Date.now },
    /** The upload that carried the change, so a run can be traced or undone. */
    importJob: { type: Schema.Types.ObjectId, ref: 'ImportJob', default: null },
  },
  { _id: false },
)

/**
 * The introductory email sent when a lead first appears.
 *
 * Recorded on the lead, not inferred from mail history. "Has this customer
 * already been written to" has to be answerable without scanning a mail
 * collection, and it has to stay true even if mail history is cleared —
 * otherwise a reset would make the engine email everyone a second time.
 */
const autoMailSchema = new Schema(
  {
    status: {
      type: String,
      enum: AUTO_MAIL_STATUS_VALUES,
      default: AUTO_MAIL_STATUS.PENDING,
    },
    sentAt: { type: Date, default: null },
    /** RFC 5322 id, so a reply can be threaded back to this enquiry. */
    messageId: { type: String, default: null },
    /** The provider's thread key. */
    conversationId: { type: String, default: null },
    providerMessageId: { type: String, default: null },
    /** The Phase 4 record, so the send appears in mail history. */
    mail: { type: Schema.Types.ObjectId, ref: 'Mail', default: null },
    subject: { type: String, default: null, maxlength: 998 },
    error: { type: String, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    /** Set when a human deliberately re-sent. */
    forcedAt: { type: Date, default: null },
    forcedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
)

const leadSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /** The business key. Unique per owner — see the note above. */
    reference: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },

    /** Destination market, from the worksheet and the reference prefix. */
    market: { type: String, enum: MARKET_VALUES, default: MARKET.OTHER, index: true },

    // --- Relationships -----------------------------------------------------
    company: { type: Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', default: null, index: true },

    /**
     * The person and firm exactly as the sheet spelled them.
     *
     * Kept alongside the foreign keys rather than replaced by them. The sheet is
     * the system of record: if the resolver later merges two companies, the row
     * must still be able to show what was actually written, and a re-import has
     * to be able to detect that the spelling changed.
     */
    contactPerson: { type: String, required: true, trim: true, maxlength: 256 },
    companyName: { type: String, trim: true, default: null, maxlength: 256 },

    /** Denormalised for the list view and reply matching. */
    email: { type: String, trim: true, lowercase: true, default: null, index: true },
    phones: { type: [String], default: [] },

    // --- Enquiry -----------------------------------------------------------
    quoteDate: { type: Date, default: null, index: true },
    travelDate: { type: Date, default: null, index: true },

    /**
     * The travel date as written, when it is not a date at all.
     *
     * 24 distinct values in the workbook are prose — "August", "Low Season",
     * "Oct '19 - Mar '20". Discarding them would lose the only timing signal
     * those enquiries carry, and inventing a date for "Low Season" would be a
     * fabrication that then drives campaign scheduling.
     */
    travelDateText: { type: String, trim: true, default: null, maxlength: 128 },

    /** Departure city, as typed. Misspellings preserved — they are the data. */
    city: { type: String, trim: true, default: null, maxlength: 128, index: true },

    /** Party size verbatim: `2A`, `2A + 2 C`, `15-35 Pax`. Always kept. */
    paxText: { type: String, trim: true, default: null, maxlength: 128 },

    /** Best-effort parse of `paxText`. Null when it could not be read. */
    adultCount: { type: Number, default: null, min: 0 },
    childCount: { type: Number, default: null, min: 0 },

    // --- Pipeline ----------------------------------------------------------
    stage: {
      type: String,
      enum: LEAD_STAGE_VALUES,
      // An enquiry the office has not closed is, by definition, active. There
      // is no "untouched" stage to fall back to, and inventing one would add a
      // word the sales workbook does not use.
      default: LEAD_STAGE.ACTIVE,
      index: true,
    },

    stageHistory: { type: [stageChangeSchema], default: [] },

    /** Sales executive initials from the sheet. 96% empty there. */
    handledBy: { type: String, trim: true, default: null, maxlength: 64, index: true },

    /** The `Remark` column. Internal only — never sent to a customer. */
    internalNotes: { type: String, trim: true, default: null, maxlength: 4000 },

    /*
     * Where the enquiry came from — website, referral, email, walk-in.
     *
     * Shown as "From". Free text rather than an enum: the sheets carry no such
     * column today, so there is no vocabulary to enumerate yet, and an enum
     * guessed now would reject the first real value somebody types. Indexed
     * because "how many came from referrals" is the question this field exists
     * to answer.
     *
     * Deliberately *not* `city`. That is the departure city of the travellers
     * and means something else entirely.
     */
    source: { type: String, trim: true, default: null, maxlength: 128, index: true },

    // --- Campaign linkage --------------------------------------------------
    /** Campaigns this lead has been included in. */
    campaigns: { type: [{ type: Schema.Types.ObjectId, ref: 'Campaign' }], default: [] },

    lastCampaignAt: { type: Date, default: null },
    lastContactedAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },

    // --- Inbound replies (Phase H4) ----------------------------------------
    //
    // Additive, and deliberately denormalised onto the lead. Every one of these
    // is derivable by aggregating `ConversationMessage`, and every one of them
    // is needed by the leads *list* — "which enquiries have answered?" is the
    // first question a salesperson asks each morning, and answering it with a
    // per-row aggregation across a thousand leads is how a list view becomes a
    // ten-second page load.
    //
    // `repliedAt` above is unchanged and still means what it always did. It is
    // kept rather than folded into `lastReplyAt` because Phase 9 code reads it.

    /** True from the first inbound message, whatever kind. */
    replyReceived: { type: Boolean, default: false, index: true },

    /**
     * How many inbound messages have landed on this enquiry.
     *
     * Incremented with `$inc` on a query that also asserts the message has not
     * been counted, so a replayed sync cannot inflate it — see
     * `applyReplyToLead`.
     */
    replyCount: { type: Number, default: 0, min: 0 },

    /** When the most recent one arrived. */
    lastReplyAt: { type: Date, default: null },

    /** The most recent inbound message, for a one-click jump to it. */
    lastInboundMail: { type: Schema.Types.ObjectId, ref: 'ConversationMessage', default: null },

    /** The thread this enquiry's correspondence lives in. */
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },

    /** Any inbound or outbound event. Drives "went quiet" reporting. */
    lastActivityAt: { type: Date, default: null },

    /**
     * Suppresses this lead from every campaign, whatever its stage.
     *
     * Separate from the stage because the two say different things: a `booked`
     * lead is temporarily ineligible, someone who asked not to be emailed is
     * permanently so, and a later stage change must not silently re-enable them.
     */
    doNotContact: { type: Boolean, default: false, index: true },

    // --- Provenance --------------------------------------------------------
    importJob: { type: Schema.Types.ObjectId, ref: 'ImportJob', default: null, index: true },
    sourceSheet: { type: String, trim: true, default: null },
    /** Row number in the sheet, so an error message can name it. */
    sourceRow: { type: Number, default: null },

    // --- Workbook sync (Phase 10) ------------------------------------------
    /** Field-level diff history across uploads. */
    fieldHistory: { type: [fieldChangeSchema], default: [] },

    /** The automatic introductory email. */
    autoMail: { type: autoMailSchema, default: () => ({}) },

    /**
     * The follow-up chase, when the introduction went unanswered.
     *
     * Additive and sparse: an existing lead has `count: 0` by default and is
     * indistinguishable from one that was never considered, which is what makes
     * this safe to add to a live collection.
     *
     * ## Why so little is stored here
     *
     * No `replyStatus`, no `followUpStatus`, no `initialEmailSentAt`. Every one
     * of those is *derivable*: the reply pipeline already maintains
     * `replyReceived` and `lastReplyAt`, and `autoMail.sentAt` is when the
     * introduction went out. Copying them here would create a second version of
     * the truth that a missed write silently desynchronises — and the failure
     * mode is chasing a customer who already replied, which is exactly what
     * this feature exists to avoid.
     *
     * What genuinely is not derivable is *how many follow-ups have been sent
     * and when*, because a follow-up is an ordinary `Mail` row otherwise
     * indistinguishable from any other message. That is what lives here.
     */
    followUp: {
      /** How many follow-ups have gone out. The sequence ceiling reads this. */
      count: { type: Number, default: 0, min: 0 },
      /** Indexed with `owner`: the eligibility query filters on both. */
      lastSentAt: { type: Date, default: null },
      /** What was actually said, so the timeline can show it. */
      lastSubject: { type: String, default: null, maxlength: 998 },
      /** Who pressed send. A follow-up is always a human act. */
      lastSentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },

    /** The upload that first created this lead. */
    firstImportJob: { type: Schema.Types.ObjectId, ref: 'ImportJob', default: null },
    /** The most recent upload that contained this reference. */
    lastSeenAt: { type: Date, default: null },
    /** How many uploads have carried this reference. */
    seenCount: { type: Number, default: 1, min: 0 },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, versionKey: false },
)

/** The idempotency guarantee for re-importing the workbook. */
leadSchema.index(
  { owner: 1, reference: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
)

/** Default list: newest enquiries first. */
leadSchema.index({ owner: 1, isDeleted: 1, quoteDate: -1 })

/** Pipeline board, and the campaign audience query. */
leadSchema.index({ owner: 1, stage: 1, isDeleted: 1 })

/** "Who is travelling next month" — the follow-up worklist. */
leadSchema.index({ owner: 1, travelDate: 1, stage: 1 })

/** Company and contact drill-downs. */
leadSchema.index({ owner: 1, company: 1, quoteDate: -1 })
leadSchema.index({ owner: 1, contact: 1, quoteDate: -1 })

/** The auto-mail queue: leads that still owe an introductory email. */
leadSchema.index({ owner: 1, 'autoMail.status': 1, isDeleted: 1 })

/*
 * The follow-up queue.
 *
 * Its query is "this owner's leads, introduced, unanswered, never chased", and
 * without this it is a collection scan filtered in memory on every page load of
 * a register that runs to thousands of rows.
 */
leadSchema.index({ owner: 1, 'autoMail.status': 1, replyReceived: 1, 'followUp.count': 1, isDeleted: 1 })

/** Global search across the register. */
leadSchema.index(
  { reference: 'text', contactPerson: 'text', companyName: 'text', email: 'text', city: 'text' },
  {
    name: 'lead_search',
    weights: { reference: 12, contactPerson: 8, companyName: 6, email: 6, city: 2 },
  },
)

/** Whether a campaign may include this lead. */
leadSchema.methods.isCampaignEligible = function isCampaignEligible() {
  if (this.doNotContact) return false
  if (!this.email) return false
  return CAMPAIGN_ELIGIBLE_STAGES.includes(this.stage)
}

leadSchema.methods.isWon = function isWon() {
  return WON_STAGES.includes(this.stage)
}

leadSchema.methods.isClosed = function isClosed() {
  return TERMINAL_STAGES.includes(this.stage)
}

/**
 * Moves the lead to a new stage, recording the transition.
 *
 * History is appended rather than the stage merely overwritten, because
 * "average time from quote to booking" is a question the business will ask and
 * it is unanswerable from a single current value.
 */
leadSchema.methods.moveToStage = function moveToStage(stage, { by = null, reason = null } = {}) {
  if (!LEAD_STAGE_VALUES.includes(stage)) {
    throw new Error(`"${stage}" is not a pipeline stage.`)
  }

  if (this.stage === stage) return this

  this.stageHistory.push({ from: this.stage, to: stage, at: new Date(), by, reason })
  this.stage = stage

  return this
}

/** Days spent in the pipeline, or until it closed. */
leadSchema.methods.ageInDays = function ageInDays() {
  const start = this.quoteDate ?? this.createdAt
  if (!start) return null

  const end = this.isClosed()
    ? (this.stageHistory.at(-1)?.at ?? new Date())
    : new Date()

  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000))
}

leadSchema.methods.toSummaryJSON = function toSummaryJSON() {
  return {
    id: this._id.toString(),
    reference: this.reference,
    market: this.market,
    contactPerson: this.contactPerson,
    companyName: this.companyName,
    company: this.company?.toString() ?? null,
    contact: this.contact?.toString() ?? null,
    email: this.email,
    phones: this.phones,
    city: this.city,
    quoteDate: this.quoteDate,
    travelDate: this.travelDate,
    travelDateText: this.travelDateText,
    paxText: this.paxText,
    adultCount: this.adultCount,
    childCount: this.childCount,
    stage: this.stage,
    stageLabel: LEAD_STAGE_LABELS[this.stage] ?? this.stage,
    handledBy: this.handledBy,
    /** Where the enquiry came from. Shown as "From". */
    source: this.source,
    /*
     * The workbook's `Remark` column, on the list shape as well as the detail.
     *
     * Internal-only, and this changes no trust boundary: every consumer of this
     * DTO is authenticated and owner-scoped, and already receives the same field
     * from `toPublicJSON` when the enquiry is opened. Listings truncate it.
     */
    internalNotes: this.internalNotes,
    campaignEligible: this.isCampaignEligible(),
    doNotContact: this.doNotContact,
    ageInDays: this.ageInDays(),
    lastContactedAt: this.lastContactedAt,
    repliedAt: this.repliedAt,
    autoMailStatus: this.autoMail?.status ?? 'pending',
    autoMailSentAt: this.autoMail?.sentAt ?? null,

    /**
     * Reply state, on the summary rather than only the detail.
     *
     * The list view is where "has this customer answered?" is actually asked,
     * so the answer travels with every row. Four small fields on a shape the
     * client already fetches, versus a second request per row.
     */
    replyReceived: this.replyReceived ?? false,
    replyCount: this.replyCount ?? 0,
    lastReplyAt: this.lastReplyAt ?? null,
    lastActivityAt: this.lastActivityAt ?? null,

    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

leadSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    ...this.toSummaryJSON(),
    internalNotes: this.internalNotes,
    stageHistory: this.stageHistory,
    campaigns: this.campaigns.map((id) => id.toString()),
    lastCampaignAt: this.lastCampaignAt,
    importJob: this.importJob?.toString() ?? null,
    sourceSheet: this.sourceSheet,
    sourceRow: this.sourceRow,
    autoMail: this.autoMail
      ? {
          status: this.autoMail.status,
          sentAt: this.autoMail.sentAt,
          subject: this.autoMail.subject,
          messageId: this.autoMail.messageId,
          conversationId: this.autoMail.conversationId,
          mail: this.autoMail.mail?.toString() ?? null,
          error: this.autoMail.error,
          attempts: this.autoMail.attempts,
          forcedAt: this.autoMail.forcedAt,
        }
      : null,
    fieldHistory: this.fieldHistory,
    firstImportJob: this.firstImportJob?.toString() ?? null,
    lastSeenAt: this.lastSeenAt,
    seenCount: this.seenCount,

    /** Where the enquiry's correspondence lives, for the detail screen. */
    conversation: this.conversation?.toString() ?? null,
    lastInboundMail: this.lastInboundMail?.toString() ?? null,
  }
}

/*
 * The two cross-owner reads, which every index above misses.
 *
 * Every other compound index here is prefixed with `owner`, because the CRM is
 * an owner-scoped register and that is the right shape for it. The admin
 * console asks a different question — "every enquiry in the deployment" — so
 * its queries carry no `owner` and cannot use any of them.
 *
 * `{ isDeleted, createdAt }` serves the admin lead monitor, which filters on
 * `isDeleted` and sorts `createdAt` descending. Without it that query is a
 * collection scan followed by an in-memory sort, run once for the page and
 * again for each of its counts. The single-field `isDeleted` index the field
 * declaration creates does not help the sort.
 *
 * `{ reference }` serves the administrator's global reference lookup. The
 * existing `{ owner, reference }` unique index cannot answer it — `reference`
 * is not a prefix — and the text index answers a different kind of query than
 * an anchored prefix match.
 *
 * Both are additive. No existing index is altered, and no query changes: these
 * only give the planner something better to choose.
 */
leadSchema.index({ isDeleted: 1, createdAt: -1 })
leadSchema.index({ reference: 1 })

export const Lead = mongoose.model('Lead', leadSchema)

export default Lead
