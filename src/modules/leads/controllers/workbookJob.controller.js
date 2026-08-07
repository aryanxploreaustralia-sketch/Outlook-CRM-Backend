/**
 * Background workbook endpoints.
 *
 * Upload returns a job id and nothing else; the run happens in a worker and the
 * client polls for progress. The synchronous `POST /leads/workbook/sync` is
 * untouched and still behaves exactly as before — a caller that wants to wait
 * for the summary can still do so.
 */

import { z } from 'zod'

import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { ImportJob } from '../../../models/importJob.model.js'
import { IMPORT_STATUS } from '../../import/constants/importConstants.js'
import { enqueueWorkbookSync } from '../../../jobs/workbookQueue.service.js'

const ownerOf = (req) => req.auth.user._id
const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'That is not a valid id.')

/**
 * Options for a background run, carried in `X-Import-Options`.
 *
 * Deliberately the same shape the synchronous endpoint accepts, minus `dryRun`:
 * a preview writes nothing and returns in milliseconds, so queueing one would
 * add latency to the one operation that does not need it. Previews stay on the
 * synchronous endpoint.
 */
const queueSchema = z.object({
  sheet: z.string().min(1),
  mapping: z
    .array(z.object({ column: z.string(), index: z.coerce.number().int().min(0), field: z.string() }))
    .optional(),
  sendMail: z.boolean().optional().default(true),
  forceResend: z.boolean().optional().default(false),
  templateId: objectId.optional(),
  agentName: z.string().trim().max(120).optional(),
})

/** Statuses a job can still move on from. */
const IN_FLIGHT = new Set([IMPORT_STATUS.QUEUED, IMPORT_STATUS.RUNNING])

/**
 * POST /api/v1/workbook/sync
 *
 * Accepts the file and returns immediately. The response carries the job id and
 * nothing about the outcome, because at this point there is no outcome — that
 * is the entire purpose of the endpoint.
 *
 * `202 Accepted` rather than `201`: the request has been accepted for
 * processing, which is precisely what has happened and precisely what 202 means.
 */
export const enqueue = asyncHandler(async (req, res) => {
  const buffer = Buffer.isBuffer(req.body) ? req.body : null
  if (!buffer || buffer.length === 0) throw ApiError.badRequest('No file was uploaded.')

  const options = queueSchema.parse(JSON.parse(req.get('x-import-options') ?? '{}'))
  const owner = ownerOf(req)

  const job = await enqueueWorkbookSync({
    owner,
    createdBy: owner,
    buffer,
    filename: String(req.get('x-filename') ?? 'workbook.xlsx'),
    options,
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.ACCEPTED,
    message: 'The workbook is queued. Progress is available while it runs.',
    data: {
      jobId: job._id.toString(),
      status: job.status,
      sheet: options.sheet,
      filename: job.filename,
      queuedAt: job.background.queuedAt,
    },
  })
})

/**
 * GET /api/v1/workbook/jobs/:id
 *
 * Live progress. Polled every couple of seconds while a run is in flight, so it
 * reads one document and returns only what a progress bar needs.
 */
export const status = asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id)

  const job = await ImportJob.findOne({ _id: id, owner: ownerOf(req) })
  if (!job) throw ApiError.notFound('No import job with that id exists.')

  return sendSuccess(res, {
    message: 'Import job status retrieved.',
    data: job.toJobStatusJSON(),
  })
})

/** GET /api/v1/workbook/jobs — background runs, newest first. */
export const list = asyncHandler(async (req, res) => {
  const { limit, active } = z
    .object({
      limit: z.coerce.number().int().min(1).max(50).optional().default(10),
      active: z.coerce.boolean().optional().default(false),
    })
    .parse(req.query)

  const filter = { owner: ownerOf(req), 'background.isBackground': true }
  if (active) filter.status = { $in: [...IN_FLIGHT] }

  const items = await ImportJob.find(filter).sort({ createdAt: -1 }).limit(limit)

  return sendSuccess(res, {
    message: `${items.length} background run(s) retrieved.`,
    data: { items: items.map((job) => job.toJobStatusJSON()) },
  })
})

/**
 * POST /api/v1/workbook/jobs/:id/cancel
 *
 * Asks the worker to stop at the next chunk boundary.
 *
 * A request rather than an instruction, and the response says so. The worker is
 * mid-chunk when this arrives; stopping there would leave the cursor describing
 * rows only half applied. Whatever the run has already written is kept — those
 * leads exist and those customers were emailed, and reporting otherwise would
 * be a lie about the outside world.
 */
export const cancel = asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id)
  const owner = ownerOf(req)

  const job = await ImportJob.findOne({ _id: id, owner })
  if (!job) throw ApiError.notFound('No import job with that id exists.')

  if (!IN_FLIGHT.has(job.status)) {
    return sendSuccess(res, {
      message: `This run has already finished (${job.status}). There is nothing to cancel.`,
      data: job.toJobStatusJSON(),
    })
  }

  /**
   * A queued job is cancelled outright.
   *
   * No worker has claimed it, so there is nothing to ask — and leaving it
   * `queued` with a flag set would let a worker pick it up in the moment
   * between the two writes.
   */
  if (job.status === IMPORT_STATUS.QUEUED) {
    job.status = IMPORT_STATUS.CANCELLED
    job.background.cancelRequested = true
    job.background.phase = 'done'
    job.finishedAt = new Date()
    job.lastError = { message: 'Cancelled before it started.', occurredAt: new Date() }
    await job.save()

    return sendSuccess(res, {
      message: 'The queued run was cancelled. Nothing had been imported.',
      data: job.toJobStatusJSON(),
    })
  }

  job.background.cancelRequested = true
  await job.save()

  return sendSuccess(res, {
    message:
      'Cancelling. The run stops at the end of the current batch; anything already imported is kept.',
    data: job.toJobStatusJSON(),
  })
})

export default { enqueue, status, list, cancel }
