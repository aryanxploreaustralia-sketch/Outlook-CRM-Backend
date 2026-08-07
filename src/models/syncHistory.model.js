/**
 * Audit record of one synchronisation run.
 *
 * Written for every run, successful or not. Failures are the reason it exists:
 * a run that errored leaves no other trace, and "sync isn't working" is not a
 * report anyone can act on without knowing which folder, which error and when.
 *
 * Records are swept after 30 days by a TTL index. Sync history is operational
 * telemetry, not business data — keeping it forever would grow the collection
 * without bound for information nobody reads after the incident is closed.
 */

import mongoose from 'mongoose'

import {
  SYNC_MODE,
  SYNC_MODE_VALUES,
  SYNC_STATUS,
  SYNC_STATUS_LABELS,
  SYNC_STATUS_VALUES,
  SYNC_TRIGGER,
  SYNC_TRIGGER_VALUES,
} from '../modules/provider/constants/syncStatus.js'
import { FOLDER_VALUES } from '../modules/provider/constants/folderTypes.js'

const { Schema } = mongoose

/** Per-folder outcome within a run. */
const folderResultSchema = new Schema(
  {
    folder: { type: String, enum: FOLDER_VALUES, required: true },
    status: { type: String, enum: SYNC_STATUS_VALUES, required: true },
    mode: { type: String, enum: SYNC_MODE_VALUES, default: SYNC_MODE.INCREMENTAL },

    messagesCreated: { type: Number, default: 0, min: 0 },
    messagesUpdated: { type: Number, default: 0, min: 0 },
    messagesDeleted: { type: Number, default: 0, min: 0 },
    /** Skipped as already present — the duplicate-detection counter. */
    messagesSkipped: { type: Number, default: 0, min: 0 },
    conflictsResolved: { type: Number, default: 0, min: 0 },

    durationMs: { type: Number, default: 0, min: 0 },
    error: {
      code: { type: String, default: null },
      message: { type: String, default: null },
    },
  },
  { _id: false },
)

const syncHistorySchema = new Schema(
  {
    mailbox: {
      type: Schema.Types.ObjectId,
      ref: 'Mailbox',
      required: true,
      index: true,
    },

    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    provider: { type: String, required: true, trim: true },

    trigger: {
      type: String,
      enum: SYNC_TRIGGER_VALUES,
      default: SYNC_TRIGGER.MANUAL,
    },

    mode: {
      type: String,
      enum: SYNC_MODE_VALUES,
      default: SYNC_MODE.INCREMENTAL,
    },

    status: {
      type: String,
      enum: SYNC_STATUS_VALUES,
      default: SYNC_STATUS.RUNNING,
      index: true,
    },

    /** Folders requested for this run. */
    folders: { type: [String], default: [] },
    results: { type: [folderResultSchema], default: [] },

    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0, min: 0 },

    /** Run totals, summed from `results` so the list view needs no aggregation. */
    totals: {
      messagesCreated: { type: Number, default: 0, min: 0 },
      messagesUpdated: { type: Number, default: 0, min: 0 },
      messagesDeleted: { type: Number, default: 0, min: 0 },
      messagesSkipped: { type: Number, default: 0, min: 0 },
      conflictsResolved: { type: Number, default: 0, min: 0 },
      foldersSucceeded: { type: Number, default: 0, min: 0 },
      foldersFailed: { type: Number, default: 0, min: 0 },
    },

    /**
     * Failures encountered during the run.
     *
     * Named `runErrors` rather than `errors` deliberately: `errors` is a
     * reserved path on a Mongoose Document — it is where validation state
     * lives — and using it risks the two colliding in ways that surface as
     * corrupted validation rather than as an obvious bug. The public API still
     * exposes this as `errors`; only the storage name differs.
     */
    runErrors: {
      type: [
        {
          code: { type: String, default: null },
          message: { type: String, default: null },
          folder: { type: String, default: null },
          retryable: { type: Boolean, default: false },
          _id: false,
        },
      ],
      default: [],
    },

    /** Correlates this run with provider-side logs. */
    correlationId: { type: String, trim: true, default: null },
  },
  { timestamps: true, versionKey: false },
)

/** Drives the history list: this mailbox's runs, newest first. */
syncHistorySchema.index({ mailbox: 1, startedAt: -1 })

/**
 * Automatic expiry after 30 days.
 *
 * MongoDB's TTL monitor deletes these; no cleanup job is needed and none can be
 * forgotten.
 */
syncHistorySchema.index({ startedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 })

/** Recomputes run totals and overall status from the per-folder results. */
syncHistorySchema.methods.summarise = function summarise() {
  const totals = {
    messagesCreated: 0,
    messagesUpdated: 0,
    messagesDeleted: 0,
    messagesSkipped: 0,
    conflictsResolved: 0,
    foldersSucceeded: 0,
    foldersFailed: 0,
  }

  for (const result of this.results) {
    totals.messagesCreated += result.messagesCreated
    totals.messagesUpdated += result.messagesUpdated
    totals.messagesDeleted += result.messagesDeleted
    totals.messagesSkipped += result.messagesSkipped
    totals.conflictsResolved += result.conflictsResolved

    if (result.status === SYNC_STATUS.SUCCESS) totals.foldersSucceeded += 1
    else if (result.status === SYNC_STATUS.FAILED) totals.foldersFailed += 1
  }

  this.totals = totals

  // A run where some folders worked is PARTIAL, not FAILED — the data that did
  // arrive is usable, and calling the whole run a failure would imply otherwise.
  if (totals.foldersFailed === 0) this.status = SYNC_STATUS.SUCCESS
  else if (totals.foldersSucceeded > 0) this.status = SYNC_STATUS.PARTIAL
  else this.status = SYNC_STATUS.FAILED

  return this
}

syncHistorySchema.methods.toPublicJSON = function toPublicJSON() {
  /**
   * Which mailbox produced this run.
   *
   * The field has been on the document since Phase 5 but was never projected,
   * so a history list could not say which mailbox a row belonged to. Harmless
   * while a workspace had one; with several it is the difference between a
   * readable log and three mailboxes' runs interleaved into what looks like one
   * mailbox behaving erratically.
   *
   * The address is included only when the caller populated it — the per-mailbox
   * view already knows it and does not need the join.
   */
  const mailboxId = this.mailbox?._id ?? this.mailbox ?? null

  return {
    id: this._id.toString(),
    mailbox: mailboxId ? mailboxId.toString() : null,
    mailboxAddress: this.mailbox?.emailAddress ?? null,
    provider: this.provider,
    trigger: this.trigger,
    mode: this.mode,
    status: this.status,
    statusLabel: SYNC_STATUS_LABELS[this.status] ?? this.status,
    folders: this.folders,
    results: this.results.map((result) => ({
      folder: result.folder,
      status: result.status,
      mode: result.mode,
      messagesCreated: result.messagesCreated,
      messagesUpdated: result.messagesUpdated,
      messagesDeleted: result.messagesDeleted,
      messagesSkipped: result.messagesSkipped,
      conflictsResolved: result.conflictsResolved,
      durationMs: result.durationMs,
      error: result.error?.code ? result.error : null,
    })),
    totals: this.totals,
    /** Exposed under the contract name, whatever it is stored as. */
    errors: this.runErrors,
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    durationMs: this.durationMs,
    correlationId: this.correlationId,
  }
}

export const SyncHistory = mongoose.model('SyncHistory', syncHistorySchema)

export default SyncHistory
