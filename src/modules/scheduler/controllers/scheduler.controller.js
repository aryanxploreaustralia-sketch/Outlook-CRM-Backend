/**
 * Scheduler administration.
 *
 * Four endpoints, and the split between them is the security boundary: reading
 * the schedule tells a salesperson when their morning starts, while changing it
 * — or triggering it — decides when a few hundred customers are written to.
 * Only the second group is privileged.
 */

import { z } from 'zod'

import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { AuditLog, AUDIT_ACTION } from '../../../models/auditLog.model.js'
import { SchedulerRun } from '../../../models/schedulerRun.model.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import {
  REPLY_SYNC_STATUS,
  RUN_TIME_PATTERN,
  SCHEDULER_RUN_STATUS,
} from '../constants/schedulerConstants.js'
import { isValidTimeZone } from '../services/schedulerClock.js'
import { ensureSettings, runNow } from '../services/scheduler.service.js'
import { syncNow } from '../services/replySyncScheduler.service.js'

const ownerOf = (req) => req.auth.user._id

/**
 * The settings body.
 *
 * Every field optional, because the settings screen sends only what changed and
 * a partial update must not silently reset the rest to their defaults.
 *
 * The inbox directory is conspicuously absent, and stays absent: see the note
 * at the top of `schedulerSetting.model.js`.
 */
const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),

    runTime: z
      .string()
      .trim()
      .regex(RUN_TIME_PATTERN, 'The run time must be a 24-hour time such as 09:00.')
      .optional(),

    timezone: z
      .string()
      .trim()
      .min(1)
      .refine(isValidTimeZone, 'That is not a timezone this server recognises, e.g. Asia/Kolkata.')
      .optional(),

    sendMail: z.boolean().optional(),

    maxRetries: z.coerce.number().int().min(0).max(10).optional(),

    /**
     * Seconds on the wire, milliseconds in the database.
     *
     * The screen offers minutes and a person thinks in minutes; storing
     * milliseconds keeps it consistent with every other duration in the
     * codebase. The conversion happens once, here.
     */
    retryDelaySeconds: z.coerce
      .number()
      .int()
      .min(10)
      .max(6 * 60 * 60)
      .optional(),

    // --- Reply sync (Phase H4) ---------------------------------------------
    //
    // Nested, so the two automations cannot be confused for one another on the
    // wire: `enabled` is the morning run, `replySync.enabled` is the inbox.

    replySync: z
      .object({
        enabled: z.boolean().optional(),
        intervalMinutes: z.coerce
          .number()
          .int()
          .min(1)
          .max(24 * 60)
          .optional(),
        downloadAttachments: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing was sent to change.')

/** How many recent attempts the settings screen shows without asking for more. */
const RECENT_RUN_LIMIT = 10

/**
 * GET /api/v1/scheduler
 *
 * The configuration, the last run and the next one, in a single request — the
 * dashboard card and the settings form read the same payload, so they can never
 * disagree about whether the scheduler is on.
 */
export const settings = asyncHandler(async (req, res) => {
  const owner = ownerOf(req)
  const setting = await ensureSettings({ owner })

  const recent = await SchedulerRun.find({ owner }).sort({ createdAt: -1 }).limit(RECENT_RUN_LIMIT)

  return sendSuccess(res, {
    message: setting.enabled
      ? `The morning run is scheduled for ${setting.runTime} ${setting.timezone}.`
      : 'The morning run is switched off.',
    data: {
      ...setting.toPublicJSON(),
      recentRuns: recent.map((run) => run.toPublicJSON()),
    },
  })
})

/** GET /api/v1/scheduler/runs — every attempt, newest first. */
export const runs = asyncHandler(async (req, res) => {
  const { page, limit } = z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    })
    .parse(req.query)

  const owner = ownerOf(req)
  const skip = (page - 1) * limit

  const [items, total] = await Promise.all([
    SchedulerRun.find({ owner }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    SchedulerRun.countDocuments({ owner }),
  ])

  return sendSuccess(res, {
    message: `${total} scheduler run(s) recorded.`,
    data: { items: items.map((run) => run.toPublicJSON()) },
    meta: {
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: skip + items.length < total,
        hasPrevious: page > 1,
      },
    },
  })
})

