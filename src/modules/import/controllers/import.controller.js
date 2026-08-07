/**
 * Import controller.
 *
 * One endpoint per wizard step, plus job management. Thin by design: parse HTTP
 * input, delegate, wrap in the standard envelope.
 */

import crypto from 'node:crypto'

import { z } from 'zod'

import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { ImportJob } from '../../../models/importJob.model.js'
import { ImportTemplate } from '../../../models/importTemplate.model.js'
import {
  DUPLICATE_ACTION_VALUES,
  IMPORT_FIELD_VALUES,
  IMPORT_STATUS,
  IMPORT_STEP,
  MAX_FILE_BYTES,
  MAX_ROWS,
  PREVIEW_ROWS,
} from '../constants/importConstants.js'
import { parseSpreadsheet } from '../parsers/index.js'
import { detectColumns, normaliseHeader, validateMapping } from '../services/columnDetection.service.js'
import { analyseJob, rollbackImport, runImport } from '../services/importEngine.service.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('import')

const ownerOf = (req) => req.auth.user._id

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'That is not a valid id.')

/**
 * `POST /import/upload`.
 *
 * Content arrives base64 in JSON rather than as multipart, keeping the API
 * uniform with the rest of the project and avoiding a multipart parser for one
 * route. Base64 inflates by a third, so the ceiling accounts for that.
 */
const uploadSchema = z.object({
  filename: z.string().trim().min(1, 'A filename is required.').max(255),
  content: z
    .string()
    .min(1, 'The file is empty.')
    .max(Math.ceil(MAX_FILE_BYTES * 1.4), `The file exceeds the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit.`)
    .transform((value) => value.replace(/^data:[^;,]*;base64,/, '')),
})

const mappingSchema = z.object({
  mapping: z
    .array(
      z.object({
        column: z.string().min(1),
        field: z.enum(IMPORT_FIELD_VALUES),
        manual: z.boolean().optional().default(true),
      }),
    )
    .min(1, 'Map at least one column.'),
  duplicateAction: z.enum(DUPLICATE_ACTION_VALUES).optional(),
  defaultTags: z.array(z.string().trim().min(1).max(48)).max(20).optional(),
  defaultLeadSource: z.string().trim().max(128).optional().nullable(),
  defaultLeadStatus: z.string().trim().max(64).optional().nullable(),
})

/**
 * POST /api/v1/import/upload — wizard step 1.
 *
 * Parses immediately rather than deferring, because the user needs the preview
 * and the auto-mapping on the very next screen, and a file that cannot be parsed
 * should fail now rather than three steps later.
 */
export const upload = asyncHandler(async (req, res) => {
  const { filename, content } = uploadSchema.parse(req.body)
  const owner = ownerOf(req)

  const buffer = Buffer.from(content, 'base64')

  if (buffer.length > MAX_FILE_BYTES) {
    throw ApiError.badRequest(
      `The file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB, over the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit.`,
    )
  }

  let parsed
  try {
    parsed = parseSpreadsheet(buffer, filename)
  } catch (error) {
    throw ApiError.badRequest(error.message)
  }

  if (parsed.headers.length === 0) {
    throw ApiError.badRequest('The file has no header row, so its columns cannot be identified.')
  }

  if (parsed.rows.length === 0) {
    throw ApiError.badRequest('The file has a header row but no data.')
  }

  if (parsed.rows.length > MAX_ROWS) {
    throw ApiError.badRequest(
      `The file has ${parsed.rows.length.toLocaleString()} rows, over the ${MAX_ROWS.toLocaleString()} limit. Split it and import in parts.`,
    )
  }

  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')

  // Warn rather than block: re-importing the same file is occasionally
  // deliberate, but far more often a mistake worth surfacing.
  const previous = await ImportJob.findOne({
    owner,
    fileHash,
    status: { $in: [IMPORT_STATUS.COMPLETED, IMPORT_STATUS.PARTIAL] },
  }).sort({ createdAt: -1 })

  const mapping = detectColumns(parsed.headers, parsed.rows)

  // Offer a saved template whose columns match this file.
  const signature = parsed.headers.map(normaliseHeader).filter(Boolean).sort()
  const templates = await ImportTemplate.find({ owner, isDeleted: false })

  const suggestedTemplate = templates
    .map((template) => ({ template, score: template.matchScore(signature) }))
    .filter((entry) => entry.score >= 0.6)
    .sort((a, b) => b.score - a.score)[0]

  const job = await ImportJob.create({
    owner,
    createdBy: owner,
    filename,
    fileSize: buffer.length,
    format: parsed.format,
    extensionMismatch: parsed.extensionMismatch,
    fileHash,
    step: IMPORT_STEP.PREVIEW,
    status: IMPORT_STATUS.DRAFT,
    headers: parsed.headers,
    mapping,
    rows: parsed.rows,
    sample: parsed.grid.slice(0, PREVIEW_ROWS),
    analysis: { totalRows: parsed.rows.length },
  })

  log.info('Spreadsheet uploaded', {
    jobId: job._id.toString(),
    filename,
    format: parsed.format,
    rows: parsed.rows.length,
    columns: parsed.headers.length,
    autoMapped: mapping.filter((entry) => entry.field !== '__ignore__').length,
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: `${parsed.rows.length.toLocaleString()} rows read from ${parsed.headers.length} columns.`,
    data: {
      job: job.toPublicJSON(),
      previouslyImported: previous
        ? { jobId: previous._id.toString(), at: previous.createdAt, filename: previous.filename }
        : null,
      suggestedTemplate: suggestedTemplate
        ? { ...suggestedTemplate.template.toPublicJSON(), matchScore: suggestedTemplate.score }
        : null,
    },
  })
})

