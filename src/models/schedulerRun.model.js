/**
 * One scheduler attempt, appended.
 *
 * ## What this is for
 *
 * Two things, and they are worth separating because only one of them is
 * cosmetic.
 *
 *   1. **The log an operator reads.** "Why did nobody get an email on Tuesday?"
 *      has an answer here, in a sentence, whether the answer is "no workbook
 *      was exported", "the file had no lead sheet" or "it was the same file as
 *      Monday".
 *
 *   2. **The workbook ledger.** `workbook.hash` with `status: queued` is the
 *      record that a specific set of bytes has already been handed to the
 *      queue. This is what "never process the same workbook twice" is enforced
 *      by — not a filename, not an mtime, not a day key, because all three
 *      change when nothing meaningful has.
 *
 * ## Why not reuse ImportJob
 *
 * An `ImportJob` records a run that happened. Most scheduler attempts produce
 * no run at all: they find nothing, or find something already dealt with. There
 * is no honest `ImportJob` for "checked, nothing to do", and inventing one would
 * put empty rows in the history list the workbook screen shows, and skew every
 * counter that reads it.
 */

import mongoose from 'mongoose'

import {
  SCHEDULER_RUN_STATUS,
  SCHEDULER_RUN_STATUS_LABELS,
  SCHEDULER_RUN_STATUS_VALUES,
  SCHEDULER_TRIGGER_VALUES,
} from '../modules/scheduler/constants/schedulerConstants.js'

const { Schema } = mongoose

const schedulerRunSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** The local calendar day this attempt was for, `YYYY-MM-DD`. */
    dayKey: { type: String, required: true },

    trigger: { type: String, enum: SCHEDULER_TRIGGER_VALUES, required: true },

    status: {
      type: String,
      enum: SCHEDULER_RUN_STATUS_VALUES,
      default: SCHEDULER_RUN_STATUS.RUNNING,
    },

    /** 1 for the first try of the day. */
    attempt: { type: Number, default: 1, min: 1 },

    /** A `SCHEDULER_SKIP_REASON`, or null when a job was created. */
    reason: { type: String, default: null },

    /** Always populated: the sentence that goes in the log and on the card. */
    message: { type: String, required: true, trim: true, maxlength: 512 },

    workbook: {
      filename: { type: String, default: null, trim: true },
      /**
       * SHA-256 of the file's bytes.
       *
       * Content, not identity. The same export saved twice under two names is
       * one workbook; a re-export with one new enquiry is a different one, and
       * should be processed — the compare engine will then find exactly that
       * one row new.
       */
      hash: { type: String, default: null, index: true },
      size: { type: Number, default: 0, min: 0 },
      modifiedAt: { type: Date, default: null },
      /** The worksheet the classifier recommended. */
      sheet: { type: String, default: null, trim: true },
      /** How many candidates were in the inbox when this one was chosen. */
      candidates: { type: Number, default: 0, min: 0 },
    },

    /** The queued background job. Null for every skipped and failed attempt. */
    importJob: { type: Schema.Types.ObjectId, ref: 'ImportJob', default: null },

    /** Set when an administrator pressed Run now, rather than the clock. */
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false },
)

/** The history list: this workspace's attempts, newest first. */
schedulerRunSchema.index({ owner: 1, createdAt: -1 })

/**
 * The duplicate check, and the reason it is fast.
 *
 * Asked once per attempt: "has this workspace already queued these exact
 * bytes?". Compound and selective, so the answer is an index hit regardless of
 * how many mornings have accumulated.
 */
schedulerRunSchema.index({ owner: 1, 'workbook.hash': 1, status: 1 })

/** "What happened today?", for the missed-run and dashboard queries. */
schedulerRunSchema.index({ owner: 1, dayKey: 1 })

schedulerRunSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    dayKey: this.dayKey,
    trigger: this.trigger,
    status: this.status,
    statusLabel: SCHEDULER_RUN_STATUS_LABELS[this.status] ?? this.status,
    attempt: this.attempt,
    reason: this.reason,
    message: this.message,
    workbook: this.workbook?.filename
      ? {
          filename: this.workbook.filename,
          size: this.workbook.size ?? 0,
          modifiedAt: this.workbook.modifiedAt ?? null,
          sheet: this.workbook.sheet ?? null,
        }
      : null,
    importJob: this.importJob?.toString() ?? null,
    manual: Boolean(this.actor),
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    durationMs: this.durationMs,
  }
}

export const SchedulerRun = mongoose.model('SchedulerRun', schedulerRunSchema)

export default SchedulerRun
