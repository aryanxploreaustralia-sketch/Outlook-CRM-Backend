/**
 * Background execution for the morning workbook run.
 *
 * ## What this changes, and what it deliberately does not
 *
 * Nothing about *what* a workbook sync does. Comparison, lead creation, company
 * and contact resolution and auto-mail are the same services, called with the
 * same arguments, producing the same summary. This module only changes *where*
 * that happens: in a worker rather than inside the HTTP request that uploaded
 * the file.
 *
 * The reason is narrow. A run of 500 new enquiries is paced at 2.1 seconds a
 * message, so it holds a request open for up to seventeen minutes. Every
 * reverse proxy and hosting platform in existence closes that connection long
 * before it finishes — the work completed, but the operator saw a failed upload.
 *
 * ## Why MongoDB rather than a broker
 *
 * `ImportJob` already carries everything a queue needs, and it was built that
 * way on purpose: `cursor` for the resume point, `lockedAt` with a ten-minute
 * TTL to stop two workers claiming one job, `isResumable()`, and the five
 * lifecycle states this phase requires. Introducing Redis would add an
 * operational dependency to gain a claim primitive this collection already has.
 *
 * ## Crash safety
 *
 * Three independent mechanisms, none of them new:
 *
 *   1. **The file is on disk.** A worker that is not the process which received
 *      the upload can still read it, so a restart resumes rather than loses.
 *   2. **The cursor.** A run interrupted at row 4,000 restarts at 4,000.
 *   3. **The existing idempotency.** Even if a chunk were replayed in full, the
 *      categoriser would now class those rows `unchanged` — nothing is created —
 *      and `lead.autoMail.status === 'sent'` refuses a second introduction.
 *      This is what actually guarantees no duplicate leads and no duplicate
 *      emails; the first two mechanisms only make the work cheaper.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { config } from '../config/index.js'
import { ImportJob, IMPORT_LOCK_TTL_MS } from '../models/importJob.model.js'
import { User } from '../models/user.model.js'
import { createContextLogger } from '../utils/logger.js'
import { IMPORT_STATUS, IMPORT_STEP } from '../modules/import/constants/importConstants.js'
import { prepare, resolveTemplate } from '../modules/leads/controllers/workbookSync.controller.js'
import { completeJob, syncWorkbook } from '../modules/leads/services/workbookSync.service.js'
import { recordUse } from '../modules/templates/services/template.service.js'
import { resolveContext } from '../modules/provider/services/provider.service.js'

const log = createContextLogger('workbook-queue')

/**
 * Where uploaded workbooks live while a job needs them.
 *
 * Resolved from the backend package root rather than `process.cwd()`, so the
 * location is the same whether the process was started by `npm start`, by PM2
 * from the repository root, or by a systemd unit with no working directory set.
 * A job that outlives a restart must find its file where it left it.
 */
export const WORKBOOK_STORAGE_ROOT = config.storage.workbooks

/** How often an idle worker looks for something to do. */
const POLL_INTERVAL_MS = 2_000

/** Raised to unwind a run that the operator cancelled. */
class CancelledError extends Error {
  constructor() {
    super('The import was cancelled.')
    this.name = 'CancelledError'
  }
}

let timer = null
let isRunning = false
let isStopping = false

// ---------------------------------------------------------------------------
// File storage
// ---------------------------------------------------------------------------

/**
 * Writes the uploaded bytes where a worker can find them.
 *
 * The job id is the filename, so two uploads of `today.xlsx` cannot collide and
 * a stray file is always traceable to its job.
 */
async function storeFile({ jobId, buffer }) {
  await mkdir(WORKBOOK_STORAGE_ROOT, { recursive: true })

  const relative = `${jobId}.xlsx`
  const absolute = path.resolve(WORKBOOK_STORAGE_ROOT, relative)

  // The name is ours, not the uploader's, but the resolved path is re-checked
  // anyway — a single sanitiser is a single point of failure.
  if (!absolute.startsWith(WORKBOOK_STORAGE_ROOT + path.sep)) {
    throw new Error('The workbook storage path is not valid.')
  }

  await writeFile(absolute, buffer)

  return relative
}