/** GET /api/v1/import/jobs/:id — the wizard's state. */
export const getJob = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)

  const job = await ImportJob.findOne({ _id: id, owner: ownerOf(req) })
  if (!job) throw ApiError.notFound('No import with that id exists.')

  return sendSuccess(res, {
    message: 'Import retrieved successfully.',
    data: { job: job.toPublicJSON() },
  })
})

/** PUT /api/v1/import/jobs/:id/mapping — wizard step 3. */
export const setMapping = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)
  const body = mappingSchema.parse(req.body)

  const job = await ImportJob.findOne({ _id: id, owner: ownerOf(req) })
  if (!job) throw ApiError.notFound('No import with that id exists.')

  if (job.status !== IMPORT_STATUS.DRAFT) {
    throw ApiError.badRequest('This import has already run; its mapping cannot be changed.')
  }

  const check = validateMapping(body.mapping)

  if (!check.ok) {
    throw ApiError.validation('The mapping is incomplete.', [
      {
        field: 'mapping',
        message: 'An email column must be mapped — it is the deduplication key and the address campaigns send to.',
      },
    ])
  }

  // Column order is preserved from the file, which is what the UI displays.
  job.mapping = body.mapping.map((entry) => ({
    ...entry,
    index: job.headers.indexOf(entry.column),
    confidence: 1,
  }))

  if (body.duplicateAction) job.duplicateAction = body.duplicateAction
  if (body.defaultTags) job.defaultTags = body.defaultTags
  if (body.defaultLeadSource !== undefined) job.defaultLeadSource = body.defaultLeadSource
  if (body.defaultLeadStatus !== undefined) job.defaultLeadStatus = body.defaultLeadStatus

  job.step = IMPORT_STEP.VALIDATION
  await job.save()

  return sendSuccess(res, {
    message: `${check.mappedFields.length} column(s) mapped.`,
    data: { job: job.toPublicJSON(), mappedFields: check.mappedFields },
  })
})

/**
 * POST /api/v1/import/jobs/:id/analyse — wizard steps 4 and 5.
 *
 * Classifies every row and finds duplicates without writing anything, so the
 * user approves real numbers before the import runs.
 */
export const analyse = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)
  const owner = ownerOf(req)

  const job = await ImportJob.findOne({ _id: id, owner }).select('+rows')
  if (!job) throw ApiError.notFound('No import with that id exists.')

  if (job.mapping.length === 0) {
    throw ApiError.badRequest('Set the column mapping before analysing.')
  }

  const { analysis, issues } = await analyseJob({ job, rows: job.rows, owner })

  job.analysis = analysis
  job.issues = issues
  job.step = IMPORT_STEP.DUPLICATES
  await job.save()

  return sendSuccess(res, {
    message:
      `${analysis.validRows.toLocaleString()} ready to import, ` +
      `${analysis.duplicateExisting} already in your contacts, ` +
      `${analysis.invalidRows + analysis.missingEmail} unusable.`,
    data: { job: job.toPublicJSON() },
  })
})

