/**
 * Email template endpoints.
 *
 * The library, its lifecycle, and the two rendering endpoints the editor needs:
 * a live preview against a real lead, and a test send to an address the user
 * types. Both render through exactly the same function the morning run uses, so
 * a preview cannot promise something a send would not produce.
 */

import { z } from 'zod'

import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import { CampaignTemplate } from '../../../models/campaignTemplate.model.js'
import { Lead } from '../../../models/lead.model.js'
import { createContextLogger } from '../../../utils/logger.js'
import { TEMPLATE_CATEGORY_VALUES } from '../../campaigns/constants/campaignConstants.js'
import { resolveContext } from '../../provider/services/provider.service.js'
import { TEMPLATE_LIMITS, TEMPLATE_STATUS, TEMPLATE_STATUS_VALUES } from '../constants/templateConstants.js'
import { sampleLead, variableCatalogue } from '../services/leadVariables.service.js'
import * as service from '../services/template.service.js'

const log = createContextLogger('templates')

const ownerOf = (req) => req.auth.user._id
const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'That is not a valid id.')

/** Statuses a client may ask for on create. `active` goes through activation. */
const writableStatus = z.enum([TEMPLATE_STATUS.DRAFT, TEMPLATE_STATUS.INACTIVE, TEMPLATE_STATUS.ACTIVE])

const templateBody = z.object({
  name: z.string().trim().min(1, 'A template needs a name.').max(TEMPLATE_LIMITS.NAME),
  description: z.string().trim().max(TEMPLATE_LIMITS.DESCRIPTION).nullish(),
  category: z.enum(TEMPLATE_CATEGORY_VALUES).optional(),
  subject: z.string().trim().min(1, 'A template needs a subject line.').max(TEMPLATE_LIMITS.SUBJECT),
  bodyHtml: z.string().min(1, 'A template needs a message body.').max(TEMPLATE_LIMITS.BODY),
  bodyText: z.string().max(TEMPLATE_LIMITS.BODY).optional(),
  status: writableStatus.optional(),
})

/** Every field optional — a PATCH-shaped PUT, so the editor can save one field. */
const templatePatch = templateBody.partial()

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/** GET /api/v1/templates */
export const list = asyncHandler(async (req, res) => {
  const { status, category, search, includeArchived } = z
    .object({
      status: z.enum(TEMPLATE_STATUS_VALUES).optional(),
      category: z.enum(TEMPLATE_CATEGORY_VALUES).optional(),
      search: z.string().trim().max(200).optional(),
      includeArchived: z.coerce.boolean().optional().default(false),
    })
    .parse(req.query)

  const filter = { owner: ownerOf(req), isDeleted: false }

  if (status) filter.status = status
  // Archived templates are kept for the record, not for browsing. They are out
  // of the way by default and one checkbox away when someone wants them.
  else if (!includeArchived) filter.status = { $ne: TEMPLATE_STATUS.ARCHIVED }

  if (category) filter.category = category

  if (search) {
    const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    filter.$or = [{ name: pattern }, { subject: pattern }, { description: pattern }]
  }

  /**
   * The active template sorts first, always.
   *
   * It is the one that answers "what are we sending customers?", which is the
   * question anyone opening this screen came to ask.
   */
  const items = await CampaignTemplate.find(filter).sort({ status: 1, updatedAt: -1 })
  const ordered = [
    ...items.filter((item) => item.status === TEMPLATE_STATUS.ACTIVE),
    ...items.filter((item) => item.status !== TEMPLATE_STATUS.ACTIVE),
  ]

  return sendSuccess(res, {
    message: `${ordered.length} template(s) retrieved.`,
    data: {
      items: ordered.map((item) => item.toSummaryJSON()),
      activeTemplate: ordered.find((item) => item.status === TEMPLATE_STATUS.ACTIVE)?.name ?? null,
    },
  })
})

