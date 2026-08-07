/**
 * One spreadsheet import, from upload to completion.
 *
 * Doubles as the job record and the history entry — they describe the same
 * thing at different times, and splitting them would mean copying every counter
 * from one collection to another at the exact moment a run is most likely to
 * fail.
 *
 * ## Why the parsed rows are stored
 *
 * The wizard spans six steps and several minutes of human decision-making. Re-
 * parsing a 25 MB workbook at each step would be wasteful and, worse, would
 * make the preview a user approved potentially different from the data that
 * eventually imports. The rows are parsed once, stored, and every later step
 * reads that snapshot.
 *
 * They are `select: false`, because a history list of fifty jobs must not carry
 * fifty thousand rows, and they are cleared once a job completes.
 *
 * ## Resume and rollback
 *
 * `cursor` records how many rows have been processed. A run that dies mid-import
 * resumes from there rather than re-importing what already landed.
 * `createdContactIds` records exactly what was inserted, so a rollback removes
 * precisely those records and nothing a user added in the meantime.
 */

import mongoose from 'mongoose'

import {
  IMPORT_STATUS,
  IMPORT_STATUS_LABELS,
  IMPORT_STATUS_VALUES,
  IMPORT_STEP,
  IMPORT_STEP_ORDER,
  ROW_STATUS_VALUES,
  SPREADSHEET_FORMAT,
} from '../modules/import/constants/importConstants.js'

const { Schema } = mongoose

/** One column's mapping decision, and how it was arrived at. */
const columnMappingSchema = new Schema(
  {
    column: { type: String, required: true },
    index: { type: Number, default: 0 },
    field: { type: String, required: true },
    /** 0–1. Below ~0.7 the UI asks the user to confirm. */
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    reason: { type: String, default: null },
    /** True when a human overrode the suggestion. */
    manual: { type: Boolean, default: false },
  },
  { _id: false },
)

/**
 * A row that could not be imported.
 *
 * Capped at a few hundred entries by the service — a 50,000-row file where every
 * row is invalid would otherwise produce a document too large for MongoDB, and
 * the four-hundredth identical error tells the user nothing the first did not.
 */
const rowIssueSchema = new Schema(
  {
    /** 1-based, counting the header, so it matches what the user sees in Excel. */
    row: { type: Number, required: true },
    status: { type: String, enum: ROW_STATUS_VALUES, required: true },
    field: { type: String, default: null },
    message: { type: String, required: true },
    value: { type: String, default: null },
  },
  { _id: false },
)

const importJobSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    // --- Source file -------------------------------------------------------

    filename: { type: String, required: true, trim: true },
    fileSize: { type: Number, default: 0, min: 0 },
    format: {
      type: String,
      enum: Object.values(SPREADSHEET_FORMAT),
      default: SPREADSHEET_FORMAT.CSV,
    },
    /** Set when the extension disagreed with the detected format. */
    extensionMismatch: { type: Boolean, default: false },

    /**
     * SHA-256 of the uploaded bytes.
     *
     * Lets the wizard warn "you imported this exact file two hours ago", which
     * is the single most common way a sales team creates thousands of
     * duplicates.
     */
    fileHash: { type: String, default: null, index: true },

    // --- Wizard state ------------------------------------------------------

    step: {
      type: String,
      enum: IMPORT_STEP_ORDER,
      default: IMPORT_STEP.UPLOAD,
    },

    status: {
      type: String,
      enum: IMPORT_STATUS_VALUES,
      default: IMPORT_STATUS.DRAFT,
      index: true,
    },

    headers: { type: [String], default: [] },
    mapping: { type: [columnMappingSchema], default: [] },

    /** Template this mapping came from, when one was applied. */
    template: { type: Schema.Types.ObjectId, ref: 'ImportTemplate', default: null },

    /**
     * The parsed rows. Cleared on completion — see the note above.
     */
    rows: { type: [Schema.Types.Mixed], default: [], select: false },

    /** First rows of the file exactly as they appear, for the preview screen. */
    sample: { type: [Schema.Types.Mixed], default: [] },

    // --- Analysis ----------------------------------------------------------

    analysis: {
      totalRows: { type: Number, default: 0, min: 0 },
      validRows: { type: Number, default: 0, min: 0 },
      invalidRows: { type: Number, default: 0, min: 0 },
      duplicateInFile: { type: Number, default: 0, min: 0 },
      duplicateExisting: { type: Number, default: 0, min: 0 },
      missingEmail: { type: Number, default: 0, min: 0 },
      emptyRows: { type: Number, default: 0, min: 0 },
      analysedAt: { type: Date, default: null },
    },

    issues: { type: [rowIssueSchema], default: [] },

    /** What to do with rows matching an existing contact. */
    duplicateAction: { type: String, default: 'skip' },

    /** Tags applied to every contact this job creates. */
    defaultTags: { type: [String], default: [] },
    defaultLeadSource: { type: String, default: null },
    defaultLeadStatus: { type: String, default: null },

    // --- Execution ---------------------------------------------------------

    /** Rows processed so far. The resume point. */
    cursor: { type: Number, default: 0, min: 0 },

    progress: {
      imported: { type: Number, default: 0, min: 0 },
      updated: { type: Number, default: 0, min: 0 },
      skipped: { type: Number, default: 0, min: 0 },
      failed: { type: Number, default: 0, min: 0 },
    },

    /**
     * The morning-workbook verdict (Phase 10).
     *
     * Held separately from `progress` rather than folded into it: `progress` is
     * a live counter the wizard polls while a run is in flight, and this is the
     * settled outcome the history list reads afterwards. Overloading one field
     * for both would make a half-finished run indistinguishable from a
     * finished one.
     */
    syncSummary: {
      total: { type: Number, default: 0, min: 0 },
      new: { type: Number, default: 0, min: 0 },
      updated: { type: Number, default: 0, min: 0 },
      unchanged: { type: Number, default: 0, min: 0 },
      invalid: { type: Number, default: 0, min: 0 },
      created: { type: Number, default: 0, min: 0 },
      modified: { type: Number, default: 0, min: 0 },
      emailsSent: { type: Number, default: 0, min: 0 },
      emailsSkipped: { type: Number, default: 0, min: 0 },
      emailsFailed: { type: Number, default: 0, min: 0 },
    },

    /** The worksheet the run read. A workbook has several. */
    sheetName: { type: String, trim: true, default: null },

    /**
     * Contacts this job created, for rollback.
     *
     * `select: false` — a 10,000-row import stores 10,000 ids, which the history
     * list has no use for.
     */
    createdContactIds: { type: [Schema.Types.ObjectId], default: [], select: false },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0, min: 0 },

    lastError: {
      message: { type: String, default: null },
      occurredAt: { type: Date, default: null },
    },

    rolledBackAt: { type: Date, default: null },
    rolledBackCount: { type: Number, default: 0, min: 0 },

    /** Guards against two workers running the same job. Expires like a sync lock. */
    lockedAt: { type: Date, default: null },

    // --- Phase H2: background execution ------------------------------------
    //
    // Additive and self-contained. `background.isBackground` is false for every
    // job written before this phase and for every synchronous run, so nothing
    // existing changes meaning and the wizard's own `step`/`progress`/
    // `syncSummary` fields keep exactly the semantics they had.
    //
    // Deliberately a separate subdocument rather than new values on `step`:
    // `step` is the six-stage import wizard's vocabulary, shared with the
    // contacts importer, and widening it for a different concern is how two
    // unrelated features end up coupled.

    background: {
      /** True when a worker owns this job rather than an HTTP request. */
      isBackground: { type: Boolean, default: false, index: true },

      /**
       * Where the run has got to, in the worker's own vocabulary.
       *
       * Finer than `step`, because "importing" covers three phases that take
       * very different amounts of time — and the one a user is waiting through
       * is usually `mailing`, which is paced and therefore the slowest.
       */
      phase: {
        type: String,
        enum: ['queued', 'comparing', 'creating', 'mailing', 'finalising', 'done'],
        default: 'queued',
      },

      processedRows: { type: Number, default: 0, min: 0 },
      totalRows: { type: Number, default: 0, min: 0 },
      emailsSent: { type: Number, default: 0, min: 0 },

      queuedAt: { type: Date, default: null },

      /** How many times a worker has picked this job up. */
      attempts: { type: Number, default: 0, min: 0 },

      /**
       * Set by the cancel endpoint; read by the worker between chunks.
       *
       * A flag rather than an interrupt: the run is mid-chunk when this
       * arrives, and stopping cleanly at a chunk boundary is what keeps the
       * cursor honest. A run cancelled at row 400 has genuinely written 400
       * rows, and says so.
       */
      cancelRequested: { type: Boolean, default: false },

      /**
       * The uploaded bytes, relative to the workbook storage root.
       *
       * Persisted because the worker may not be the process that received the
       * upload — a run interrupted by a restart re-reads the file and resumes
       * from `cursor`. Removed once the job reaches a terminal state.
       */
      storedFile: { type: String, default: null },

      /** The run's options, so a resumed run makes the same decisions. */
      options: { type: Schema.Types.Mixed, default: null },
    },
  },
  { timestamps: true, versionKey: false },
)