/** Reads a stored workbook back. */
async function readStoredFile(relative) {
  const absolute = path.resolve(WORKBOOK_STORAGE_ROOT, relative)

  if (!absolute.startsWith(WORKBOOK_STORAGE_ROOT + path.sep)) {
    throw new Error('The workbook storage path is not valid.')
  }

  return readFile(absolute)
}

/**
 * Removes a finished job's file.
 *
 * Never throws: the job is already complete, and a leftover file is a housekeeping
 * problem, not a reason to report a successful import as failed.
 */
async function discardFile(relative) {
  if (!relative) return

  try {
    await unlink(path.resolve(WORKBOOK_STORAGE_ROOT, relative))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log.warn('A finished workbook file could not be removed', { file: relative, error: error.message })
    }
  }
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Accepts a workbook and returns immediately.
 *
 * Everything expensive — parsing, comparison, writing, sending — happens in the
 * worker. This function does no more than persist the bytes and the options.
 *
 * @param {{ owner, createdBy, buffer: Buffer, filename: string, options: object }} params
 * @returns {Promise<object>} The queued ImportJob.
 */
export async function enqueueWorkbookSync({ owner, createdBy = null, buffer, filename, options }) {
  const job = await ImportJob.create({
    owner,
    createdBy,
    filename,
    fileSize: buffer.length,
    format: 'xlsx',
    sheetName: options.sheet,
    status: IMPORT_STATUS.QUEUED,
    step: IMPORT_STEP.IMPORT,
    background: {
      isBackground: true,
      phase: 'queued',
      queuedAt: new Date(),
      options,
    },
  })

  try {
    job.background.storedFile = await storeFile({ jobId: job._id.toString(), buffer })
    await job.save()
  } catch (error) {
    // A job whose file could not be written can never run, so it is failed here
    // rather than left queued for a worker that will only fail on it repeatedly.
    job.status = IMPORT_STATUS.FAILED
    job.lastError = { message: `The upload could not be stored: ${error.message}`, occurredAt: new Date() }
    await job.save()
    throw error
  }

  log.info('Workbook queued', {
    job: job._id.toString(),
    filename,
    sheet: options.sheet,
    bytes: buffer.length,
  })

  // Woken immediately rather than waiting for the next poll, so a small
  // workbook feels instant.
  void tick()

  return job
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * Takes ownership of one job, atomically.
 *
 * `findOneAndUpdate` is the whole concurrency story: two workers issuing this
 * at the same moment, one wins, because the filter requires the lock to be
 * absent or stale and the update sets it. The loser matches nothing.
 *
 * A stale lock — older than the TTL — belongs to a process that died, and is
 * reclaimable. That is what makes a crashed run resume rather than wedge.
 */
async function claimNextJob() {
  const staleBefore = new Date(Date.now() - IMPORT_LOCK_TTL_MS)

  return ImportJob.findOneAndUpdate(
    {
      'background.isBackground': true,
      status: { $in: [IMPORT_STATUS.QUEUED, IMPORT_STATUS.RUNNING] },
      $or: [{ lockedAt: null }, { lockedAt: { $lt: staleBefore } }],
    },
    {
      $set: {
        status: IMPORT_STATUS.RUNNING,
        lockedAt: new Date(),
        'background.phase': 'comparing',
        startedAt: new Date(),
      },
      $inc: { 'background.attempts': 1 },
    },
    { new: true, sort: { 'background.queuedAt': 1 } },
  )
}

/**
 * Reads the cancel flag without loading the whole document.
 *
 * The lock itself is refreshed by the progress writes rather than by a separate
 * heartbeat: they already run every chunk of rows and every ten messages, which
 * is at most twenty-one seconds apart against a ten-minute TTL.
 */
async function isCancelled(jobId) {
  const job = await ImportJob.findById(jobId).select('background.cancelRequested')
  return Boolean(job?.background?.cancelRequested)
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Runs one claimed job to completion.
 *
 * The body of this function is the same sequence the synchronous endpoint
 * performs, in the same order, through the same services. The additions are the
 * progress writes and the cancellation checks between them.
 */
async function runJob(job) {
  const jobId = job._id
  const options = job.background?.options ?? {}

  log.info('Workbook run starting', {
    job: jobId.toString(),
    attempt: job.background?.attempts,
    resumingFrom: job.cursor ?? 0,
  })

  const buffer = await readStoredFile(job.background.storedFile)
  const { parsed, rows, mapping, classified } = prepare({ buffer, options })

  await ImportJob.updateOne(
    { _id: jobId },
    {
      $set: {
        headers: parsed.headers,
        'background.totalRows': rows.length,
        'background.phase': 'creating',
      },
    },
  )

  // The owner is loaded so the provider layer can resolve a mailbox exactly as
  // it does for a request — `resolveContext` reads `auth.user` and finds the
  // Outlook account itself.
  const user = await User.findById(job.owner)
  if (!user) throw new Error('The owner of this import no longer exists.')

  const template = await resolveTemplate({
    owner: job.owner,
    templateId: options.templateId,
    sendMail: options.sendMail !== false,
  })

  let provider = null
  let mailbox = null

  if (options.sendMail !== false) {
    const context = await resolveContext({ auth: { user }, createIfMissing: true })
    provider = context.provider
    mailbox = context.mailbox
  }

  if (await isCancelled(jobId)) throw new CancelledError()

  /**
   * Progress, written between chunks.
   *
   * `syncWorkbook` has always accepted this hook; the synchronous endpoint
   * simply never passed one. So reporting progress required no change to the
   * import logic at all.
   */
  const onProgress = async (snapshot) => {
    if (snapshot.mailing) {
      await ImportJob.updateOne(
        { _id: jobId },
        {
          $set: {
            'background.phase': 'mailing',
            'background.emailsSent': snapshot.sent ?? 0,
            lockedAt: new Date(),
          },
        },
      )
    } else {
      await ImportJob.updateOne(
        { _id: jobId },
        {
          $set: {
            'background.phase': 'creating',
            'background.processedRows': snapshot.processed ?? 0,
            'background.totalRows': snapshot.total ?? rows.length,
            'progress.imported': snapshot.created ?? 0,
            'progress.updated': snapshot.modified ?? 0,
            lockedAt: new Date(),
          },
        },
      )
    }

    // Checked here because this is the only point the import yields between
    // units of work. Stopping mid-chunk would leave the cursor describing rows
    // that were only half applied.
    if (await isCancelled(jobId)) throw new CancelledError()
  }

  const summary = await syncWorkbook({
    rows,
    mapping,
    sheetName: options.sheet,
    headerRowNumber: parsed.headerRowNumber,
    owner: job.owner,
    createdBy: job.createdBy ?? job.owner,
    importJob: jobId,
    provider,
    mailbox,
    template,
    agentName: options.agentName ?? user.displayName ?? null,
    sendMail: options.sendMail !== false,
    forceResend: options.forceResend === true,
    onProgress,
  })

  await ImportJob.updateOne(
    { _id: jobId },
    {
      $set: {
        'background.phase': 'finalising',
        'background.emailsSent': summary.emailsSent,
        'background.processedRows': summary.total,
      },
    },
  )

  // The same completion the synchronous endpoint performs.
  await completeJob({ importJob: jobId, summary })

  if (summary.emailsSent > 0) await recordUse({ id: template?._id, count: summary.emailsSent })

  await ImportJob.updateOne(
    { _id: jobId },
    { $set: { 'background.phase': 'done', lockedAt: null }, $unset: { 'background.options': '' } },
  )

  await discardFile(job.background.storedFile)

  log.info('Workbook run complete', {
    job: jobId.toString(),
    new: summary.new,
    created: summary.created,
    emailsSent: summary.emailsSent,
    corrections: classified.corrections?.length ?? 0,
    durationMs: summary.durationMs,
  })

  return summary
}

/**
 * Records a run that did not finish.
 *
 * A cancelled job and a failed job are stored differently on purpose: the first
 * is what the operator asked for, the second is something to investigate. Both
 * keep whatever the run had already written, because it is real — leads created
 * before the stop exist, and pretending otherwise would be the data loss this
 * phase is meant to avoid.
 */
async function recordFailure({ job, error }) {
  const cancelled = error instanceof CancelledError

  await ImportJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: cancelled ? IMPORT_STATUS.CANCELLED : IMPORT_STATUS.FAILED,
        'background.phase': 'done',
        finishedAt: new Date(),
        lockedAt: null,
        lastError: {
          message: cancelled
            ? 'Cancelled. Anything already imported has been kept.'
            : (error?.message ?? 'The run failed.'),
          occurredAt: new Date(),
        },
      },
    },
  )

  /**
   * A cancelled run's file goes; a failed run's file stays.
   *
   * Cancelling is a decision — the operator does not want it. A failure is not:
   * the upload is the evidence of what was attempted, and discarding it would
   * mean the one run somebody needs to look at is the one whose input no longer
   * exists. Files are capped at the upload limit and a failure is exceptional,
   * so the disk cost is bounded.
   */
  if (cancelled) await discardFile(job.background?.storedFile)

  if (cancelled) log.info('Workbook run cancelled', { job: job._id.toString() })
  else log.error('Workbook run failed', { job: job._id.toString(), error: error?.message })
}