/**
 * POST /api/v1/import/jobs/:id/run — wizard step 6.
 *
 * Runs synchronously and returns the finished job. A background worker would be
 * the right shape for a multi-hour job, but a 50,000-row ceiling imports in
 * seconds, and returning the real result beats making the client poll for
 * something already done.
 */
export const run = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)
  const owner = ownerOf(req)

  const job = await ImportJob.findOne({ _id: id, owner }).select('+rows')
  if (!job) throw ApiError.notFound('No import with that id exists.')

  if ([IMPORT_STATUS.COMPLETED, IMPORT_STATUS.ROLLED_BACK].includes(job.status)) {
    throw ApiError.badRequest('This import has already completed.')
  }

  if (job.rows.length === 0) {
    throw ApiError.badRequest('The parsed rows are no longer available. Upload the file again.')
  }

  // Re-analysed rather than trusting a stale classification: contacts may have
  // been created since the user last looked at the duplicate screen.
  const { prepared } = await analyseJob({ job, rows: job.rows, owner })

  const finished = await runImport({ job, prepared, owner })

  return sendSuccess(res, {
    message:
      `${finished.progress.imported.toLocaleString()} imported, ` +
      `${finished.progress.updated} updated, ` +
      `${finished.progress.skipped} skipped, ` +
      `${finished.progress.failed} failed.`,
    data: { job: finished.toPublicJSON() },
  })
})

/** POST /api/v1/import/jobs/:id/rollback. */
export const rollback = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)

  try {
    const { removed, job } = await rollbackImport({ jobId: id, owner: ownerOf(req) })

    return sendSuccess(res, {
      message: `${removed.toLocaleString()} contact(s) removed. They can be restored individually.`,
      data: { removed, job: job.toSummaryJSON() },
    })
  } catch (error) {
    throw ApiError.badRequest(error.message)
  }
})

/** GET /api/v1/import/jobs — history. */
export const listJobs = asyncHandler(async (req, res) => {
  const query = z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      status: z.string().optional(),
    })
    .parse(req.query)

  const filter = { owner: ownerOf(req) }
  if (query.status) filter.status = query.status

  const skip = (query.page - 1) * query.limit

  const [items, total] = await Promise.all([
    ImportJob.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    ImportJob.countDocuments(filter),
  ])

  return sendSuccess(res, {
    message: 'Import history retrieved successfully.',
    data: { items: items.map((job) => job.toSummaryJSON()) },
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
      hasNextPage: query.page * query.limit < total,
      hasPreviousPage: query.page > 1,
    },
  })
})

/** GET /api/v1/import/statistics — dashboard widgets. */
export const statistics = asyncHandler(async (req, res) => {
  const owner = ownerOf(req)
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const weekAgo = new Date(Date.now() - 7 * 86_400_000)

  const [facets] = await ImportJob.aggregate([
    { $match: { owner } },
    {
      $facet: {
        today: [{ $match: { createdAt: { $gte: startOfDay } } }, { $count: 'value' }],
        thisWeek: [{ $match: { createdAt: { $gte: weekAgo } } }, { $count: 'value' }],
        total: [{ $count: 'value' }],
        contactsImported: [{ $group: { _id: null, value: { $sum: '$progress.imported' } } }],
        failed: [{ $match: { status: 'failed' } }, { $count: 'value' }],
        resumable: [
          { $match: { status: { $in: ['running', 'paused', 'failed'] } } },
          { $count: 'value' },
        ],
      },
    },
  ])

  const scalar = (key) => facets?.[key]?.[0]?.value ?? 0

  const recent = await ImportJob.find({ owner }).sort({ createdAt: -1 }).limit(5)

  return sendSuccess(res, {
    message: 'Import statistics retrieved successfully.',
    data: {
      today: scalar('today'),
      thisWeek: scalar('thisWeek'),
      total: scalar('total'),
      contactsImported: scalar('contactsImported'),
      failed: scalar('failed'),
      resumable: scalar('resumable'),
      recent: recent.map((job) => job.toSummaryJSON()),
    },
  })
})

// --- Templates -------------------------------------------------------------

const templateSchema = z.object({
  name: z.string().trim().min(1, 'A template needs a name.').max(128),
  description: z.string().trim().max(1000).optional().nullable(),
  jobId: objectId.optional(),
  mapping: z.array(z.object({ column: z.string(), field: z.string() })).optional(),
})

