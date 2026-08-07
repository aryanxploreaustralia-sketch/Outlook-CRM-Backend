/**
 * The reply-sync worker.
 *
 * ## What this adds, and what it deliberately does not
 *
 * Nothing about *what* a reply sync does. Fetching, matching, threading,
 * updating the lead, notifying — all of it belongs to services that existed
 * before this phase and are called unchanged. This module only changes *when*
 * that happens: every few minutes, on a timer, rather than when somebody
 * remembers to press a button.
 *
 * The single call it makes is `runReplySync(...)` — the same function
 * `POST /conversations/sync` calls. There is no second description anywhere of
 * what a sync consists of, which is the only way the manual and automatic paths
 * can be guaranteed not to drift apart.
 *
 * ## Why it is not the H3 scheduler
 *
 * It reuses H3's *infrastructure* — the same settings document, the same
 * atomic-claim pattern, the same start/stop lifecycle — but not its scheduling
 * logic, because the two jobs are different shapes:
 *
 *   - The morning run is **once per calendar day at a wall-clock time**. Its
 *     correctness argument is a day key, and its hard case is a missed run.
 *   - The reply sync is **every N minutes**. It has no wall-clock meaning, no
 *     day to claim, and no missed run to catch up — a tick that does not happen
 *     is simply a sync that happens at the next one, against a mailbox that is
 *     still there.
 *
 * Forcing an interval job through day-key logic would have meant inventing a
 * "day" for something that has none. Sharing the claim primitive, which is the
 * part that is actually hard, gets the reuse without the distortion.
 *
 * ## Duplicate protection
 *
 * Three layers, only the first of which is new:
 *
 *   1. **The claim.** One worker per workspace at a time; a claim older than
 *      the TTL belonged to a process that died and is reclaimable.
 *   2. **`ingestMessage`.** Returns `duplicate` for any `providerMessageId`
 *      already stored. This is what makes a replayed delta, an overlapping
 *      window and a manual sync racing the timer all converge.
 *   3. **The unique index on `Notification.dedupeKey`.** Even a second
 *      ingestion could not ring the bell twice.
 */

import { SchedulerSetting } from '../../../models/schedulerSetting.model.js'
import { createContextLogger } from '../../../utils/logger.js'
import { runReplySync } from '../../conversations/services/replySync.service.js'
import {
  REPLY_SYNC_CLAIM_TTL_MS,
  REPLY_SYNC_MAX_BACKOFF_MINUTES,
  REPLY_SYNC_STATUS,
  REPLY_SYNC_TICK_INTERVAL_MS,
} from '../constants/schedulerConstants.js'

const log = createContextLogger('reply-sync')

let timer = null
let isTicking = false
let isStopping = false

/**
 * When the next run is due after this one.
 *
 * Backs off exponentially while a workspace keeps failing, because the usual
 * cause is a revoked token or a disconnected mailbox — conditions that no
 * number of retries fixes, and which would otherwise produce a Graph call and a
 * log line every five minutes indefinitely. Any success resets the streak, so a
 * transient network failure costs one longer gap and nothing more.
 */
function nextRunAfter({ now, intervalMinutes, consecutiveFailures }) {
  const backoff = Math.min(
    intervalMinutes * 2 ** Math.max(0, consecutiveFailures),
    REPLY_SYNC_MAX_BACKOFF_MINUTES,
  )

  const minutes = consecutiveFailures > 0 ? backoff : intervalMinutes

  return new Date(now.getTime() + minutes * 60 * 1000)
}

/**
 * Takes ownership of one workspace's sync, atomically, or returns null.
 *
 * The same shape as the H3 claim, and for the same reason: two processes
 * issuing this at the same instant, one wins, because the filter requires the
 * run to be due and not already held, and the update holds it.
 *
 * `nextRunAt: null` matches `$lte` on no document, so it is spelled out — a
 * workspace that has never run is due immediately.
 */
async function claim({ ownerId, now, force = false }) {
  const staleBefore = new Date(now.getTime() - REPLY_SYNC_CLAIM_TTL_MS)

  const filter = {
    _id: ownerId,
    $and: [
      // Not held by a live worker. A stale claim is reclaimable.
      {
        $or: [
          { 'replySync.status': { $ne: REPLY_SYNC_STATUS.RUNNING } },
          { 'replySync.startedAt': { $lt: staleBefore } },
        ],
      },
    ],
  }

  /**
   * A manual run skips the "is it due?" test and nothing else.
   *
   * It still cannot start on top of a run already in flight — two workers
   * reading one mailbox is the one thing the claim exists to prevent, and
   * "Sync now" is not a reason to allow it.
   */
  if (!force) {
    filter['replySync.enabled'] = true
    filter.$and.push({
      $or: [{ 'replySync.nextRunAt': null }, { 'replySync.nextRunAt': { $lte: now } }],
    })
  }

  return SchedulerSetting.findOneAndUpdate(
    filter,
    {
      $set: {
        'replySync.status': REPLY_SYNC_STATUS.RUNNING,
        'replySync.startedAt': now,
        'replySync.finishedAt': null,
      },
    },
    { returnDocument: 'after' },
  )
}

/**
 * Runs one claimed workspace and records the outcome. Never throws.
 *
 * @returns {Promise<{ status: string, message: string, result: ?object }>}
 */
