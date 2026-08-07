/**
 * The morning scheduler.
 *
 * ## What it does, in one sentence
 *
 * At the configured local time it looks in the inbox, decides whether there is
 * a workbook nobody has processed yet, and — if there is — calls
 * `enqueueWorkbookSync`. That call is the entire integration surface.
 *
 * ## What it deliberately does not do
 *
 * Parse rows, compare references, create leads, resolve companies, choose a
 * template or send an email. Not one line of that logic appears here or is
 * duplicated anywhere in this module. The Phase H2 queue claims the job it
 * creates, the Phase 10 sync engine runs it, and the outcome is identical to a
 * human uploading the same file — because it *is* the same code path, entered
 * from a different place.
 *
 * The one thing it reads from the file is which worksheet to name, and it does
 * that through the existing classifier (`classifyWorkbook`) rather than any
 * rule of its own. A scheduler that guessed the sheet differently from the
 * upload screen would be a second import engine wearing a disguise.
 *
 * ## The three guarantees, and where each one lives
 *
 *   **No duplicate jobs.** Two mechanisms, independent by design.
 *     - *Per day*: `lastRun.dayKey` is claimed with a single conditional write.
 *       Whichever process wins sets it; every other process, tick and restart
 *       reads it and stops. This is what makes a missed run happen exactly once
 *       however many times the server is restarted.
 *     - *Per workbook*: the SHA-256 of the file's bytes is checked against the
 *       runs that actually produced a job. This is what makes "Run now" pressed
 *       five times produce one job, and what protects the day claim from being
 *       the only thing standing between a customer and five emails.
 *
 *   **No duplicate leads, no duplicate emails.** Not this module's doing, and
 *   that is the point. Even if both guards above failed and the same workbook
 *   were queued twice, the comparison would categorise every row `unchanged`
 *   and `lead.autoMail.status === 'sent'` would refuse a second introduction.
 *   The scheduler adds two guards in front of three that already existed; it
 *   replaces none of them.
 *
 * ## Why the decision is a comparison rather than a timer
 *
 * Nothing here waits for a `setTimeout` to fire at 09:00. The tick asks "has
 * today's configured time passed, and is today's key still unclaimed?" — a
 * question with the same correct answer whether it is asked at 09:00, at 09:20
 * after a restart, or forty times in a row. A timer would have to be recreated
 * on every restart, would drift, and would fire twice if the clock stepped.
 */

import { config } from '../../../config/index.js'
import { ROLES } from '../../../constants/roles.js'
import { ImportJob } from '../../../models/importJob.model.js'
import { SchedulerRun } from '../../../models/schedulerRun.model.js'
import { SchedulerSetting } from '../../../models/schedulerSetting.model.js'
import { User } from '../../../models/user.model.js'
import { createContextLogger } from '../../../utils/logger.js'
import { enqueueWorkbookSync } from '../../../jobs/workbookQueue.service.js'
import { fromXlsx, listSheets } from '../../contacts/utils/xlsx.js'
import { classifyWorkbook } from '../../leads/services/worksheetClassifier.service.js'
import {
  SCHEDULER_CLAIM_TTL_MS,
  SCHEDULER_RUN_STATUS,
  SCHEDULER_SKIP_REASON,
  SCHEDULER_TICK_INTERVAL_MS,
  SCHEDULER_TRIGGER,
} from '../constants/schedulerConstants.js'
import { dayKeyIn, dueDayKey, parseRunTime } from './schedulerClock.js'
import { ensureInbox, findLatestWorkbook } from './workbookDiscovery.service.js'

const log = createContextLogger('scheduler')

let timer = null
let isTicking = false
let isStopping = false

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Reads a workspace's scheduler settings, creating them on first use.
 *
 * Created rather than returned as null so the brief's defaults — enabled,
 * 09:00, Asia/Kolkata — are true from the first moment anyone looks, without a
 * migration and without the settings screen having to invent them.
 */
export async function ensureSettings({ owner }) {
  const existing = await SchedulerSetting.findOne({ owner })
  if (existing) return existing

  try {
    return await SchedulerSetting.create({ owner })
  } catch (error) {
    // Two requests racing on first load. The unique index is what makes that
    // safe; the loser simply reads what the winner wrote.
    if (error?.code === 11_000) return SchedulerSetting.findOne({ owner })
    throw error
  }
}