/**
 * PATCH /api/v1/scheduler
 *
 * Enable, disable, change the time, change the timezone, change the retry
 * policy. One endpoint rather than four, because they are one form and a
 * partial update is the natural shape of editing it.
 *
 * The run state is untouched. Moving the time from 09:00 to 08:00 after today's
 * run has already happened must not cause a second one — the day is claimed,
 * and changing the configuration does not unclaim it.
 */
export const update = asyncHandler(async (req, res) => {
  const body = settingsSchema.parse(req.body ?? {})
  const owner = ownerOf(req)
  const actor = req.auth.user

  const setting = await ensureSettings({ owner })
  const before = {
    enabled: setting.enabled,
    runTime: setting.runTime,
    timezone: setting.timezone,
    sendMail: setting.sendMail,
    maxRetries: setting.retry?.maxRetries,
    retryDelayMs: setting.retry?.delayMs,
    replySyncEnabled: setting.replySync?.enabled,
    replySyncIntervalMinutes: setting.replySync?.intervalMinutes,
  }

  if (body.enabled !== undefined) setting.enabled = body.enabled
  if (body.runTime !== undefined) setting.runTime = body.runTime
  if (body.timezone !== undefined) setting.timezone = body.timezone
  if (body.sendMail !== undefined) setting.sendMail = body.sendMail
  if (body.maxRetries !== undefined) setting.retry.maxRetries = body.maxRetries
  if (body.retryDelaySeconds !== undefined) setting.retry.delayMs = body.retryDelaySeconds * 1000

  if (body.replySync) {
    const wasEnabled = setting.replySync.enabled

    if (body.replySync.enabled !== undefined) setting.replySync.enabled = body.replySync.enabled
    if (body.replySync.downloadAttachments !== undefined) {
      setting.replySync.downloadAttachments = body.replySync.downloadAttachments
    }

    if (body.replySync.intervalMinutes !== undefined) {
      setting.replySync.intervalMinutes = body.replySync.intervalMinutes

      /**
       * A shortened interval takes effect now, not after the old one elapses.
       *
       * Moving from hourly to every five minutes and then waiting fifty-five
       * minutes for the first run would look exactly like the setting not
       * having saved. The due time is clamped to the new interval measured from
       * now, which can only ever bring it forward.
       */
      const soonest = new Date(Date.now() + body.replySync.intervalMinutes * 60 * 1000)
      if (!setting.replySync.nextRunAt || setting.replySync.nextRunAt > soonest) {
        setting.replySync.nextRunAt = soonest
      }
    }

    /**
     * Re-enabling clears the failure streak.
     *
     * The streak drives an exponential backoff. A workspace that was failing
     * because its mailbox was disconnected, and has just been switched back on
     * by someone who reconnected it, should be retried promptly rather than in
     * an hour's time.
     */
    if (!wasEnabled && setting.replySync.enabled) {
      setting.replySync.consecutiveFailures = 0
      setting.replySync.nextRunAt = null
    }
  }

  setting.updatedBy = actor._id
  await setting.save()

  /**
   * Enabling and disabling are recorded as their own actions.
   *
   * "Who turned the automation off, and when?" is the question asked after a
   * week of customers not being answered, and it deserves a better answer than
   * a diff buried in a generic update entry.
   */
  const action =
    body.enabled === true && before.enabled === false
      ? AUDIT_ACTION.SCHEDULER_ENABLED
      : body.enabled === false && before.enabled === true
        ? AUDIT_ACTION.SCHEDULER_DISABLED
        : AUDIT_ACTION.SCHEDULER_UPDATED

  await AuditLog.record({
    owner,
    actor: actor._id,
    actorEmail: actor.email ?? null,
    actorRole: actor.role ?? null,
    action,
    summary:
      action === AUDIT_ACTION.SCHEDULER_ENABLED
        ? `Enabled the morning run at ${setting.runTime} ${setting.timezone}`
        : action === AUDIT_ACTION.SCHEDULER_DISABLED
          ? 'Disabled the morning run'
          : `Changed the morning run to ${setting.runTime} ${setting.timezone}`,
    detail: {
      before,
      after: {
        enabled: setting.enabled,
        runTime: setting.runTime,
        timezone: setting.timezone,
        sendMail: setting.sendMail,
        maxRetries: setting.retry?.maxRetries,
        retryDelayMs: setting.retry?.delayMs,
        replySyncEnabled: setting.replySync?.enabled,
        replySyncIntervalMinutes: setting.replySync?.intervalMinutes,
      },
    },
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.id ?? null,
  })

  return sendSuccess(res, {
    message: setting.enabled
      ? `Saved. The next morning run is scheduled for ${setting.runTime} ${setting.timezone}.`
      : 'Saved. The morning run is switched off.',
    data: setting.toPublicJSON(),
  })
})

