/**
 * The morning workbook endpoints.
 *
 * Kept beside the Phase 8 import controller rather than inside it: that
 * controller's endpoints are unchanged and still behave exactly as before, and
 * mixing a second execution model into the same handlers is how a "safe
 * extension" turns into a rewrite.
 */

import { z } from 'zod'

import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { CampaignTemplate } from '../../../models/campaignTemplate.model.js'
import { AuditLog, AUDIT_ACTION } from '../../../models/auditLog.model.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import { ImportJob } from '../../../models/importJob.model.js'
import { Lead } from '../../../models/lead.model.js'
import { fromXlsx } from '../../contacts/utils/xlsx.js'
import { IMPORT_STATUS, IMPORT_STEP } from '../../import/constants/importConstants.js'
import { resolveContext } from '../../provider/services/provider.service.js'
import { SHEET_KIND } from '../constants/leadConstants.js'
import { classifyWorkbook } from '../services/worksheetClassifier.service.js'
import { compareWorkbook, describeComparison } from '../services/workbookCompare.service.js'
import { DEFAULT_TEMPLATE } from '../services/autoMail.service.js'
import { recordUse, resolveActiveTemplate } from '../../templates/services/template.service.js'
import { previewPurge, purgeLeads } from '../services/leadPurge.service.js'
import {
  completeJob,
  pendingIntroductions,
  resendIntroductions,
  syncWorkbook,
} from '../services/workbookSync.service.js'

const ownerOf = (req) => req.auth.user._id
const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'That is not a valid id.')

const mappingSchema = z.array(
  z.object({
    column: z.string(),
    index: z.coerce.number().int().min(0),
    field: z.string(),
  }),
)

/** `POST /leads/workbook/sync` options, carried in `X-Import-Options`. */
const syncSchema = z.object({
  sheet: z.string().min(1),
  mapping: mappingSchema.optional(),

  /** Compare and report; write nothing, send nothing. */
  dryRun: z.boolean().optional().default(false),

  /** Master switch for this run. */
  sendMail: z.boolean().optional().default(true),

  /**
   * Re-send to leads already emailed.
   *
   * Defaults OFF and stays off unless a human ticks the box. This is the only
   * way past the guarantee that a customer is never introduced twice.
   */
  forceResend: z.boolean().optional().default(false),

  /** A saved template to introduce with. Falls back to the built-in one. */
  templateId: objectId.optional(),

  /** Substituted into `{{Agent}}`. */
  agentName: z.string().trim().max(120).optional(),
})

/**
 * Reads the uploaded file off the request.
 *
 * The route mounts `express.raw`, so the body is already a Buffer — the same
 * approach the Phase 8 importer uses.
 */
function fileFrom(req) {
  const buffer = Buffer.isBuffer(req.body) ? req.body : null
  if (!buffer || buffer.length === 0) throw ApiError.badRequest('No file was uploaded.')

  return { buffer, filename: String(req.get('x-filename') ?? 'workbook.xlsx') }
}

/**
 * Resolves the introduction template for a run.
 *
 * Phase 11 made this automatic. The operator uploads a workbook; they are never
 * asked which email to send, because "which email do we send to a new enquiry?"
 * is a decision about the business, made once on the Email Templates screen, not
 * a decision about this upload.
 *
 * `templateId` is still honoured. It was part of the Phase 10 contract and a
 * caller passing one — a re-send of a specific message, a test — must keep
 * getting that template rather than silently getting the active one.
 *
 * With no active template and none ever configured, the built-in introduction is
 * seeded and used. With templates present but none active, `resolveActiveTemplate`
 * refuses and says so: somebody deliberately turned automatic sending off, and
 * guessing which of their templates they meant would email customers wording
 * nobody chose.
 */
export async function resolveTemplate({ owner, templateId, sendMail }) {
  if (templateId) {
    const template = await CampaignTemplate.findOne({ _id: templateId, owner, isDeleted: false })
    if (!template) throw ApiError.notFound('No template with that id exists.')
    return template
  }

  // A create-only run needs no template at all, so a workspace with automatic
  // sending switched off can still import its workbook.
  if (!sendMail) return DEFAULT_TEMPLATE

  return resolveActiveTemplate({ owner })
}

