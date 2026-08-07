/**
 * Vocabulary for the morning scheduler (Phase H3).
 *
 * The scheduler exists to answer one question every morning — "is there a
 * workbook to process, and has it been processed already?" — and to hand the
 * answer to the Phase H2 queue. Everything here names a state in that decision;
 * nothing here names a business rule, because the scheduler has none.
 */

/** What set a run in motion. */
export const SCHEDULER_TRIGGER = Object.freeze({
  /** The clock reached the configured time. */
  SCHEDULE: 'schedule',
  /**
   * The process booted after the configured time with today's run outstanding.
   *
   * Distinguished from `schedule` only so the log can say why a run happened at
   * 09:20 rather than 09:00 — the behaviour is identical.
   */
  STARTUP: 'startup',
  /** An administrator pressed Run now. */
  MANUAL: 'manual',
  /** A previous attempt failed and the retry timer elapsed. */
  RETRY: 'retry',
})

export const SCHEDULER_TRIGGER_VALUES = Object.freeze(Object.values(SCHEDULER_TRIGGER))

/**
 * How a scheduler run ended.
 *
 * `SKIPPED` is deliberately not `FAILED`. "No workbook this morning" and "that
 * workbook was already processed" are the system working correctly; treating
 * them as failures would fill the dashboard with red on every ordinary day the
 * team happens not to export, and would trigger retries that can never succeed.
 */
export const SCHEDULER_RUN_STATUS = Object.freeze({
  /** In flight: discovering, validating, enqueueing. Seconds, not minutes. */
  RUNNING: 'running',
  /** A background job was created. The queue owns it from here. */
  QUEUED: 'queued',
  /** Nothing to do, for a reason worth recording. */
  SKIPPED: 'skipped',
  /** The enqueue itself failed and a retry is pending. */
  RETRYING: 'retrying',
  /** The enqueue failed and the retries are exhausted. */
  FAILED: 'failed',
  /** No run has happened yet for this workspace. */
  IDLE: 'idle',
})

export const SCHEDULER_RUN_STATUS_VALUES = Object.freeze(Object.values(SCHEDULER_RUN_STATUS))

export const SCHEDULER_RUN_STATUS_LABELS = Object.freeze({
  [SCHEDULER_RUN_STATUS.RUNNING]: 'Running',
  [SCHEDULER_RUN_STATUS.QUEUED]: 'Queued',
  [SCHEDULER_RUN_STATUS.SKIPPED]: 'Skipped',
  [SCHEDULER_RUN_STATUS.RETRYING]: 'Retrying',
  [SCHEDULER_RUN_STATUS.FAILED]: 'Failed',
  [SCHEDULER_RUN_STATUS.IDLE]: 'Not run yet',
})

/**
 * Why a run did nothing.
 *
 * A code rather than a sentence, so the dashboard can style it and the log can
 * be searched. The human sentence travels alongside in `message`.
 */
export const SCHEDULER_SKIP_REASON = Object.freeze({
  /** The inbox held no candidate file. */
  NO_WORKBOOK: 'no_workbook',
  /** The configured inbox directory does not exist. */
  NO_INBOX: 'no_inbox',
  /**
   * The newest file is byte-identical to one already queued.
   *
   * This is the guard that makes "never process the same workbook twice" true
   * regardless of how many times the scheduler runs.
   */
  ALREADY_PROCESSED: 'already_processed',
  /** No worksheet in the file looks like a lead register. */
  NO_LEAD_SHEET: 'no_lead_sheet',
  /** The file could not be read as a workbook at all. */
  UNREADABLE: 'unreadable',
  /** The workspace owner no longer exists. */
  NO_OWNER: 'no_owner',
})

/** Defaults required by the phase brief. */
export const SCHEDULER_DEFAULTS = Object.freeze({
  ENABLED: true,
  RUN_TIME: '09:00',
  TIMEZONE: 'Asia/Kolkata',
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 5 * 60 * 1000,
})