/**
 * Creates default settings for every workspace that could own a morning run.
 *
 * Owners and administrators only. A member has no workbook of their own and no
 * authority to enable a schedule, so seeding one for them would create a
 * document that nothing ever reads.
 */
export async function seedSchedulerSettings() {
  const users = await User.find({ role: { $in: [ROLES.OWNER, ROLES.ADMIN] } }).select('_id')
  if (users.length === 0) return 0

  const existing = await SchedulerSetting.find({ owner: { $in: users.map((user) => user._id) } })
    .select('owner')
    .lean()

  const known = new Set(existing.map((setting) => String(setting.owner)))
  const missing = users.filter((user) => !known.has(String(user._id)))

  if (missing.length === 0) return 0

  // `ordered: false` so one duplicate — a workspace that created its settings
  // through the API a moment ago — does not abandon the rest of the batch.
  try {
    await SchedulerSetting.insertMany(
      missing.map((user) => ({ owner: user._id })),
      { ordered: false },
    )
  } catch (error) {
    if (error?.code !== 11_000 && !Array.isArray(error?.writeErrors)) throw error
  }

  log.info('Scheduler settings created for workspaces that had none', { count: missing.length })

  return missing.length
}

/**
 * Elects the one workspace that owns the morning run.
 *
 * Run at boot, after seeding. Idempotent: once a primary exists it is left
 * alone, so an office that has chosen its scheduling mailbox keeps it across
 * every restart and every new person who signs in.
 *
 * ## How the choice is made
 *
 * The **oldest** owner or administrator account, which in practice is whoever
 * set the deployment up. Deterministic, needs no configuration, and stable —
 * later sign-ups cannot displace it, which is exactly the property the bug
 * this fixes did not have.
 *
 * ## Why the write is conditional
 *
 * `{ isPrimary: { $ne: true } }` plus the unique partial index means two
 * processes booting together cannot both elect: the second either matches
 * nothing or is rejected by the index. Either way one primary exists.
 */
export async function electPrimaryWorkspace() {
  const current = await SchedulerSetting.findOne({ isPrimary: true }).select('owner')
  if (current) return current

  /**
   * Ordered by the *user's* creation, not the settings document's.
   *
   * Settings are seeded in a batch, so their own timestamps are effectively
   * simultaneous and would not identify anybody. Who signed in first is the
   * meaningful ordering.
   */
  const eldest = await User.find({ role: { $in: [ROLES.OWNER, ROLES.ADMIN] } })
    .sort({ createdAt: 1 })
    .limit(1)
    .select('_id email')

  if (eldest.length === 0) return null

  try {
    const elected = await SchedulerSetting.findOneAndUpdate(
      { owner: eldest[0]._id, isPrimary: { $ne: true } },
      { $set: { isPrimary: true } },
      { returnDocument: 'after' },
    )

    if (elected) {
      log.info('Primary scheduling workspace elected', {
        owner: String(eldest[0]._id),
        email: eldest[0].email ?? null,
        note: 'the morning workbook run belongs to this workspace only',
      })
    }

    return elected
  } catch (error) {
    // The unique index rejected a concurrent election. Somebody else won, which
    // is the outcome we wanted; read theirs.
    if (error?.code === 11_000) return SchedulerSetting.findOne({ isPrimary: true })
    throw error
  }
}

// ---------------------------------------------------------------------------
// Claiming a run
// ---------------------------------------------------------------------------

/**
 * Options every pipeline claim needs.
 *
 * `updatePipeline` is Mongoose 9's explicit opt-in for an aggregation-pipeline
 * update. Without it an array update is rejected outright, on the grounds that
 * an array arriving by accident is far more likely to be a bug than a pipeline.
 *
 * `returnDocument: 'after'` rather than the `new: true` its neighbours use:
 * `new` is deprecated in Mongoose 9 and warns on every call, and this call
 * happens on a timer for as long as the process lives.
 */
const PIPELINE_UPDATE = Object.freeze({ returnDocument: 'after', updatePipeline: true })

/**
 * Fields every claim writes, whatever set it in motion.
 *
 * An aggregation-pipeline update rather than a plain `$set`, for one reason:
 * `attempts` has to restart at 1 on a new day and increment on a retry, and
 * deciding that in application code would mean reading the document, thinking,
 * and writing it back — three steps another process can interleave with.
 */