/**
 * Parses the sheet and resolves the column mapping, shared by both paths.
 *
 * Exported so the background worker parses a workbook exactly as this endpoint
 * does. A second implementation there would be the one place a foreground and a
 * background run could disagree about what a file contains.
 */
export function prepare({ buffer, options }) {
  const parsed = fromXlsx(buffer, { sheet: options.sheet })
  const rows = parsed.grid.slice(parsed.headerRowNumber)

  const classified = classifyWorkbook([
    { name: options.sheet, headers: parsed.headers, rows },
  ]).sheets[0]

  if (classified.kind === SHEET_KIND.OPERATIONS && !options.mapping) {
    throw ApiError.badRequest(
      `"${options.sheet}" was identified as hotel operations data, not leads. ${classified.reason}`,
    )
  }

  const mapping = options.mapping
    ? classified.mapping.map((entry) => {
        const override = options.mapping.find((candidate) => candidate.index === entry.index)
        return override ? { ...entry, field: override.field, source: 'manual' } : entry
      })
    : classified.mapping

  return { parsed, rows, mapping, classified }
}

/**
 * POST /api/v1/leads/workbook/sync
 *
 * The daily run. Compares today's workbook against the database, creates the
 * enquiries it has never seen, and emails exactly those.
 *
 * `dryRun: true` returns the same comparison without writing or sending, so the
 * preview promises precisely what the import will do.
 */