/**
 * GET /api/v1/templates/active
 *
 * What the morning run would send. Reports the absence rather than erroring —
 * the dashboard asks this to decide whether to warn, and a warning widget that
 * throws is not much of a warning.
 */
export const active = asyncHandler(async (req, res) => {
  const template = await CampaignTemplate.findOne({
    owner: ownerOf(req),
    status: TEMPLATE_STATUS.ACTIVE,
    isDeleted: false,
  })

  return sendSuccess(res, {
    message: template
      ? `"${template.name}" is active and will be sent to new enquiries.`
      : 'No template is active. Automatic sending is paused.',
    data: {
      hasActiveTemplate: Boolean(template),
      template: template ? template.toPublicJSON() : null,
    },
  })
})

/** GET /api/v1/templates/variables — the picker's catalogue. */
export const variables = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Template variables retrieved.',
    data: { variables: variableCatalogue() },
  }),
)

/** GET /api/v1/templates/:id */
export const getById = asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id)

  const template = await CampaignTemplate.findOne({ _id: id, owner: ownerOf(req), isDeleted: false })
  if (!template) throw ApiError.notFound('No template with that id exists.')

  return sendSuccess(res, {
    message: 'Template retrieved.',
    data: { template: template.toPublicJSON() },
  })
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** POST /api/v1/templates */
export const create = asyncHandler(async (req, res) => {
  const data = templateBody.parse(req.body)

  const template = await service.createTemplate({
    owner: ownerOf(req),
    actor: req.auth.user._id,
    data,
  })

  await recordAudit({
    req,
    event: 'TEMPLATE_CREATED',
    summary: `Created the template "${template.name}"`,
    target: { id: String(template._id), name: template.name },
    // Never the body. A template is the message text sent to customers, and
    // copying it into every audit entry would duplicate the whole template
    // library into the log on each edit.
    metadata: { status: template.status ?? null },
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: `Template "${template.name}" created.`,
    data: { template: template.toPublicJSON() },
  })
})

/** PUT /api/v1/templates/:id */
export const update = asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id)
  const data = templatePatch.parse(req.body)

  const template = await service.updateTemplate({
    owner: ownerOf(req),
    id,
    actor: req.auth.user._id,
    data,
  })

  await recordAudit({
    req,
    event: 'TEMPLATE_UPDATED',
    summary: `Updated the template "${template.name}" to version ${template.version}`,
    target: { id: String(template._id), name: template.name },
    metadata: {
      version: template.version,
      status: template.status ?? null,
      changedFields: Object.keys(data),
    },
  })

  return sendSuccess(res, {
    message:
      template.status === TEMPLATE_STATUS.ACTIVE
        ? `"${template.name}" saved as version ${template.version}. New enquiries will receive this wording; messages already sent are unchanged.`
        : `Template "${template.name}" saved.`,
    data: { template: template.toPublicJSON() },
  })
})

/** POST /api/v1/templates/:id/duplicate */
export const duplicate = asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id)

  const template = await service.duplicateTemplate({
    owner: ownerOf(req),
    id,
    actor: req.auth.user._id,
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: `Copied to "${template.name}" as a draft.`,
    data: { template: template.toPublicJSON() },
  })
})

/** POST /api/v1/templates/:id/activate */
export const activate = asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id)

  const { template, deactivated } = await service.activateTemplate({
    owner: ownerOf(req),
    id,
    actor: req.auth.user._id,
  })

  /**
   * Critical, not routine.
   *
   * Activating a template changes the message every new enquiry receives,
   * unattended. "Why did customers get that wording last Tuesday" is answered
   * here or nowhere, so the entry names what was switched off as well as on.
   */
  await recordAudit({
    req,
    event: 'TEMPLATE_ACTIVATED',
    summary: `Made "${template.name}" the active template`,
    target: { id: String(template._id), name: template.name },
    affectedCount: deactivated.length,
    metadata: { deactivated: deactivated.map((entry) => entry.name) },
  })

  return sendSuccess(res, {
    message:
      deactivated.length > 0
        ? `"${template.name}" is now active. "${deactivated.map((entry) => entry.name).join('", "')}" was deactivated.`
        : `"${template.name}" is now active and will be sent to every new enquiry.`,
    data: { template: template.toPublicJSON(), deactivated },
  })
})