async function runClaimed({ setting, manual = false, auth = null }) {
  const owner = setting.owner
  const began = Date.now()

  let status = REPLY_SYNC_STATUS.OK
  let message = null
  let result = null
  let failures = 0

  try {
    result = await runReplySync({
      owner,
      /**
       * Present only on the manual path.
       *
       * It saves a user lookup and, more importantly, keeps a request-driven
       * sync resolving the provider from exactly the same object the rest of
       * the request uses. The worker passes null and `runReplySync` loads the
       * user itself.
       */
      auth,
      downloadAttachments: setting.replySync?.downloadAttachments !== false,
    })

    if (!result.ok) {
      // "No mailbox connected" and "the owner is gone" are states a timer
      // cannot fix, so they are recorded honestly and do not count as failures.
      status = REPLY_SYNC_STATUS.SKIPPED
      message = result.message
    } else {
      message = result.message

      if (result.created > 0) {
        log.info('Replies ingested', {
          owner: String(owner),
          created: result.created,
          matched: result.matched,
          unmatched: result.unmatched,
          duplicates: result.duplicates,
          manual,
        })
      }
    }
  } catch (error) {
    status = REPLY_SYNC_STATUS.FAILED
    message = error?.message ?? 'The reply sync failed.'
    failures = (setting.replySync?.consecutiveFailures ?? 0) + 1

    log.error('Reply sync failed', {
      owner: String(owner),
      attempt: failures,
      error: message,
    })
  }

  const now = new Date()
  const intervalMinutes = setting.replySync?.intervalMinutes ?? 5

  await SchedulerSetting.updateOne(
    { _id: setting._id },
    {
      $set: {
        'replySync.status': status,
        'replySync.finishedAt': now,
        'replySync.message': message,
        'replySync.consecutiveFailures': failures,
        'replySync.nextRunAt': nextRunAfter({
          now,
          intervalMinutes,
          consecutiveFailures: failures,
        }),
        'replySync.lastResult': {
          total: result?.total ?? 0,
          created: result?.created ?? 0,
          duplicates: result?.duplicates ?? 0,
          matched: result?.matched ?? 0,
          unmatched: result?.unmatched ?? 0,
          failed: result?.failed ?? 0,
        },
      },
    },
  )

  return { status, message, result, durationMs: Date.now() - began }
}

/**
 * Asks every enabled workspace whether a sync is due.
 *
 * Reads one small document per workspace and, on most passes, stops there.
 * Re-entry is guarded the same way the workbook worker guards it: an
 * overlapping tick would be two processes racing on a claim, which is safe but
 * pointless.
 */
export async function tick({ now = new Date() } = {}) {
  if (isTicking || isStopping) return { checked: 0, ran: 0 }

  isTicking = true
  let checked = 0
  let ran = 0

  try {
    const settings = await SchedulerSetting.find({ 'replySync.enabled': true })

    for (const setting of settings) {
      if (isStopping) break
      checked += 1

      const claimed = await claim({ ownerId: setting._id, now })
      if (!claimed) continue

      ran += 1
      await runClaimed({ setting: claimed })
    }
  } catch (error) {
    // A failure in the sweep itself rather than in a run. Logged and left for
    // the next tick, exactly as the other two workers treat a failed claim.
    log.error('The reply sync tick failed', { error: error?.message })
  } finally {
    isTicking = false
  }

  return { checked, ran }
}

/**
 * Runs a reply sync for one workspace on demand.
 *
 * Identical to the automatic path from the claim onwards — same claim, same
 * `runReplySync`, same state written afterwards. The only difference is that it
 * does not wait for the interval and does not require the schedule to be
 * enabled: switching the automation off turns off the timer, not the button.
 *
 * @returns {Promise<{ ok, status, message, result }>}
 */
export async function syncNow({ owner, auth = null }) {
  const setting = await SchedulerSetting.findOne({ owner })

  if (!setting) {
    return {
      ok: false,
      status: REPLY_SYNC_STATUS.IDLE,
      message: 'This workspace has no scheduler settings yet.',
      result: null,
    }
  }

  const claimed = await claim({ ownerId: setting._id, now: new Date(), force: true })

  if (!claimed) {
    return {
      ok: false,
      status: REPLY_SYNC_STATUS.RUNNING,
      message: 'A reply sync is already in progress. Wait for it to finish and try again.',
      result: null,
    }
  }

  const outcome = await runClaimed({ setting: claimed, manual: true, auth })

  return {
    ok: outcome.status !== REPLY_SYNC_STATUS.FAILED,
    status: outcome.status,
    message: outcome.message,
    result: outcome.result,
  }
}

/** Starts the worker. Idempotent. */
export function startReplySyncWorker() {
  if (timer) return timer

  isStopping = false
  timer = setInterval(() => void tick(), REPLY_SYNC_TICK_INTERVAL_MS)

  // Never keeps the process alive on its own.
  timer.unref()

  log.info('Reply sync worker started', { tickIntervalMs: REPLY_SYNC_TICK_INTERVAL_MS })

  // Not awaited: the API should bind its port immediately.
  void tick()

  return timer
}

/** Stops the worker. An in-flight run is left to finish. */
export function stopReplySyncWorker() {
  isStopping = true

  if (timer) {
    clearInterval(timer)
    timer = null
  }

  log.info('Reply sync worker stopped')
}

/** True while a tick is in progress. */
export const isReplySyncBusy = () => isTicking

export default { tick, syncNow, startReplySyncWorker, stopReplySyncWorker }