/** POST /api/v1/import/templates — save a mapping for reuse. */
export const saveTemplate = asyncHandler(async (req, res) => {
  const body = templateSchema.parse(req.body)
  const owner = ownerOf(req)

  let mapping = body.mapping
  let headers = []
  let defaults = {}

  // Saving from a job is the common path — the user has just finished mapping.
  if (body.jobId) {
    const job = await ImportJob.findOne({ _id: body.jobId, owner })
    if (!job) throw ApiError.notFound('No import with that id exists.')

    mapping = job.mapping.map((entry) => ({ column: entry.column, field: entry.field }))
    headers = job.headers
    defaults = {
      defaultTags: job.defaultTags,
      defaultLeadSource: job.defaultLeadSource,
      defaultLeadStatus: job.defaultLeadStatus,
      duplicateAction: job.duplicateAction,
    }
  }

  if (!mapping?.length) {
    throw ApiError.badRequest('Provide a mapping, or the id of an import to copy it from.')
  }

  try {
    const template = await ImportTemplate.create({
      owner,
      createdBy: owner,
      name: body.name,
      description: body.description ?? null,
      mapping,
      // Sorted and normalised so a reordered export still matches.
      headerSignature: headers.map(normaliseHeader).filter(Boolean).sort(),
      ...defaults,
    })

    return sendSuccess(res, {
      statusCode: HTTP_STATUS.CREATED,
      message: `Template "${template.name}" saved.`,
      data: { template: template.toPublicJSON() },
    })
  } catch (error) {
    if (error?.code === 11000) {
      throw ApiError.conflict(`You already have a template named "${body.name}".`)
    }
    throw error
  }
})

/** GET /api/v1/import/templates. */
export const listTemplates = asyncHandler(async (req, res) => {
  const templates = await ImportTemplate.find({ owner: ownerOf(req), isDeleted: false }).sort({
    useCount: -1,
    name: 1,
  })

  return sendSuccess(res, {
    message: 'Templates retrieved successfully.',
    data: { items: templates.map((template) => template.toPublicJSON()) },
  })
})

/** POST /api/v1/import/jobs/:id/apply-template/:templateId. */
export const applyTemplate = asyncHandler(async (req, res) => {
  const { id, templateId } = z.object({ id: objectId, templateId: objectId }).parse(req.params)
  const owner = ownerOf(req)

  const [job, template] = await Promise.all([
    ImportJob.findOne({ _id: id, owner }),
    ImportTemplate.findOne({ _id: templateId, owner, isDeleted: false }),
  ])

  if (!job) throw ApiError.notFound('No import with that id exists.')
  if (!template) throw ApiError.notFound('No template with that id exists.')

  const byColumn = new Map(template.mapping.map((entry) => [normaliseHeader(entry.column), entry.field]))

  // Columns the template does not know about keep their auto-detected mapping
  // rather than being silently ignored.
  job.mapping = job.mapping.map((entry) => {
    const field = byColumn.get(normaliseHeader(entry.column))
    return field
      ? { ...entry.toObject?.() ?? entry, field, confidence: 1, manual: true, reason: `From template "${template.name}".` }
      : entry
  })

  job.template = template._id
  job.duplicateAction = template.duplicateAction ?? job.duplicateAction
  job.defaultTags = template.defaultTags ?? job.defaultTags
  job.defaultLeadSource = template.defaultLeadSource ?? job.defaultLeadSource
  job.defaultLeadStatus = template.defaultLeadStatus ?? job.defaultLeadStatus
  await job.save()

  template.useCount += 1
  template.lastUsedAt = new Date()
  await template.save()

  return sendSuccess(res, {
    message: `Template "${template.name}" applied.`,
    data: { job: job.toPublicJSON() },
  })
})

/** DELETE /api/v1/import/templates/:id. */
export const deleteTemplate = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)

  const template = await ImportTemplate.findOneAndUpdate(
    { _id: id, owner: ownerOf(req), isDeleted: false },
    { $set: { isDeleted: true } },
    { new: true },
  )

  if (!template) throw ApiError.notFound('No template with that id exists.')

  return sendSuccess(res, { message: 'Template deleted.', data: { id, deleted: true } })
})

export default {
  upload,
  getJob,
  setMapping,
  analyse,
  run,
  rollback,
  listJobs,
  statistics,
  saveTemplate,
  listTemplates,
  applyTemplate,
  deleteTemplate,
}