/** POST /api/v1/templates/:id/deactivate */
export const deactivate = asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id)

  const { template, stoppedAutomation } = await service.setStatus({
    owner: ownerOf(req),
    id,
    status: TEMPLATE_STATUS.INACTIVE,
  })

  return sendSuccess(res, {
    message: stoppedAutomation
      ? `"${template.name}" is no longer active. No template is active, so new enquiries will not be emailed automatically until one is.`
      : `"${template.name}" is inactive.`,
    data: { template: template.toPublicJSON(), stoppedAutomation },
  })
})

/** POST /api/v1/templates/:id/archive */
export const archive = asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id)

  const { template, stoppedAutomation } = await service.setStatus({
    owner: ownerOf(req),
    id,
    status: TEMPLATE_STATUS.ARCHIVED,
  })

  return sendSuccess(res, {
    message: stoppedAutomation
      ? `"${template.name}" is archived. No template is active, so new enquiries will not be emailed automatically until one is.`
      : `"${template.name}" is archived.`,
    data: { template: template.toPublicJSON(), stoppedAutomation },
  })
})

/** POST /api/v1/templates/:id/restore — archived back to inactive. */
export const restore = asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id)

  const { template } = await service.setStatus({
    owner: ownerOf(req),
    id,
    status: TEMPLATE_STATUS.INACTIVE,
  })

  return sendSuccess(res, {
    message: `"${template.name}" restored. Activate it to start sending it.`,
    data: { template: template.toPublicJSON() },
  })
})

