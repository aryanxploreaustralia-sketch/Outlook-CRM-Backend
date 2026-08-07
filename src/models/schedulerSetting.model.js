/**
 * The morning scheduler's configuration and its current state, per workspace.
 *
 * ## Why configuration and state share a document
 *
 * `lastRun.dayKey` is not a status field. It is the *lock*: the scheduler claims
 * a day by conditionally writing it, and a claim that has to span two documents
 * is not a claim at all. Putting the state beside the settings makes the whole
 * decision — enabled, due, not yet claimed — one atomic `findOneAndUpdate`.
 *
 * The run *history* lives elsewhere, in `SchedulerRun`, because that genuinely
 * is a separate concern: one document per attempt, appended, never contended.
 *
 * ## What this document does not hold
 *
 * The inbox directory. That is deployment configuration, read from the
 * environment, and it stays there on purpose: a path arriving through a JSON
 * body is a path an attacker can choose, and "read any file the process can
 * reach, then email its contents to whoever it parses as" is a poor thing to
 * expose behind a settings form.
 */

import mongoose from 'mongoose'

import {
  REPLY_SYNC_DEFAULTS,
  REPLY_SYNC_STATUS,
  REPLY_SYNC_STATUS_LABELS,
  REPLY_SYNC_STATUS_VALUES,
  RUN_TIME_PATTERN,
  SCHEDULER_DEFAULTS,
  SCHEDULER_RUN_STATUS,
  SCHEDULER_RUN_STATUS_LABELS,
  SCHEDULER_RUN_STATUS_VALUES,
  SCHEDULER_TRIGGER,
  SCHEDULER_TRIGGER_VALUES,
} from '../modules/scheduler/constants/schedulerConstants.js'
import {
  isValidTimeZone,
  nextOccurrenceAfter,
  parseRunTime,
} from '../modules/scheduler/services/schedulerClock.js'

const { Schema } = mongoose

/**
 * What the last attempt found, so the dashboard can name the file.
 *
 * The absolute path is deliberately absent — it is written to the log, where
 * operators need it, and not to an API response, where it only discloses the
 * server's layout.
 */
const lastWorkbookSchema = new Schema(
  {
    filename: { type: String, default: null, trim: true },
    /** SHA-256 of the bytes. The "never twice" key. */
    hash: { type: String, default: null },
    size: { type: Number, default: 0, min: 0 },
    /** The file's own mtime, which is when the team exported it. */
    modifiedAt: { type: Date, default: null },
    sheet: { type: String, default: null, trim: true },
  },
  { _id: false },
)