// ---------------------------------------------------------------------------
// The worker loop
// ---------------------------------------------------------------------------

/**
 * Drains the queue.
 *
 * One job at a time, deliberately. Two concurrent workbook syncs for the same
 * owner would race on company and contact resolution, and the mail pacing that
 * protects the mailbox is per-run — two runs at once would double the rate
 * Exchange sees.
 */
export async function tick() {
  if (isRunning || isStopping) return { ran: 0 }

  isRunning = true
  let ran = 0

  try {
    for (;;) {
      if (isStopping) break

      const job = await claimNextJob()
      if (!job) break

      ran += 1

      try {
        await runJob(job)
      } catch (error) {
        await recordFailure({ job, error })
      }
    }
  } catch (error) {
    // A failure in the claim query itself, not in a run. Logged and left for the
    // next tick rather than killing the interval.
    log.error('The workbook queue could not be drained', { error: error?.message })
  } finally {
    isRunning = false
  }

  return { ran }
}

/**
 * Reclaims jobs abandoned by a process that died.
 *
 * Run once at boot. A job left `running` with no live worker is put back to
 * `queued`; the lock TTL would eventually allow this anyway, but doing it at
 * startup means a restart resumes in seconds rather than in ten minutes.
 */
export async function recoverInterruptedJobs() {
  const result = await ImportJob.updateMany(
    { 'background.isBackground': true, status: IMPORT_STATUS.RUNNING },
    { $set: { status: IMPORT_STATUS.QUEUED, lockedAt: null, 'background.phase': 'queued' } },
  )

  if (result.modifiedCount > 0) {
    log.warn('Requeued workbook runs interrupted by a restart', {
      count: result.modifiedCount,
      note: 'each resumes from its cursor; already-emailed leads are not emailed again',
    })
  }

  return result.modifiedCount
}

/** Starts the worker. Idempotent. */
export function startWorkbookWorker() {
  if (timer) return timer

  isStopping = false
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS)

  // Never keeps the process alive on its own — a shutdown should not have to
  // wait for a poll that has nothing to do.
  timer.unref()

  log.info('Workbook worker started', { pollIntervalMs: POLL_INTERVAL_MS })

  return timer
}

/**
 * Stops the worker.
 *
 * Sets the stopping flag first so an in-flight run finishes its current job
 * rather than being abandoned mid-chunk. A job still running when the process
 * exits is recovered on the next boot.
 */
export function stopWorkbookWorker() {
  isStopping = true

  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** True while a job is being processed. Used by the shutdown path. */
export const isWorkerBusy = () => isRunning

export default {
  enqueueWorkbookSync,
  startWorkbookWorker,
  stopWorkbookWorker,
  recoverInterruptedJobs,
  tick,
}