function claimUpdate({ dayKey, trigger, now }) {
  return [
    {
      $set: {
        'lastRun.dayKey': dayKey,
        'lastRun.status': SCHEDULER_RUN_STATUS.RUNNING,
        'lastRun.startedAt': now,
        'lastRun.finishedAt': null,
        'lastRun.nextAttemptAt': null,
        'lastRun.reason': null,
        'lastRun.message': null,

        /** Same day means this is another go at it; a new day starts at one. */
        'lastRun.attempts': {
          $cond: [
            { $eq: ['$lastRun.dayKey', dayKey] },
            { $add: [{ $ifNull: ['$lastRun.attempts', 0] }, 1] },
            1,
          ],
        },

        'lastRun.trigger': {
          $cond: [{ $eq: ['$lastRun.dayKey', dayKey] }, SCHEDULER_TRIGGER.RETRY, trigger],
        },
      },
    },
  ]
}

/**
 * Takes ownership of today's run, atomically, or returns null.
 *
 * The filter is the whole of the scheduling logic, and it is worth reading as
 * two questions rather than five clauses:
 *
 *   1. *Is anybody already running this?* A live claim wins. A claim older than
 *      the TTL belonged to a process that died and is reclaimable — which is
 *      what stops a crash between "claim" and "enqueue" from costing a day.
 *   2. *Is there anything to do?* Either the day is unclaimed, or a retry has
 *      come due, or a stale claim needs finishing.
 *
 * Anything else — already succeeded today, already skipped today, exhausted its
 * retries today — matches nothing and does nothing. That is Cases 3 and 4 of
 * the brief, in one round trip.
 */
async function claimScheduledRun({ setting, dayKey, trigger, now }) {
  const staleBefore = new Date(now.getTime() - SCHEDULER_CLAIM_TTL_MS)
  const maxRetries = setting.retry?.maxRetries ?? 0

  return SchedulerSetting.findOneAndUpdate(
    {
      _id: setting._id,
      enabled: true,
      // Belt and braces with the tick's own filter: the claim is the single
      // write that authorises a run, so the guarantee is enforced here too.
      isPrimary: true,
      $and: [
        {
          $or: [
            { 'lastRun.status': { $ne: SCHEDULER_RUN_STATUS.RUNNING } },
            { 'lastRun.startedAt': { $lt: staleBefore } },
          ],
        },
        {
          $or: [
            // A day nobody has claimed.
            { 'lastRun.dayKey': { $ne: dayKey } },
            // A retry whose delay has elapsed and whose budget is not spent.
            {
              'lastRun.dayKey': dayKey,
              'lastRun.status': SCHEDULER_RUN_STATUS.RETRYING,
              'lastRun.nextAttemptAt': { $lte: now },
              'lastRun.attempts': { $lte: maxRetries },
            },
            // A claim abandoned by a process that died. The clause above
            // guarantees this can only match once it is stale.
            { 'lastRun.dayKey': dayKey, 'lastRun.status': SCHEDULER_RUN_STATUS.RUNNING },
          ],
        },
      ],
    },
    claimUpdate({ dayKey, trigger, now }),
    PIPELINE_UPDATE,
  )
}

/**
 * Takes ownership for a manual run.
 *
 * Differs from the scheduled claim in exactly one way: it ignores the day key,
 * because an administrator pressing Run now has said, explicitly, that they
 * want it run now. It does not ignore an in-flight run — two concurrent
 * scheduler runs would race to enqueue the same file — and it does not ignore
 * the workbook hash, which is checked later and is the guard that actually
 * prevents a duplicate job.
 *
 * `enabled` is not required. Disabling the schedule turns off the clock, not
 * the button; an operator who has paused automation still needs a way to run
 * today's workbook by hand.
 */
async function claimManualRun({ setting, dayKey, now }) {
  const staleBefore = new Date(now.getTime() - SCHEDULER_CLAIM_TTL_MS)

  return SchedulerSetting.findOneAndUpdate(
    {
      _id: setting._id,
      // As on the scheduled claim: authorised here as well as at the caller.
      isPrimary: true,
      $or: [
        { 'lastRun.status': { $ne: SCHEDULER_RUN_STATUS.RUNNING } },
        { 'lastRun.startedAt': { $lt: staleBefore } },
      ],
    },
    [
      {
        $set: {
          'lastRun.dayKey': dayKey,
          'lastRun.status': SCHEDULER_RUN_STATUS.RUNNING,
          'lastRun.trigger': SCHEDULER_TRIGGER.MANUAL,
          'lastRun.startedAt': now,
          'lastRun.finishedAt': null,
          'lastRun.nextAttemptAt': null,
          'lastRun.reason': null,
          'lastRun.message': null,
          'lastRun.attempts': 1,
        },
      },
    ],
    PIPELINE_UPDATE,
  )
}