const schedulerSettingSchema = new Schema(
  {
    /**
     * One document per workspace.
     *
     * Unique rather than merely indexed: two settings documents for one owner
     * would be two schedulers claiming different day keys, which is precisely
     * the duplicate this phase must not produce.
     */
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    /**
     * The one workspace that owns the morning run for this deployment.
     *
     * ## Why this exists
     *
     * `role` defaults to `owner` for every account that signs in, so a three-
     * person office produces three owner workspaces. Each was seeded its own
     * scheduler, each claimed its own day key on its *own* document, and the
     * workbook-hash guard is owner-scoped — so one file in the shared inbox
     * became three import jobs and up to three introductions to every customer.
     *
     * The business has one office, one workbook and one automation. This flag
     * is what makes that true however many people sign in.
     *
     * ## Why a flag rather than a second collection
     *
     * The scheduler already reads exactly one document per workspace to decide
     * whether to run; adding a condition to that read is the entire change. A
     * separate "deployment settings" collection would be a second source of
     * truth about the same decision.
     *
     * Only the **morning run** is gated by this. `replySync` on this document
     * stays per-workspace, because each user reads their own mailbox and that
     * is correct.
     */
    isPrimary: { type: Boolean, default: false },

    // --- Configuration -----------------------------------------------------

    /** The tick's query is `{ enabled: true }`, which this index serves. */
    enabled: { type: Boolean, default: SCHEDULER_DEFAULTS.ENABLED, index: true },

    /** `HH:mm`, 24-hour, interpreted in `timezone`. */
    runTime: {
      type: String,
      default: SCHEDULER_DEFAULTS.RUN_TIME,
      trim: true,
      validate: {
        validator: (value) => RUN_TIME_PATTERN.test(value),
        message: 'The run time must be a 24-hour time such as 09:00.',
      },
    },

    /**
     * IANA zone name. Validated against the runtime's own database, so a typo
     * is refused when it is typed rather than discovered at 09:00 tomorrow.
     */
    timezone: {
      type: String,
      default: SCHEDULER_DEFAULTS.TIMEZONE,
      trim: true,
      validate: {
        validator: isValidTimeZone,
        message: 'That is not a timezone this server recognises, e.g. Asia/Kolkata.',
      },
    },

    retry: {
      /** Attempts *after* the first. 0 disables retrying. */
      maxRetries: { type: Number, default: SCHEDULER_DEFAULTS.MAX_RETRIES, min: 0, max: 10 },
      delayMs: {
        type: Number,
        default: SCHEDULER_DEFAULTS.RETRY_DELAY_MS,
        min: 10_000,
        max: 6 * 60 * 60 * 1000,
      },
    },

    /**
     * Whether the queued run is allowed to send introductions.
     *
     * Passed straight through to the existing run options, so it is the same
     * switch a manual upload has always had. It exists here so a workspace can
     * turn the automation on and watch it create leads for a morning before it
     * is trusted to write to customers.
     */
    sendMail: { type: Boolean, default: true },

    // --- Reply sync (Phase H4) ---------------------------------------------
    //
    // Housed in this document rather than a new one, because it is the same
    // decision about the same workspace — "what does this CRM do on its own?" —
    // and because the H3 claim pattern that makes the morning run safe against
    // restarts and multiple instances applies unchanged to an interval job.
    //
    // The morning run and the reply sync are otherwise independent: different
    // cadence, different lock, and either can be off while the other is on.

    replySync: {
      enabled: { type: Boolean, default: true },

      /**
       * How often the inbox is read, in minutes.
       *
       * Five by default, per the brief. The floor is one — Graph's own
       * throttling makes anything faster counterproductive, and the sync is
       * incremental so a longer interval costs nothing but latency.
       */
      intervalMinutes: { type: Number, default: 5, min: 1, max: 24 * 60 },

      /**
       * Whether to pull attachment bytes as part of a run.
       *
       * The metadata is always recorded; this only governs the download. Off is
       * for a workspace whose replies routinely carry large itineraries and
       * which would rather fetch them on demand.
       */
      downloadAttachments: { type: Boolean, default: true },

      // --- State, written only by the worker -------------------------------

      status: {
        type: String,
        enum: REPLY_SYNC_STATUS_VALUES,
        default: REPLY_SYNC_STATUS.IDLE,
      },

      /** Claimed at the start of a run; the staleness escape reads it. */
      startedAt: { type: Date, default: null },
      finishedAt: { type: Date, default: null },

      /** When the interval next comes due. The whole of the scheduling logic. */
      nextRunAt: { type: Date, default: null },

      message: { type: String, default: null },

      /** Counters from the last run, for the settings screen. */
      lastResult: {
        total: { type: Number, default: 0, min: 0 },
        created: { type: Number, default: 0, min: 0 },
        duplicates: { type: Number, default: 0, min: 0 },
        matched: { type: Number, default: 0, min: 0 },
        unmatched: { type: Number, default: 0, min: 0 },
        failed: { type: Number, default: 0, min: 0 },
      },

      /** Consecutive failures. Reset by any successful run. */
      consecutiveFailures: { type: Number, default: 0, min: 0 },
    },

    // --- State -------------------------------------------------------------
    //
    // Written only by the scheduler service, through conditional updates.

    lastRun: {
      /**
       * The local calendar day this workspace has already run for.
       *
       * The whole of the duplicate-prevention story for *scheduling*. Set once
       * per day by whichever process wins the claim; every other process, tick
       * and restart sees it and does nothing.
       */
      dayKey: { type: String, default: null },

      status: {
        type: String,
        enum: SCHEDULER_RUN_STATUS_VALUES,
        default: SCHEDULER_RUN_STATUS.IDLE,
      },

      trigger: { type: String, enum: SCHEDULER_TRIGGER_VALUES, default: SCHEDULER_TRIGGER.SCHEDULE },

      /** 1 for the first try. Compared against `retry.maxRetries + 1`. */
      attempts: { type: Number, default: 0, min: 0 },

      startedAt: { type: Date, default: null },
      finishedAt: { type: Date, default: null },

      /** A `SCHEDULER_SKIP_REASON` when nothing was queued. */
      reason: { type: String, default: null },
      /** The same thing in a sentence, shown on the dashboard. */
      message: { type: String, default: null },

      /** The background job this run created, when it created one. */
      importJob: { type: Schema.Types.ObjectId, ref: 'ImportJob', default: null },
      /** The history entry, for a link through to the detail. */
      schedulerRun: { type: Schema.Types.ObjectId, ref: 'SchedulerRun', default: null },

      workbook: { type: lastWorkbookSchema, default: () => ({}) },

      /** When a failed attempt becomes eligible again. */
      nextAttemptAt: { type: Date, default: null },
    },

    /** Who last changed the configuration. Never set by the scheduler itself. */
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

/**
 * At most one primary workspace, enforced by the database.
 *
 * Partial, so the many `isPrimary: false` documents do not collide with one
 * another — only the `true` ones are indexed, and the unique constraint then
 * permits exactly one of them.
 *
 * This is deliberately a constraint rather than a convention. The application
 * also filters on the flag, but a filter is a rule the next caller can forget;
 * this is a rule the database will not let anyone break, which is the guarantee
 * "one workbook, one email" actually needs.
 */
schedulerSettingSchema.index(
  { isPrimary: 1 },
  { unique: true, partialFilterExpression: { isPrimary: true } },
)

/** Minutes since local midnight, or null when `runTime` is somehow malformed. */
schedulerSettingSchema.methods.runTimeMinutes = function runTimeMinutes() {
  return parseRunTime(this.runTime)
}

/**
 * The next moment this schedule fires.
 *
 * Computed rather than stored. A stored value would have to be rewritten on
 * every configuration change, every run and every restart, and would be wrong
 * in the window between any of them.
 */
schedulerSettingSchema.methods.nextRunAt = function nextRunAt(from = new Date()) {
  if (!this.enabled) return null

  const minutes = this.runTimeMinutes()
  if (minutes === null) return null

  return nextOccurrenceAfter(from, minutes, this.timezone)
}

/** The settings screen and the dashboard card read exactly this. */
schedulerSettingSchema.methods.toPublicJSON = function toPublicJSON() {
  const last = this.lastRun ?? {}
  const status = last.status ?? SCHEDULER_RUN_STATUS.IDLE

  return {
    /**
     * Whether this workspace owns the morning run.
     *
     * The settings screen reads it to explain why the controls are inert on a
     * workspace that does not — "this is not the scheduling workspace" is a far
     * better answer than a button that returns 403.
     */
    isPrimary: this.isPrimary ?? false,

    enabled: this.enabled,
    runTime: this.runTime,
    timezone: this.timezone,
    sendMail: this.sendMail,
    retry: { maxRetries: this.retry?.maxRetries ?? 0, delayMs: this.retry?.delayMs ?? 0 },

    nextRunAt: this.nextRunAt(),

    lastRun: {
      at: last.startedAt ?? null,
      finishedAt: last.finishedAt ?? null,
      dayKey: last.dayKey ?? null,
      status,
      statusLabel: SCHEDULER_RUN_STATUS_LABELS[status] ?? status,
      trigger: last.trigger ?? null,
      attempts: last.attempts ?? 0,
      reason: last.reason ?? null,
      message: last.message ?? null,
      importJob: last.importJob?.toString() ?? null,
      schedulerRun: last.schedulerRun?.toString() ?? null,
      workbook: last.workbook?.filename
        ? {
            filename: last.workbook.filename,
            size: last.workbook.size ?? 0,
            modifiedAt: last.workbook.modifiedAt ?? null,
            sheet: last.workbook.sheet ?? null,
          }
        : null,
      nextAttemptAt: last.nextAttemptAt ?? null,
    },

    replySync: this.replySyncJSON(),

    updatedAt: this.updatedAt,
  }
}

/**
 * The reply-sync half of the settings screen.
 *
 * Its own method so the notification bell and the dashboard can read just this
 * without carrying the morning run's state around with it.
 */
schedulerSettingSchema.methods.replySyncJSON = function replySyncJSON() {
  const sync = this.replySync ?? {}
  const status = sync.status ?? REPLY_SYNC_STATUS.IDLE

  return {
    enabled: sync.enabled ?? false,
    intervalMinutes: sync.intervalMinutes ?? REPLY_SYNC_DEFAULTS.INTERVAL_MINUTES,
    downloadAttachments: sync.downloadAttachments ?? true,

    status,
    statusLabel: REPLY_SYNC_STATUS_LABELS[status] ?? status,
    message: sync.message ?? null,

    lastRunAt: sync.finishedAt ?? null,
    /** Null while disabled — there is no next run to name. */
    nextRunAt: sync.enabled ? (sync.nextRunAt ?? null) : null,

    lastResult: {
      total: sync.lastResult?.total ?? 0,
      created: sync.lastResult?.created ?? 0,
      duplicates: sync.lastResult?.duplicates ?? 0,
      matched: sync.lastResult?.matched ?? 0,
      unmatched: sync.lastResult?.unmatched ?? 0,
      failed: sync.lastResult?.failed ?? 0,
    },

    consecutiveFailures: sync.consecutiveFailures ?? 0,
  }
}

export const SchedulerSetting = mongoose.model('SchedulerSetting', schedulerSettingSchema)

export default SchedulerSetting