/** `HH:mm`, 24-hour. The only time format the settings screen accepts. */
export const RUN_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * How often the scheduler asks whether anything is due.
 *
 * A minute, because the configured time has minute resolution and there is
 * nothing to gain from asking more often. The tick reads one small document per
 * workspace and stops.
 */
export const SCHEDULER_TICK_INTERVAL_MS = 60 * 1000

/**
 * A claim older than this belonged to a process that died.
 *
 * Far shorter than the queue's ten minutes, because the scheduler's own work is
 * measured in seconds — read a directory, hash a file, insert a job. Anything
 * still "running" after five minutes is not running.
 */
export const SCHEDULER_CLAIM_TTL_MS = 5 * 60 * 1000

/**
 * How long a file must have been still before it is considered complete.
 *
 * A workbook arriving over OneDrive, a network share or scp is visible in the
 * directory well before the last byte lands. Reading it mid-copy produces a
 * corrupt parse and a failed job that a human then has to interpret. Fifteen
 * seconds costs nothing and removes the entire class of problem.
 */
export const WORKBOOK_SETTLE_MS = 15 * 1000

// ---------------------------------------------------------------------------
// Reply sync (Phase H4)
// ---------------------------------------------------------------------------

/**
 * How the last reply sync ended.
 *
 * A smaller vocabulary than the morning run's, because the job is smaller.
 * There is no day to claim and no missed run to catch up: an interval job that
 * misses a tick simply runs at the next one, and the mailbox is still there.
 */
export const REPLY_SYNC_STATUS = Object.freeze({
  /** Never run for this workspace. */
  IDLE: 'idle',
  /** In flight. */
  RUNNING: 'running',
  /** Read the inbox successfully, whether or not anything new was there. */
  OK: 'ok',
  /**
   * Nothing to read — no mailbox connected.
   *
   * Not a failure: only a human can connect a mailbox, so counting it against
   * the failure streak would raise an alarm nobody can act on from a timer.
   */
  SKIPPED: 'skipped',
  /** The provider or the ingestion threw. */
  FAILED: 'failed',
})

export const REPLY_SYNC_STATUS_VALUES = Object.freeze(Object.values(REPLY_SYNC_STATUS))

export const REPLY_SYNC_STATUS_LABELS = Object.freeze({
  [REPLY_SYNC_STATUS.IDLE]: 'Not run yet',
  [REPLY_SYNC_STATUS.RUNNING]: 'Running',
  [REPLY_SYNC_STATUS.OK]: 'Up to date',
  [REPLY_SYNC_STATUS.SKIPPED]: 'Skipped',
  [REPLY_SYNC_STATUS.FAILED]: 'Failed',
})

/** Defaults required by the phase brief. */
export const REPLY_SYNC_DEFAULTS = Object.freeze({
  ENABLED: true,
  INTERVAL_MINUTES: 5,
})

/**
 * How often the reply worker asks whether any workspace is due.
 *
 * Thirty seconds, so a five-minute interval is honoured to within half a
 * minute. The tick reads one small document per workspace and, on all but one
 * pass in ten, stops there.
 */
export const REPLY_SYNC_TICK_INTERVAL_MS = 30 * 1000

/**
 * A reply-sync claim older than this belonged to a process that died.
 *
 * Longer than the morning run's five minutes because this job does real network
 * work — a hundred messages plus their attachments through Graph — and killing
 * a slow but healthy run would mean two workers reading one mailbox.
 */
export const REPLY_SYNC_CLAIM_TTL_MS = 15 * 60 * 1000

/**
 * How far the interval backs off after repeated failures.
 *
 * A mailbox whose token has been revoked fails every five minutes for ever,
 * which is a lot of Graph calls and a lot of log noise to say one unchanging
 * thing. The delay doubles per consecutive failure up to this ceiling, and any
 * success resets it.
 */
export const REPLY_SYNC_MAX_BACKOFF_MINUTES = 60

export default {
  SCHEDULER_TRIGGER,
  SCHEDULER_RUN_STATUS,
  SCHEDULER_SKIP_REASON,
  SCHEDULER_DEFAULTS,
  REPLY_SYNC_STATUS,
  REPLY_SYNC_DEFAULTS,
}