/**
 * POST /api/v1/scheduler/run
 *
 * Runs today's scheduler now.
 *
 * Behaves exactly as the automatic run does, including its duplicate checks —
 * so pressing it twice queues one job, and pressing it after this morning's
 * run has already dealt with the same file reports that rather than sending a
 * second round of introductions.
 *
 * `202 Accepted` when a job is created: the work has been accepted, not done.
 * The response carries no summary because at that point there is none.
 */
export const run = asyncHandler(async (req, res) => {
  const owner = ownerOf(req)
  const actor = req.auth.user

  const result = await runNow({ owner, actor: actor._id })

  // Refused because another run holds the claim. A conflict, not a failure of
  // the request — the caller can simply try again in a moment.
  if (!result.ok && result.status === SCHEDULER_RUN_STATUS.RUNNING) {
    throw ApiError.conflict(result.message)
  }

  await AuditLog.record({
    owner,
    actor: actor._id,
    actorEmail: actor.email ?? null,
    actorRole: actor.role ?? null,
    action: AUDIT_ACTION.SCHEDULER_RUN_NOW,
    summary: `Ran the scheduler manually — ${result.status}`,
    detail: {
      status: result.status,
      message: result.message,
      workbook: result.run?.workbook ?? null,
      importJob: result.run?.importJob ?? null,
    },
    durationMs: result.run?.durationMs ?? null,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.id ?? null,
  })

  return sendSuccess(res, {
    statusCode: result.ok ? HTTP_STATUS.ACCEPTED : HTTP_STATUS.OK,
    message: result.message,
    data: {
      queued: result.ok,
      status: result.status,
      importJob: result.run?.importJob ?? null,
      run: result.run,
    },
  })
})

/**
 * POST /api/v1/scheduler/reply-sync/run
 *
 * Reads the inbox now.
 *
 * Uses exactly the worker the timer uses — the same claim, the same
 * `runReplySync`, the same state written afterwards. Pressing it while a sync
 * is already running is refused rather than queued: two workers reading one
 * mailbox is the thing the claim exists to prevent, and "I pressed it twice" is
 * not a reason to allow it.
 *
 * Duplicate replies are impossible regardless, because ingestion is keyed on
 * the provider's message id — but refusing is still the honest answer to "is it
 * running?", and it costs a second Graph round trip nobody needs.
 */
export const syncRepliesNow = asyncHandler(async (req, res) => {
  const owner = ownerOf(req)
  const actor = req.auth.user

  const result = await syncNow({ owner, auth: req.auth })

  if (!result.ok && result.status === REPLY_SYNC_STATUS.RUNNING) {
    throw ApiError.conflict(result.message)
  }

  await AuditLog.record({
    owner,
    actor: actor._id,
    actorEmail: actor.email ?? null,
    actorRole: actor.role ?? null,
    action: AUDIT_ACTION.REPLY_SYNC_RUN_NOW,
    summary: `Synced replies manually — ${result.status}`,
    affectedCount: result.result?.created ?? 0,
    detail: {
      status: result.status,
      message: result.message,
      created: result.result?.created ?? 0,
      matched: result.result?.matched ?? 0,
      unmatched: result.result?.unmatched ?? 0,
      duplicates: result.result?.duplicates ?? 0,
    },
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.id ?? null,
  })

  return sendSuccess(res, {
    message: result.message,
    data: {
      ok: result.ok,
      status: result.status,
      created: result.result?.created ?? 0,
      matched: result.result?.matched ?? 0,
      unmatched: result.result?.unmatched ?? 0,
      duplicates: result.result?.duplicates ?? 0,
    },
  })
})

export default { settings, runs, update, run, syncRepliesNow }
