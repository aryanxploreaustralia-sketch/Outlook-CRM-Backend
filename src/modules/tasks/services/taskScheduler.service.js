/**
 * The task worker (Phase 18).
 *
 * ## Why a worker at all
 *
 * Two of this phase's notifications are not caused by anybody's action.
 * "Overdue" is caused by a clock passing a date, and "goal achieved" by a
 * measurement crossing a line. Nothing calls a handler when either happens.
 *
 * The alternative — computing them when somebody opens a page — fails in two
 * ways. It tells whoever looked first and nobody else, so the person who
 * actually missed the deadline may never hear. And it makes a GET write, which
 * turns a page refresh into a side effect.
 *
 * ## Cadence
 *
 * Every fifteen minutes. Both events are day-grained, so a quarter-hour is far
 * finer than the thing being watched, and the two queries are bounded and
 * indexed. A tighter loop would buy nothing but load.
 *
 * ## Idempotence is the notifier's, not this file's
 *
 * Ticking often is safe because the dedupe key carries the due date for an
 * overdue task and the goal id for an achievement — a unique index on
 * `(owner, dedupeKey)` turns a re-delivery into a no-op. That is why this worker
 * can be crude: it does not track what it has already sent.
 */

import { createContextLogger } from '../../../utils/logger.js'
import { settleAchievedGoals } from './goal.service.js'
import { notifyOverdueTasks } from './task.service.js'

const log = createContextLogger('task-worker')

/** Fifteen minutes. See the note on cadence above. */
export const TASK_TICK_INTERVAL_MS = 15 * 60 * 1000

let timer = null
let isTicking = false

/**
 * One pass.
 *
 * Never throws. A worker that dies on a bad row stops delivering every
 * notification after it, which is a worse failure than the one that caused it.
 */
export async function tick({ now = new Date() } = {}) {
  // A slow pass must not overlap the next one: two ticks racing would do the
  // same work twice for no benefit.
  if (isTicking) return { skipped: true }

  isTicking = true

  try {
    const overdue = await notifyOverdueTasks({ now })
    const goals = await settleAchievedGoals({ now })

    if (overdue.raised > 0 || goals.achieved > 0) {
      log.info('Task worker tick', {
        overdueNotified: overdue.raised,
        goalsAchieved: goals.achieved,
      })
    }

    return { overdue, goals }
  } catch (error) {
    log.error('The task worker tick failed', { message: error?.message })
    return { error: error?.message ?? 'unknown' }
  } finally {
    isTicking = false
  }
}

/** Starts the worker. Idempotent. */
export function startTaskWorker() {
  if (timer) return timer

  timer = setInterval(() => void tick(), TASK_TICK_INTERVAL_MS)

  // Never keeps the process alive on its own — the same rule the other workers
  // follow, so a shutdown is not held open by a timer nobody is waiting for.
  timer.unref()

  log.info('Task worker started', { tickIntervalMs: TASK_TICK_INTERVAL_MS })

  /**
   * The first pass is deliberately **not** run immediately.
   *
   * Unlike reply sync, nothing here is waiting for the user: a task that went
   * overdue while the process was down is still overdue fifteen minutes later,
   * and firing a burst of "overdue" bells during boot competes with the work
   * that does need to happen at startup.
   */
  return timer
}

/** Stops the worker. An in-flight tick is left to finish. */
export function stopTaskWorker() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }

  log.info('Task worker stopped')
}

/** True while a tick is in progress. Read by the health probe. */
export const isTaskWorkerBusy = () => isTicking

export default { startTaskWorker, stopTaskWorker, tick }