export const sync = asyncHandler(async (req, res) => {
  const { buffer, filename } = fileFrom(req)
  const options = syncSchema.parse(JSON.parse(req.get('x-import-options') ?? '{}'))
  const owner = ownerOf(req)

  const { parsed, rows, mapping, classified } = prepare({ buffer, options })

  const common = {
    rows,
    mapping,
    sheetName: options.sheet,
    headerRowNumber: parsed.headerRowNumber,
    owner,
  }

  // --- Preview: compare only, write nothing --------------------------------
  if (options.dryRun) {
    const comparison = await compareWorkbook(common)

    return sendSuccess(res, {
      message: describeComparison(comparison.counts, options.sendMail ? comparison.mailable : 0),
      data: {
        dryRun: true,
        filename,
        sheet: options.sheet,
        corrections: classified.corrections,
        mailable: options.sendMail ? comparison.mailable : 0,
        ...comparison,
      },
    })
  }

  // --- The real run ---------------------------------------------------------
  //
  // Resolved before the import job is created, so a workspace with no active
  // template is refused cleanly rather than leaving a running job behind that
  // never sent anything.
  const template = await resolveTemplate({
    owner,
    templateId: options.templateId,
    sendMail: options.sendMail,
  })

  /**
   * The mailbox is resolved before anything is written.
   *
   * Discovering mid-run that nothing is connected would leave leads created and
   * unmailed with no explanation; resolving first lets the summary say "no
   * mailbox" honestly, and lets the run proceed as a create-only import.
   */
  let provider = null
  let mailbox = null
  let isMock = false

  if (options.sendMail) {
    const context = await resolveContext({ auth: req.auth, createIfMissing: true })
    provider = context.provider
    mailbox = context.mailbox
    isMock = context.isMock
  }

  const job = await ImportJob.create({
    owner,
    createdBy: owner,
    filename,
    fileSize: buffer.length,
    format: 'xlsx',
    sheetName: options.sheet,
    status: IMPORT_STATUS.RUNNING,
    step: IMPORT_STEP.IMPORT,
    headers: parsed.headers,
    startedAt: new Date(),
  })

  let summary
  try {
    summary = await syncWorkbook({
      ...common,
      createdBy: owner,
      importJob: job._id,
      provider,
      mailbox,
      template,
      agentName: options.agentName ?? req.auth?.user?.displayName ?? null,
      sendMail: options.sendMail,
      forceResend: options.forceResend,
    })
  } catch (error) {
    // The job is closed as failed rather than left running for ever, so the
    // history list can show what happened and a resume is possible.
    job.status = IMPORT_STATUS.FAILED
    job.finishedAt = new Date()
    job.lastError = { message: error?.message ?? 'The run failed.', occurredAt: new Date() }
    await job.save()

    // Recorded before rethrowing: a run that emailed customers and then failed
    // partway is exactly the run somebody will come looking for, and the throw
    // below would otherwise leave no trace outside the job record.
    await recordAudit({
      req,
      event: 'WORKBOOK_SEND_COMPLETED',
      result: 'failure',
      resultReason: error?.message?.slice(0, 200) ?? 'The run failed.',
      summary: `Workbook run failed for ${filename}`,
      target: { id: String(job._id), name: filename },
    })

    throw error
  }

  await completeJob({ importJob: job._id, summary })

  // Counted once per run rather than once per message: the library's "used 12×"
  // means twelve mornings, which is the useful reading.
  if (summary.emailsSent > 0) await recordUse({ id: template?._id, count: summary.emailsSent })

  /**
   * Two events for one run, because they answer different questions.
   *
   * The import is "what entered the register". The send is "who was emailed" —
   * the irreversible half — and it is only recorded when mail actually went
   * out, so a dry run does not leave an entry claiming customers were
   * contacted.
   */
  await recordAudit({
    req,
    event: 'WORKBOOK_IMPORTED',
    summary: `Synced ${filename} — ${summary.new} new, ${summary.updated} updated`,
    target: { id: String(job._id), name: filename },
    affectedCount: summary.new + summary.updated,
    metadata: {
      sheet: options.sheet ?? null,
      new: summary.new,
      updated: summary.updated,
      unchanged: summary.unchanged,
      invalid: summary.invalid,
      mockMode: isMock,
    },
  })

  if (summary.emailsSent > 0) {
    await recordAudit({
      req,
      event: 'WORKBOOK_SEND_COMPLETED',
      summary: `Sent ${summary.emailsSent} introduction(s) from ${filename}`,
      target: { id: String(job._id), name: filename },
      refs: { mailboxId: mailbox?._id ?? null },
      affectedCount: summary.emailsSent,
      metadata: {
        emailsSent: summary.emailsSent,
        emailsFailed: summary.emailsFailed ?? 0,
        templateName: template?.name ?? null,
        templateVersion: template?.version ?? null,
        mockMode: isMock,
      },
    })
  }

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message:
      `${summary.new} new, ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
      `${summary.invalid} invalid — ${summary.emailsSent} email(s) sent.`,
    data: {
      importJob: job._id.toString(),
      mockMode: isMock,
      corrections: classified.corrections,
      template: template?._id
        ? { id: template._id.toString(), name: template.name, version: template.version }
        : null,
      ...summary,
    },
  })
})

/**
 * POST /api/v1/leads/resend
 *
 * Re-sends the introduction to named leads. Always explicit, never a side
 * effect of uploading a file.
 */
export const resend = asyncHandler(async (req, res) => {
  const { leadIds, templateId, agentName } = z
    .object({
      leadIds: z.array(objectId).min(1).max(200),
      templateId: objectId.optional(),
      agentName: z.string().trim().max(120).optional(),
    })
    .parse(req.body)

  const owner = ownerOf(req)
  // A re-send is a send, so it resolves the active template exactly as the
  // morning run does when the caller does not name one.
  const template = await resolveTemplate({ owner, templateId, sendMail: true })
  const { provider, mailbox, isMock } = await resolveContext({ auth: req.auth, createIfMissing: true })

  const result = await resendIntroductions({
    owner,
    leadIds,
    provider,
    mailbox,
    template,
    agentName: agentName ?? req.auth?.user?.displayName ?? null,
    actor: owner,
  })

  return sendSuccess(res, {
    message: `${result.sent} message(s) re-sent, ${result.skipped} skipped, ${result.failed} failed.`,
    data: { mockMode: isMock, ...result },
  })
})

/** GET /api/v1/leads/workbook/history — every upload, newest first. */
export const history = asyncHandler(async (req, res) => {
  const { page, limit } = z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    })
    .parse(req.query)

  const owner = ownerOf(req)
  const skip = (page - 1) * limit

  const [items, total] = await Promise.all([
    ImportJob.find({ owner }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ImportJob.countDocuments({ owner }),
  ])

  return sendSuccess(res, {
    message: `${total} upload(s) recorded.`,
    data: { items: items.map((job) => job.toPublicJSON()) },
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

/** GET /api/v1/leads/workbook/statistics — the dashboard widgets. */
export const statistics = asyncHandler(async (req, res) => {
  const owner = ownerOf(req)

  const startOfToday = new Date()
  startOfToday.setUTCHours(0, 0, 0, 0)

  const [lastJob, todaysJobs, pending, emailedToday] = await Promise.all([
    ImportJob.findOne({ owner }).sort({ createdAt: -1 }),
    ImportJob.find({ owner, createdAt: { $gte: startOfToday } }).sort({ createdAt: -1 }),
    pendingIntroductions({ owner }),
    Lead.countDocuments({ owner, isDeleted: false, 'autoMail.sentAt': { $gte: startOfToday } }),
  ])

  const todays = todaysJobs.reduce(
    (sum, job) => ({
      uploads: sum.uploads + 1,
      new: sum.new + (job.syncSummary?.new ?? 0),
      updated: sum.updated + (job.syncSummary?.updated ?? 0),
    }),
    { uploads: 0, new: 0, updated: 0 },
  )

  return sendSuccess(res, {
    message: 'Workbook statistics retrieved.',
    data: {
      todaysWorkbook: todaysJobs[0]?.filename ?? null,
      todaysUploads: todays.uploads,
      lastUpload: lastJob
        ? {
            filename: lastJob.filename,
            sheet: lastJob.sheetName,
            at: lastJob.createdAt,
            status: lastJob.status,
            durationMs: lastJob.durationMs,
            summary: lastJob.syncSummary,
          }
        : null,
      newLeadsToday: todays.new,
      updatedLeadsToday: todays.updated,
      /** Counted from the leads themselves, so it survives a job being deleted. */
      emailsSentToday: emailedToday,
      pendingEmails: pending,
      lastImportDurationMs: lastJob?.durationMs ?? null,
    },
  })
})

// ---------------------------------------------------------------------------
// Bulk delete
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/leads/purge-preview
 *
 * What a purge would remove. The confirmation dialog shows a measured number
 * rather than a guessed one, because "delete 1,671 leads" is a materially
 * different decision from "delete 3".
 */
export const purgePreview = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Purge preview retrieved.',
    data: await previewPurge({ owner: ownerOf(req) }),
  }),
)

/**
 * DELETE /api/v1/leads/all
 *
 * Removes every lead and only lead data. A development convenience, guarded by
 * role and by an audit record.
 *
 * Companies, contacts, campaigns, mail history, conversations, import history
 * and every authentication record survive. The five collections that carry a
 * `lead` reference are unlinked rather than deleted, so nothing is left
 * pointing at a document that no longer exists.
 */
export const deleteAll = asyncHandler(async (req, res) => {
  const owner = ownerOf(req)
  const actor = req.auth.user

  const result = await purgeLeads({ owner })

  /**
   * Nothing to delete is a success.
   *
   * The caller asked for an empty register and an empty register is what they
   * have. Returning an error for a request that achieved its purpose would be
   * wrong, and would make the button appear broken on a clean database.
   */
  if (result.empty) {
    return sendSuccess(res, {
      message: 'No Leads available.',
      data: {
        deletedLeads: 0,
        duration: result.durationMs,
        timestamp: result.timestamp,
        detail: result.detail,
      },
    })
  }

  await AuditLog.record({
    owner,
    actor: actor._id,
    actorEmail: actor.email ?? null,
    actorRole: actor.role ?? null,
    action: AUDIT_ACTION.LEADS_BULK_DELETE,
    summary: `Deleted all ${result.deletedLeads} lead(s)`,
    affectedCount: result.deletedLeads,
    detail: result.detail,
    durationMs: result.durationMs,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.id ?? null,
  })

  return sendSuccess(res, {
    message: `All Leads deleted successfully. ${result.deletedLeads} lead(s) removed.`,
    data: {
      deletedLeads: result.deletedLeads,
      duration: result.durationMs,
      timestamp: result.timestamp,
      detail: result.detail,
    },
  })
})
