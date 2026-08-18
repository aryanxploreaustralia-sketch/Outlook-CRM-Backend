/**
 * Server entry point.
 *
 * Owns everything with a side effect: connecting to MongoDB, binding the HTTP
 * port, and shutting both down cleanly when the process is asked to stop.
 *
 * Shutdown order matters. The HTTP listener closes first so no new request can
 * arrive, in-flight requests are given a grace period to finish, and only then
 * is the database connection released. Doing it the other way round would fail
 * requests that were already mid-query.
 */

import { connectDatabase, disconnectDatabase } from './config/database.js'
import { refreshRoleOverrides } from './modules/admin/services/rolePermission.service.js'
import { config } from './config/index.js'
import { createApp } from './app.js'
import {
  isWorkerBusy,
  recoverInterruptedJobs,
  startWorkbookWorker,
  stopWorkbookWorker,
} from './jobs/workbookQueue.service.js'
import {
  electPrimaryWorkspace,
  isSchedulerBusy,
  seedSchedulerSettings,
  startScheduler,
  stopScheduler,
} from './modules/scheduler/services/scheduler.service.js'
import {
  isReplySyncBusy,
  startReplySyncWorker,
  stopReplySyncWorker,
} from './modules/scheduler/services/replySyncScheduler.service.js'
import {
  startTaskWorker,
  stopTaskWorker,
} from './modules/tasks/services/taskScheduler.service.js'
import { createContextLogger, logger } from './utils/logger.js'

const log = createContextLogger('server')

/** Guards against a second shutdown running while the first is in progress. */
let isShuttingDown = false

/** How often the drain asks whether the workers have finished. */
const DRAIN_POLL_INTERVAL_MS = 250

/**
 * Waits for in-flight background work to finish.
 *
 * ## Why this exists
 *
 * All three workers already expose a busy flag, and the workbook queue's was
 * even documented as "used by the shutdown path" — but nothing called any of
 * them. So a restart during the 09:00 run closed the database underneath a job
 * that was mid-batch, and every remaining row failed with "Client must be
 * connected before running operations". The run was recovered on the next boot,
 * so nothing was lost and nobody was emailed twice; it simply ended `partial`
 * with a wall of errors somebody then had to interpret.
 *
 * The three stop functions have already been called by the time this runs, so
 * no *new* job can be claimed. This only waits out the one already in progress.
 *
 * @param {number} timeoutMs  Budget. On expiry the shutdown proceeds anyway.
 * @returns {Promise<boolean>} True when every worker went idle in time.
 */
async function drainWorkers(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const busy = () => isWorkerBusy() || isSchedulerBusy() || isReplySyncBusy()

  if (!busy()) return true

  log.info('Waiting for background work to finish before shutting down', {
    workbook: isWorkerBusy(),
    scheduler: isSchedulerBusy(),
    replySync: isReplySyncBusy(),
    timeoutMs,
  })

  while (busy()) {
    if (Date.now() >= deadline) {
      /**
       * Out of time, and that is survivable.
       *
       * A workbook run pacing 500 introductions takes far longer than any
       * sensible shutdown budget. Exiting now costs the remainder of *this*
       * attempt, not the work: the job is requeued at the next boot and resumes
       * from its cursor, and `autoMail.status === 'sent'` still refuses to
       * introduce anybody twice. Raise `SHUTDOWN_TIMEOUT_MS` to let long runs
       * finish across a restart.
       */
      log.warn('Background work did not finish within the shutdown timeout', {
        workbook: isWorkerBusy(),
        scheduler: isSchedulerBusy(),
        replySync: isReplySyncBusy(),
        note: 'an unfinished run is requeued and resumes from its cursor on the next boot',
      })

      return false
    }

    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS))
  }

  log.info('Background work finished')

  return true
}

/**
 * Stops accepting work, lets the workers finish, then closes everything.
 *
 * Order is load-bearing:
 *
 *   1. **Stop the workers.** Each sets its stopping flag, so the current job
 *      finishes but no next one is claimed.
 *   2. **Drain.** Wait for the in-flight job — this is the step that was
 *      missing, and the reason restarts produced partial runs.
 *   3. **Close HTTP.** No new requests.
 *   4. **Disconnect the database.** Last, because everything above may still
 *      need it. Doing this earlier is precisely the old bug.
 *
 * @param {import('node:http').Server} server
 * @param {string} reason  What triggered the shutdown, for the log.
 * @param {number} exitCode
 */
async function shutdown(server, reason, exitCode = 0) {
  if (isShuttingDown) return
  isShuttingDown = true

  log.info(`Shutdown initiated (${reason})`)

  /**
   * Nothing new is accepted from here.
   *
   * The scheduler goes first because it only ever *creates* work; stopping it
   * before the queue means nothing can be enqueued while the queue is draining.
   * The reply worker follows, and the queue last, so the queue's stop flag is
   * set after its last possible producer has already gone quiet.
   */
  stopScheduler()
  stopReplySyncWorker()
  stopTaskWorker()
  stopWorkbookWorker()

  // The step that was missing. A run already in flight is allowed to finish.
  await drainWorkers(config.server.shutdownTimeoutMs)

  /**
   * The backstop, started only now.
   *
   * Measured from after the drain so the drain's own budget does not consume
   * it — otherwise a shutdown that legitimately waited would be force-killed
   * before it had closed anything.
   */
  const forceExitTimer = setTimeout(() => {
    log.error('Graceful shutdown timed out - forcing exit')
    process.exit(1)
  }, config.server.shutdownTimeoutMs)

  // Do not hold the event loop open just for this timer.
  forceExitTimer.unref()

  try {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    log.info('HTTP server closed')
  } catch (error) {
    log.error('Error while closing the HTTP server', { message: error.message })
  }

  await disconnectDatabase()

  clearTimeout(forceExitTimer)
  log.info('Shutdown complete')

  // Give Winston a moment to flush buffered file writes before the process dies.
  logger.end()
  setTimeout(() => process.exit(exitCode), 100).unref()
}