// ---------------------------------------------------------------------------
// Executing a claimed run
// ---------------------------------------------------------------------------

/**
 * Chooses the worksheet, using the classifier the upload screen uses.
 *
 * A workbook has several sheets and only one of them is the lead register; the
 * hotel operations ledger sitting beside it must never be imported. Rather than
 * encode any of that here, this asks `classifyWorkbook` for its recommendation
 * — the same value the "choose a sheet" step preselects for a human.
 *
 * @returns {{ sheet: string } | { sheet: null, reason: string, message: string }}
 */
function resolveSheet({ buffer, filename }) {
  let classification

  try {
    const sheets = listSheets(buffer).map((sheet) => {
      const parsed = fromXlsx(buffer, { sheet: sheet.name })

      return {
        name: sheet.name,
        headers: parsed.headers,
        rows: parsed.grid.slice(parsed.headerRowNumber),
      }
    })

    classification = classifyWorkbook(sheets)
  } catch (error) {
    return {
      sheet: null,
      reason: SCHEDULER_SKIP_REASON.UNREADABLE,
      message: `"${filename}" could not be read as a workbook: ${error.message}`,
    }
  }

  if (!classification.recommended) {
    return {
      sheet: null,
      reason: SCHEDULER_SKIP_REASON.NO_LEAD_SHEET,
      message:
        `"${filename}" has no worksheet that looks like a lead register, so nothing was ` +
        'imported. A lead sheet needs a contact name and an email address column.',
    }
  }

  return { sheet: classification.recommended }
}

/**
 * Has this workspace already handed these exact bytes to the queue?
 *
 * Only runs that produced a job count. A previous attempt that failed to
 * enqueue must not block the retry it is entitled to, and a previous attempt
 * that skipped never touched the file.
 *
 * The job is checked too, not just the scheduler's own ledger: a job deleted
 * from the history is a job whose leads still exist, and re-queueing on the
 * strength of the ledger alone would be the one path back to a duplicate run.
 */
async function alreadyProcessed({ owner, hash }) {
  const previous = await SchedulerRun.findOne({
    owner,
    'workbook.hash': hash,
    status: SCHEDULER_RUN_STATUS.QUEUED,
  })
    .sort({ createdAt: -1 })
    .select('importJob dayKey createdAt')

  if (!previous) return null

  // A run whose job has since been deleted is treated as not processed, so a
  // deliberate "clear the history and re-run" still works.
  if (previous.importJob) {
    const job = await ImportJob.exists({ _id: previous.importJob })
    if (!job) return null
  }

  return previous
}

/**
 * Does the work of one claimed run.
 *
 * Returns an outcome rather than throwing, except for genuinely unexpected
 * failures — which the caller turns into a retry. The distinction matters: "no
 * workbook today" must never consume a retry, because retrying will not make a
 * file appear.
 *
 * @returns {Promise<{ status, reason?, message, importJob?, workbook? }>}
 */