/** DELETE /api/v1/templates/:id — drafts only. */
export const remove = asyncHandler(async (req, res) => {
  const id = objectId.parse(req.params.id)

  const template = await service.deleteTemplate({ owner: ownerOf(req), id })

  await recordAudit({
    req,
    event: 'TEMPLATE_DELETED',
    summary: `Deleted the template "${template.name}"`,
    target: { id, name: template.name },
    affectedCount: 1,
  })

  return sendSuccess(res, {
    message: `Draft "${template.name}" deleted.`,
    data: { id, deleted: true },
  })
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Resolves the lead a preview renders against.
 *
 * A named lead, the most recent real one, or the sample. Preferring a real lead
 * is the point of the feature: a template looks fine against invented data and
 * reveals its problems against the register's actual contents.
 */
async function previewLead({ owner, leadId }) {
  if (leadId) {
    const lead = await Lead.findOne({ _id: leadId, owner, isDeleted: false })
    if (!lead) throw ApiError.notFound('No enquiry with that id exists.')
    return { lead, isSample: false }
  }

  const latest = await Lead.findOne({ owner, isDeleted: false }).sort({ createdAt: -1 })
  if (latest) return { lead: latest, isSample: false }

  return { lead: sampleLead(), isSample: true }
}

/**
 * POST /api/v1/templates/preview
 *
 * Renders a template against a lead. Accepts either a saved template's id or
 * unsaved content, so the editor can preview what is on screen rather than what
 * was last saved.
 */
export const preview = asyncHandler(async (req, res) => {
  const { templateId, leadId, subject, bodyHtml, bodyText } = z
    .object({
      templateId: objectId.optional(),
      leadId: objectId.optional(),
      subject: z.string().max(TEMPLATE_LIMITS.SUBJECT).optional(),
      bodyHtml: z.string().max(TEMPLATE_LIMITS.BODY).optional(),
      bodyText: z.string().max(TEMPLATE_LIMITS.BODY).optional(),
    })
    .parse(req.body)

  const owner = ownerOf(req)

  let source = { subject, bodyHtml, bodyText }
  let template = null

  if (templateId) {
    template = await CampaignTemplate.findOne({ _id: templateId, owner, isDeleted: false })
    if (!template) throw ApiError.notFound('No template with that id exists.')

    // Unsaved edits win, so the preview shows what is on screen.
    source = {
      subject: subject ?? template.subject,
      bodyHtml: bodyHtml ?? template.bodyHtml,
      bodyText: bodyText ?? template.bodyText,
    }
  }

  if (!source.subject?.trim() || !source.bodyHtml?.trim()) {
    throw ApiError.badRequest('A preview needs a subject and a body.')
  }

  const { lead, isSample } = await previewLead({ owner, leadId })
  const rendered = service.renderForLead({ template: source, lead })

  return sendSuccess(res, {
    message: isSample
      ? 'Rendered with sample data — the register has no enquiries yet.'
      : `Rendered with enquiry ${lead.reference}.`,
    data: {
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      values: rendered.values,
      unresolved: rendered.unresolved,
      isSample,
      lead: isSample
        ? { reference: lead.reference, contactPerson: lead.contactPerson, companyName: lead.companyName }
        : {
            id: lead._id.toString(),
            reference: lead.reference,
            contactPerson: lead.contactPerson,
            companyName: lead.companyName,
            email: lead.email,
          },
      template: template ? { id: template._id.toString(), name: template.name, version: template.version } : null,
    },
  })
})

/**
 * POST /api/v1/templates/test-email
 *
 * Sends the template to an address the user types, rendered with sample data.
 *
 * **Nothing is recorded.** No mail history row, no lead touched, no counter
 * incremented. A test send is the operator checking their own work; treating it
 * as customer correspondence would put a message to their own inbox in the
 * audit trail as though a customer had received it, and — worse — a test
 * against a real lead's data could mark that lead as contacted.
 */
export const testEmail = asyncHandler(async (req, res) => {
  const { to, templateId, subject, bodyHtml, bodyText } = z
    .object({
      to: z.string().trim().email('That is not a valid email address.'),
      templateId: objectId.optional(),
      subject: z.string().max(TEMPLATE_LIMITS.SUBJECT).optional(),
      bodyHtml: z.string().max(TEMPLATE_LIMITS.BODY).optional(),
      bodyText: z.string().max(TEMPLATE_LIMITS.BODY).optional(),
    })
    .parse(req.body)

  const owner = ownerOf(req)

  let source = { subject, bodyHtml, bodyText }
  let template = null

  if (templateId) {
    template = await CampaignTemplate.findOne({ _id: templateId, owner, isDeleted: false })
    if (!template) throw ApiError.notFound('No template with that id exists.')

    source = {
      subject: subject ?? template.subject,
      bodyHtml: bodyHtml ?? template.bodyHtml,
      bodyText: bodyText ?? template.bodyText,
    }
  }

  if (!source.subject?.trim() || !source.bodyHtml?.trim()) {
    throw ApiError.badRequest('A test email needs a subject and a body.')
  }

  const rendered = service.renderForLead({ template: source, lead: sampleLead() })

  const { provider, mailbox, isMock } = await resolveContext({ auth: req.auth, createIfMissing: true })

  await provider.send(
    {
      to: [{ address: to, name: null }],
      // Marked in the subject so a test can never be mistaken for the real
      // thing, by the operator or by anyone else who sees the message.
      subject: `[TEST] ${rendered.subject}`,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
    },
    { mailbox },
  )

  log.info('Test email sent', {
    to,
    template: template ? String(template._id) : 'unsaved',
    mock: isMock,
  })

  return sendSuccess(res, {
    message: `Test email sent to ${to}. It was not recorded in mail history and no enquiry was touched.`,
    data: {
      to,
      mockMode: isMock,
      subject: rendered.subject,
      unresolved: rendered.unresolved,
      recorded: false,
    },
  })
})

export default {
  list,
  active,
  variables,
  getById,
  create,
  update,
  duplicate,
  activate,
  deactivate,
  archive,
  restore,
  remove,
  preview,
  testEmail,
}