/** Boots the application. */
async function bootstrap() {
  log.info(`Starting ${config.app.name} v${config.app.version}`, {
    environment: config.app.env,
    node: process.version,
  })

  // Awaited so the API is ready to serve real queries the moment it accepts
  // traffic. A failure here is logged and tolerated: the server still starts and
  // reports the database as unavailable through /api/v1/health.
  const databaseConnected = await connectDatabase()
  if (!databaseConnected) {
    log.warn('Starting without a database connection - dependent routes will fail')
  }

  /*
   * Stored role definitions, loaded before the first request.
   *
   * Without this the process would serve the built-in matrix until the first
   * authenticated request triggered a refresh — briefly enforcing permissions an
   * administrator had already changed. `loadSession` keeps it current from then
   * on; this closes the window at startup.
   *
   * Tolerated on failure, like the database connection above: a deployment that
   * cannot read its overrides still enforces the built-in matrix, which is a
   * safe and complete permission model rather than an absent one.
   */
  if (databaseConnected) {
    try {
      const customised = await refreshRoleOverrides()
      if (customised > 0) log.info(`Loaded ${customised} customised role definition(s)`)
    } catch (error) {
      log.warn(`Could not load role definitions - enforcing the built-in matrix: ${error.message}`)
    }
  }

  /**
   * The background workbook worker.
   *
   * Started only with a database, because both the queue and its recovery live
   * in MongoDB — starting it without one would produce a failed poll every two
   * seconds and nothing else.
   *
   * Recovery runs first: a run interrupted by a restart is put back in the
   * queue before the worker begins, so it resumes in seconds rather than
   * waiting out the ten-minute lock TTL.
   */
  if (databaseConnected) {
    await recoverInterruptedJobs().catch((error) =>
      log.warn('Could not requeue interrupted workbook runs', { message: error.message }),
    )
    startWorkbookWorker()

    /**
     * The morning scheduler.
     *
     * Started after the worker, so the very first tick — which may find that
     * today's 09:00 run is outstanding and queue it immediately — hands the job
     * to a worker that is already draining. Started only with a database, for
     * the same reason the worker is: its settings and its day claim both live
     * in MongoDB.
     *
     * Seeding is awaited so a fresh deployment has the brief's defaults (on,
     * 09:00, Asia/Kolkata) before the first tick reads them. Nothing is sent as
     * a result: the inbox of a new deployment is empty, so the first tick finds
     * no workbook and logs the reason.
     */
    await seedSchedulerSettings().catch((error) =>
      log.warn('Could not create default scheduler settings', { message: error.message }),
    )

    /**
     * Exactly one workspace owns the morning run.
     *
     * Every account that signs in defaults to the `owner` role, so a
     * three-person office has three owner workspaces. Each was seeded its own
     * scheduler, and because the day claim and the workbook-hash guard are both
     * owner-scoped, one file in the shared inbox became three imports and three
     * introductions to every customer.
     *
     * Elected before the scheduler starts, and idempotent — an office that has
     * already chosen its scheduling mailbox keeps it across every restart.
     */
    await electPrimaryWorkspace().catch((error) =>
      log.warn('Could not elect a primary scheduling workspace', { message: error.message }),
    )

    startScheduler()

    /**
     * The reply sync worker (Phase H4).
     *
     * Started last, because it depends on nothing the other two do and should
     * never delay them. Its first tick runs immediately: a process that has
     * been down for an hour has an hour of customer replies waiting, and making
     * the team wait a further five minutes for them would be a poor first
     * impression of an automation whose whole promise is that nobody watches
     * the inbox.
     */
    startReplySyncWorker()

    /**
     * The task worker (Phase 18).
     *
     * Overdue deadlines and achieved goals are the two notifications nobody's
     * action causes, so something has to watch for them. Started last and with
     * no immediate first pass: nothing here is waiting for a user.
     */
    startTaskWorker()
  } else {
    log.warn('Background workers not started - no database connection')
  }

  const app = createApp()
  const server = app.listen(config.server.port, config.server.host)

  server.on('listening', () => {
    const url = `http://${config.server.host}:${config.server.port}`
    log.info(`API listening on ${url}`)
    log.info(`Health check: ${url}${config.server.apiPrefix}/v1/health`)
  })

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      log.error(
        `Port ${config.server.port} is already in use. ` +
          'Stop the process using it, or change PORT in backend/.env.',
      )
    } else {
      log.error('HTTP server error', { message: error.message, code: error.code })
    }
    process.exit(1)
  })

  // SIGTERM comes from orchestrators (Docker, Kubernetes, systemd);
  // SIGINT comes from Ctrl+C in a terminal.
  process.on('SIGTERM', () => void shutdown(server, 'SIGTERM'))
  process.on('SIGINT', () => void shutdown(server, 'SIGINT'))

  // An unhandled rejection or uncaught exception leaves the process in an
  // unknown state. The only safe response is to log it and restart, so the
  // exit code is non-zero and a supervisor brings up a fresh process.
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
    void shutdown(server, 'unhandledRejection', 1)
  })

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', { message: error.message, stack: error.stack })
    void shutdown(server, 'uncaughtException', 1)
  })
}

bootstrap().catch((error) => {
  log.error('Fatal error during startup', { message: error.message, stack: error.stack })
  process.exit(1)
})