async function executeRun({ setting, dayKey }) {
  const owner = setting.owner

  const discovery = await findLatestWorkbook({ directory: config.scheduler.inboxDir })

  if (!discovery.found) {
    log.info('Workbook missing', { owner: String(owner), dayKey, reason: discovery.reason })

    return {
      status: SCHEDULER_RUN_STATUS.SKIPPED,
      reason: discovery.reason,
      message: discovery.message,
    }
  }

  const workbook = {
    filename: discovery.filename,
    hash: discovery.hash,
    size: discovery.size,
    modifiedAt: discovery.modifiedAt,
    candidates: discovery.candidates,
    sheet: null,
  }

  const previous = await alreadyProcessed({ owner, hash: discovery.hash })
  if (previous) {
    log.info('Workbook already processed', {
      owner: String(owner),
      dayKey,
      file: discovery.filename,
      previousRun: previous._id.toString(),
      previousJob: previous.importJob?.toString() ?? null,
    })

    return {
      status: SCHEDULER_RUN_STATUS.SKIPPED,
      reason: SCHEDULER_SKIP_REASON.ALREADY_PROCESSED,
      message:
        `"${discovery.filename}" is identical to the workbook already processed on ` +
        `${previous.dayKey}. Nothing was queued, so nobody is emailed twice.`,
      workbook,
    }
  }

  const resolved = resolveSheet({ buffer: discovery.buffer, filename: discovery.filename })
  if (!resolved.sheet) {
    log.warn('Workbook has no lead sheet', {
      owner: String(owner),
      dayKey,
      file: discovery.filename,
      reason: resolved.reason,
    })

    return {
      status: SCHEDULER_RUN_STATUS.SKIPPED,
      reason: resolved.reason,
      message: resolved.message,
      workbook,
    }
  }

  workbook.sheet = resolved.sheet

  /**
   * The handover.
   *
   * Everything above this line decided *whether*. This line is *what*, and it
   * is the same function the upload endpoint calls with the same options, so
   * from here on an automatic run and a manual one are indistinguishable.
   */
  const job = await enqueueWorkbookSync({
    owner,
    createdBy: null,
    buffer: discovery.buffer,
    filename: discovery.filename,
    options: {
      sheet: resolved.sheet,
      sendMail: setting.sendMail !== false,
      /**
       * Never forced, and not configurable.
       *
       * `forceResend` is the single documented way past "a customer is never
       * introduced twice". It requires a human to tick a box for a specific
       * run, and an unattended process at 09:00 is the exact opposite of that.
       */
      forceResend: false,
    },
  })

  log.info('Job created', {
    owner: String(owner),
    dayKey,
    job: job._id.toString(),
    file: discovery.filename,
    sheet: resolved.sheet,
    bytes: discovery.size,
  })

  return {
    status: SCHEDULER_RUN_STATUS.QUEUED,
    message:
      `"${discovery.filename}" was queued from the "${resolved.sheet}" sheet. ` +
      'The background worker imports it and emails the new enquiries.',
    importJob: job._id,
    workbook,
  }
}

// ---------------------------------------------------------------------------
// Recording an outcome
// ---------------------------------------------------------------------------

/**
 * Writes the history entry and releases the claim.
 *
 * Both writes always happen, including for a failure — a run whose outcome was
 * not recorded is a run that looks, to the next tick, exactly like a crash.
 */
async function finishRun({ setting, dayKey, outcome, actor = null, startedAt, durationMs }) {
  const finishedAt = new Date()

  const run = await SchedulerRun.create({
    owner: setting.owner,
    dayKey,
    trigger: setting.lastRun?.trigger ?? SCHEDULER_TRIGGER.SCHEDULE,
    status: outcome.status,
    attempt: setting.lastRun?.attempts ?? 1,
    reason: outcome.reason ?? null,
    message: outcome.message,
    workbook: outcome.workbook ?? {},
    importJob: outcome.importJob ?? null,
    actor,
    startedAt,
    finishedAt,
    /**
     * Measured, not derived from the two timestamps.
     *
     * `startedAt` is the *logical* start — the clock the tick was given, which
     * a test injects and which a clock correction could move backwards.
     * Subtracting it from a real wall-clock finish can produce a negative
     * duration, which the model rejects, which would lose the one history entry
     * somebody is trying to read.
     */
    durationMs,
  })

  await SchedulerSetting.updateOne(
    { _id: setting._id },
    {
      $set: {
        'lastRun.status': outcome.status,
        'lastRun.finishedAt': finishedAt,
        'lastRun.reason': outcome.reason ?? null,
        'lastRun.message': outcome.message,
        'lastRun.importJob': outcome.importJob ?? null,
        'lastRun.schedulerRun': run._id,
        'lastRun.workbook': outcome.workbook ?? {},
        'lastRun.nextAttemptAt': outcome.nextAttemptAt ?? null,
      },
    },
  )

  return run
}

/**
 * Turns an unexpected failure into either a pending retry or a settled defeat.
 *
 * Only reached when `executeRun` threw — a database that went away, a disk that
 * filled, a queue insert that was rejected. A skip never lands here, because a
 * skip is not a failure.
 */