/** Drives the history list: this user's jobs, newest first. */
importJobSchema.index({ owner: 1, createdAt: -1 })
importJobSchema.index({ owner: 1, status: 1, createdAt: -1 })

/**
 * The worker's claim query: the oldest queued background job, any owner.
 *
 * Not scoped by owner — a worker serves the whole instance, and a per-owner
 * index would make it scan.
 */
importJobSchema.index({ 'background.isBackground': 1, status: 1, 'background.queuedAt': 1 })

/** A lock older than this belonged to a process that died. */
export const IMPORT_LOCK_TTL_MS = 10 * 60 * 1000

importJobSchema.methods.isLocked = function isLocked() {
  if (!this.lockedAt) return false
  return Date.now() - this.lockedAt.getTime() < IMPORT_LOCK_TTL_MS
}

/** True when there is more work to do. */
importJobSchema.methods.isResumable = function isResumable() {
  return (
    [IMPORT_STATUS.RUNNING, IMPORT_STATUS.PAUSED, IMPORT_STATUS.FAILED].includes(this.status) &&
    this.cursor < this.analysis.totalRows
  )
}

/** Compact shape for the history list — never includes rows or contact ids. */
importJobSchema.methods.toSummaryJSON = function toSummaryJSON() {
  const total = this.analysis?.totalRows ?? 0
  const processed = this.cursor ?? 0

  return {
    id: this._id.toString(),
    filename: this.filename,
    fileSize: this.fileSize,
    format: this.format,
    step: this.step,
    status: this.status,
    statusLabel: IMPORT_STATUS_LABELS[this.status] ?? this.status,
    analysis: this.analysis,
    progress: this.progress,
    syncSummary: this.syncSummary,
    sheetName: this.sheetName,
    /** 0–100, so the bar does not have to compute it. */
    percentComplete: total === 0 ? 0 : Math.min(100, Math.round((processed / total) * 100)),
    isResumable: this.isResumable(),
    rolledBackAt: this.rolledBackAt,
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    durationMs: this.durationMs,
    createdAt: this.createdAt,
    createdBy: this.createdBy?.toString() ?? null,
  }
}

/**
 * Live progress for a background run.
 *
 * Its own shape rather than more fields on `toSummaryJSON`, because this is
 * polled every couple of seconds while a run is in flight and should carry only
 * what a progress bar needs. `percentComplete` is computed from the worker's own
 * row counters rather than `analysis.totalRows`, which a workbook sync never
 * populates.
 */
importJobSchema.methods.toJobStatusJSON = function toJobStatusJSON() {
  const background = this.background ?? {}
  const total = background.totalRows ?? 0
  const processed = background.processedRows ?? 0

  return {
    id: this._id.toString(),
    filename: this.filename,
    sheet: this.sheetName,

    status: this.status,
    statusLabel: IMPORT_STATUS_LABELS[this.status] ?? this.status,
    step: background.phase ?? null,

    percentComplete: total === 0 ? 0 : Math.min(100, Math.round((processed / total) * 100)),
    rowsProcessed: processed,
    rowsTotal: total,
    emailsSent: background.emailsSent ?? 0,

    /** The settled verdict. Zeroes until the run finishes. */
    summary: this.syncSummary,

    /**
     * Capped, and counted separately.
     *
     * A run with 900 invalid rows should say 900 while shipping a readable
     * sample, not 900 objects to a polling client.
     */
    errors: (this.issues ?? []).slice(0, 50),
    errorCount: this.issues?.length ?? 0,
    lastError: this.lastError?.message ? this.lastError : null,

    attempts: background.attempts ?? 0,
    isBackground: Boolean(background.isBackground),
    cancelRequested: Boolean(background.cancelRequested),

    queuedAt: background.queuedAt ?? null,
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    durationMs: this.durationMs,
  }
}

/** Full shape for the wizard: adds headers, mapping, sample and issues. */
importJobSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    ...this.toSummaryJSON(),
    headers: this.headers,
    mapping: this.mapping,
    sample: this.sample,
    // Capped so one pathological file cannot produce a megabyte of JSON.
    issues: this.issues.slice(0, 200),
    issueCount: this.issues.length,
    duplicateAction: this.duplicateAction,
    defaultTags: this.defaultTags,
    defaultLeadSource: this.defaultLeadSource,
    defaultLeadStatus: this.defaultLeadStatus,
    extensionMismatch: this.extensionMismatch,
    template: this.template?.toString() ?? null,
    lastError: this.lastError?.message ? this.lastError : null,
  }
}

export const ImportJob = mongoose.model('ImportJob', importJobSchema)

export default ImportJob