function planRetry({ setting, error, now }) {
  const attempts = setting.lastRun?.attempts ?? 1
  const maxRetries = setting.retry?.maxRetries ?? 0
  const message = error?.message ?? 'The scheduled run failed.'

  if (attempts > maxRetries) {
    return {
      status: SCHEDULER_RUN_STATUS.FAILED,
      reason: null,
      message:
        `The scheduled run failed after ${attempts} attempt(s) and will not be retried today: ` +
        `${message}`,
    }
  }

  const delayMs = setting.retry?.delayMs ?? 0

  return {
    status: SCHEDULER_RUN_STATUS.RETRYING,
    reason: null,
    message: `Attempt ${attempts} failed: ${message} Retrying in ${Math.round(delayMs / 1000)}s.`,
    nextAttemptAt: new Date(now.getTime() + delayMs),
  }
}

/** Runs a claimed workspace to an outcome and records it. Never throws. */
async function runClaimed({ claimed, dayKey, actor = null, now = new Date() }) {
  const startedAt = claimed.lastRun?.startedAt ?? now
  const began = Date.now()

  let outcome
  try {
    outcome = await executeRun({ setting: claimed, dayKey })
  } catch (error) {
    /**
     * `now` is the tick's clock, not `new Date()`.
     *
     * The retry's due time has to be comparable with the clock the *next* tick
     * will use, and the two must be the same clock — otherwise a retry becomes
     * due against one reading and is tested against another.
     */
    outcome = planRetry({ setting: claimed, error, now })

    if (outcome.status === SCHEDULER_RUN_STATUS.RETRYING) {
      log.warn('Retry scheduled', {
        owner: String(claimed.owner),
        dayKey,
        attempt: claimed.lastRun?.attempts ?? 1,
        nextAttemptAt: outcome.nextAttemptAt?.toISOString(),
        error: error?.message,
      })
    } else {
      log.error('Job failed', {
        owner: String(claimed.owner),
        dayKey,
        attempts: claimed.lastRun?.attempts ?? 1,
        error: error?.message,
      })
    }
  }

  try {
    const run = await finishRun({
      setting: claimed,
      dayKey,
      outcome,
      actor,
      startedAt,
      durationMs: Date.now() - began,
    })

    return { ...outcome, run }
  } catch (error) {
    // The outcome could not be recorded. The claim is left as it is: it goes
    // stale in five minutes and the next tick picks the day up again, which is
    // the correct behaviour for a run whose result is unknown.
    log.error('A scheduler outcome could not be recorded', {
      owner: String(claimed.owner),
      dayKey,
      error: error?.message,
    })

    return { ...outcome, run: null }
  }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Asks every enabled workspace whether anything is due.
 *
 * Reads one small document per workspace and, on all but one tick a day, stops
 * there. The guard against re-entry is the same shape the workbook worker uses:
 * a tick that overlaps its predecessor would be two processes racing on the
 * claim, which is safe but pointless.
 *
 * @param {{ trigger?: string, now?: Date }} options
 */
export async function tick({ trigger = SCHEDULER_TRIGGER.SCHEDULE, now = new Date() } = {}) {
  if (isTicking || isStopping) return { checked: 0, ran: 0 }

  isTicking = true
  let checked = 0
  let ran = 0

  try {
    /**
     * The primary workspace only.
     *
     * `isPrimary` is what makes "one workbook, one import, one email" true. The
     * inbox is a single shared folder, and every other guard in this module —
     * the day claim, the workbook hash — is scoped to one owner, so without
     * this filter each owner workspace would independently process the same
     * file and email the same customers.
     */
    const settings = await SchedulerSetting.find({ enabled: true, isPrimary: true })

    for (const setting of settings) {
      if (isStopping) break
      checked += 1

      const minutes = parseRunTime(setting.runTime)
      if (minutes === null) {
        log.warn('Scheduler skipped: the configured run time is not a valid 24-hour time', {
          owner: String(setting.owner),
          runTime: setting.runTime,
        })
        continue
      }

      const dayKey = dueDayKey(now, minutes, setting.timezone)

      // Before the configured time. Nothing is due, and nothing is logged —
      // this is the answer on all but a handful of the day's 1,440 ticks.
      if (!dayKey) continue

      const claimed = await claimScheduledRun({ setting, dayKey, trigger, now })
      if (!claimed) continue

      ran += 1

      log.info('Scheduler started', {
        owner: String(setting.owner),
        dayKey,
        trigger: claimed.lastRun?.trigger,
        attempt: claimed.lastRun?.attempts,
        runTime: setting.runTime,
        timezone: setting.timezone,
      })

      const outcome = await runClaimed({ claimed, dayKey, now })

      log.info('Scheduler finished', {
        owner: String(setting.owner),
        dayKey,
        status: outcome.status,
        reason: outcome.reason ?? null,
        job: outcome.importJob?.toString() ?? null,
      })
    }
  } catch (error) {
    // A failure in the sweep itself rather than in a run. Logged and left for
    // the next tick, exactly as the workbook worker treats a failed claim.
    log.error('The scheduler tick failed', { error: error?.message })
  } finally {
    isTicking = false
  }

  return { checked, ran }
}

/**
 * Runs today's scheduler for one workspace, on demand.
 *
 * Identical to the automatic path from the claim onwards: same discovery, same
 * duplicate checks, same enqueue, same history entry. The only difference is
 * that it does not wait for the clock and does not require the schedule to be
 * enabled.
 *
 * @returns {Promise<{ ok: boolean, status: string, message: string, run: ?object }>}
 */
export async function runNow({ owner, actor = null }) {
  const setting = await ensureSettings({ owner })
  const now = new Date()

  /**
   * Only the primary workspace may run the workbook, by hand or by clock.
   *
   * Without this an administrator on a second workspace could press Run now and
   * produce exactly the duplicate import the tick filter prevents — the button
   * would be a way around the guarantee rather than a shortcut to it.
   */
  if (!setting.isPrimary) {
    return {
      ok: false,
      status: SCHEDULER_RUN_STATUS.SKIPPED,
      message:
        'This workspace does not own the morning run. The daily workbook is processed by the ' +
        'scheduling workspace so that one file produces one import and one email per customer.',
      run: null,
    }
  }

  const minutes = parseRunTime(setting.runTime) ?? 0
  const dayKey = dayKeyIn(now, setting.timezone)

  const claimed = await claimManualRun({ setting, dayKey, now })

  if (!claimed) {
    return {
      ok: false,
      status: SCHEDULER_RUN_STATUS.RUNNING,
      message: 'A scheduler run is already in progress. Wait for it to finish and try again.',
      run: null,
    }
  }

  log.info('Scheduler started', {
    owner: String(owner),
    dayKey,
    trigger: SCHEDULER_TRIGGER.MANUAL,
    actor: actor ? String(actor) : null,
    scheduledFor: minutes,
  })

  const outcome = await runClaimed({ claimed, dayKey, actor, now })

  log.info('Scheduler finished', {
    owner: String(owner),
    dayKey,
    trigger: SCHEDULER_TRIGGER.MANUAL,
    status: outcome.status,
    reason: outcome.reason ?? null,
    job: outcome.importJob?.toString() ?? null,
  })

  return {
    ok: outcome.status === SCHEDULER_RUN_STATUS.QUEUED,
    status: outcome.status,
    message: outcome.message,
    run: outcome.run?.toPublicJSON() ?? null,
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Starts the scheduler. Idempotent.
 *
 * The first tick runs immediately rather than in a minute's time, and it is
 * that tick — not any special-cased recovery path — that handles the brief's
 * missed-run case. A process booting at 09:20 finds 09:00 passed and today
 * unclaimed, and runs. A process booting at 09:25 after the first one already
 * ran finds today claimed, and does not.
 */
export function startScheduler() {
  if (timer) return timer

  isStopping = false

  timer = setInterval(() => void tick(), SCHEDULER_TICK_INTERVAL_MS)

  // Never keeps the process alive on its own; a shutdown should not wait out a
  // poll that has nothing to do.
  timer.unref()

  log.info('Scheduler started', {
    tickIntervalMs: SCHEDULER_TICK_INTERVAL_MS,
    inbox: config.scheduler.inboxDir,
  })

  // Deliberately not awaited: the API should bind its port immediately, and a
  // catch-up run that takes a moment must not delay that.
  void ensureInbox(config.scheduler.inboxDir).then(() =>
    tick({ trigger: SCHEDULER_TRIGGER.STARTUP }),
  )

  return timer
}

/** Stops the scheduler. An in-flight run is left to finish. */
export function stopScheduler() {
  isStopping = true

  if (timer) {
    clearInterval(timer)
    timer = null
  }

  log.info('Scheduler finished', { reason: 'shutdown' })
}

/** True while a tick is in progress. */
export const isSchedulerBusy = () => isTicking

export default {
  ensureSettings,
  seedSchedulerSettings,
  electPrimaryWorkspace,
  runNow,
  startScheduler,
  stopScheduler,
  tick,
}
