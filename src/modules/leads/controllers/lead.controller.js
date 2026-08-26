/**
 * Lead, company and workbook-import endpoints.
 *
 * Validation lives in the Zod schemas at the top; the handlers assume a parsed
 * payload and never read `req.body` directly.
 */

import { z } from 'zod'

import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import { Company } from '../../../models/company.model.js'
import { Contact } from '../../../models/contact.model.js'
import { Lead } from '../../../models/lead.model.js'
import { ROLES } from '../../../constants/roles.js'
import { USER_STATUS } from '../../../constants/userStatus.js'
import { User } from '../../../models/user.model.js'
import { updateContactSchema } from '../../contacts/validators/contact.validator.js'
import { fromXlsx, listSheets } from '../../contacts/utils/xlsx.js'
import { detectFormat } from '../../import/parsers/index.js'
import { IMPORT_STATUS, IMPORT_STEP } from '../../import/constants/importConstants.js'
import {
  COMPANY_STATUS_VALUES,
  LEAD_FIELD_VALUES,
  LEAD_STAGE_VALUES,
  MARKET_VALUES,
  SHEET_KIND,
} from '../constants/leadConstants.js'
import { classifyWorkbook } from '../services/worksheetClassifier.service.js'
import { analyseSheet, importSheet, rollbackImport } from '../services/leadImport.service.js'
import * as leadService from '../services/lead.service.js'
import { exportLeadsWorkbook } from '../services/leadExport.service.js'
import {
  checkReference,
  createLeadManually,
  peekNextReference,
} from '../services/manualLead.service.js'
import { resolveContext } from '../../provider/services/provider.service.js'
import { recordUse, resolveActiveTemplate } from '../../templates/services/template.service.js'

const ownerOf = (req) => req.auth.user._id
const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'That is not a valid id.')

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  sort: z.string().optional().default('-quote'),
  stage: z.enum(LEAD_STAGE_VALUES).optional(),
  stages: z.string().optional(),
  city: z.string().trim().max(128).optional(),
  country: z.string().trim().max(128).optional(),
  state: z.string().trim().max(128).optional(),
  company: objectId.optional(),
  contact: objectId.optional(),
  handledBy: z.string().trim().max(64).optional(),
  market: z.enum(MARKET_VALUES).optional(),
  travelMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  importJob: objectId.optional(),
  campaignEligible: z.enum(['true', 'false']).optional(),
  quoteFrom: z.string().optional(),
  quoteTo: z.string().optional(),
  search: z.string().trim().max(200).optional(),
})

const updateLeadSchema = z.object({
  stage: z.enum(LEAD_STAGE_VALUES).optional(),
  stageReason: z.string().trim().max(512).optional(),
  handledBy: z.string().trim().max(64).nullable().optional(),
  internalNotes: z.string().trim().max(4000).nullable().optional(),
  source: z.string().trim().max(128).nullable().optional(),
  travelDate: z.coerce.date().nullable().optional(),
  travelDateText: z.string().trim().max(128).nullable().optional(),
  city: z.string().trim().max(128).nullable().optional(),
  paxText: z.string().trim().max(128).nullable().optional(),
  adultCount: z.coerce.number().int().min(0).nullable().optional(),
  childCount: z.coerce.number().int().min(0).nullable().optional(),
  doNotContact: z.boolean().optional(),
})

const bulkStageSchema = z.object({
  ids: z.array(objectId).min(1).max(500),
  stage: z.enum(LEAD_STAGE_VALUES),
  reason: z.string().trim().max(512).optional(),
})

const companyUpdateSchema = z.object({
  companyName: z.string().trim().min(1).max(256).optional(),
  companyCode: z.string().trim().max(32).nullable().optional(),
  city: z.string().trim().max(128).nullable().optional(),
  state: z.string().trim().max(128).nullable().optional(),
  country: z.string().trim().max(128).nullable().optional(),
  website: z.string().trim().max(512).nullable().optional(),
  phone: z.string().trim().max(64).nullable().optional(),
  email: z.string().trim().max(320).nullable().optional(),
  gstNumber: z.string().trim().max(32).nullable().optional(),
  status: z.enum(COMPANY_STATUS_VALUES).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

/**
 * The composite edit.
 *
 * Every section is optional and each reuses the validator that already governs
 * that record, so a rule lives in one place: `updateLeadSchema` here,
 * `updateContactSchema` in the contacts module, `companyUpdateSchema` above.
 * There is deliberately no `owner` key in any of them — reassignment is not
 * something this endpoint does.
 */
const fullUpdateSchema = z
  .object({
    lead: updateLeadSchema.optional(),
    contact: updateContactSchema.optional(),
    company: companyUpdateSchema.optional(),
  })
  .refine((data) => data.lead ?? data.contact ?? data.company, {
    message: 'Provide at least one section to update.',
  })

const mappingSchema = z.array(
  z.object({
    column: z.string(),
    index: z.coerce.number().int().min(0),
    field: z.enum(LEAD_FIELD_VALUES),
  }),
)

const importSchema = z.object({
  sheet: z.string().min(1),
  mapping: mappingSchema.optional(),
  overwriteStage: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
})

/** Loads a lead the caller owns, or 404s. */
/**
 * May this caller reach an enquiry that is not theirs?
 *
 * The organization owner, and nobody else.
 *
 * Deliberately **not** `hasPermission(req, LEADS_EDIT)`. Several roles hold
 * `leads.edit`, and in an owner-scoped register it has only ever meant "may
 * edit leads" — meaning their own. Reading it as "may edit anyone's" would
 * silently hand every manager and member cross-user write access to the whole
 * register, which is an escalation nobody asked for. The cross-user path that
 * already exists is the admin console, which carries its own guards.
 */
function canReachAnyLead(req) {
  return req.auth?.user?.role === ROLES.OWNER
}

/**
 * Loads one enquiry, or 404s.
 *
 * 404 rather than 403 throughout: distinguishing them would confirm that an id
 * exists, which is the IDOR probe this scoping exists to defeat.
 *
 * `anyOwner` widens the scope to the whole register **for the organization
 * owner only**, and is passed by the two handlers that read and edit. Deletion
 * deliberately does not pass it: removing another person's enquiry is the
 * console's job, where `leads.delete` is checked, and widening it here would be
 * a change to destructive behaviour nobody asked for.
 */
async function loadLead(req, { anyOwner = false } = {}) {
  const { id } = z.object({ id: objectId }).parse(req.params)

  const scope =
    anyOwner && canReachAnyLead(req)
      ? { _id: id, isDeleted: false }
      : { _id: id, owner: ownerOf(req), isDeleted: false }

  const lead = await Lead.findOne(scope)
  if (!lead) throw ApiError.notFound('No lead with that id exists.')
  return lead
}

/** Whether this caller may edit this enquiry. The button and the guard agree. */
function canEditLead(req, lead) {
  return String(lead.owner) === String(ownerOf(req)) || canReachAnyLead(req)
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/** GET /api/v1/leads */
export const list = asyncHandler(async (req, res) => {
  const query = listQuerySchema.parse(req.query)

  const { items, pagination } = await leadService.listLeads({
    ...query,
    // `owner` after the spread: the session decides whose register this is,
    // never the query string. See the note in `buildLeadFilter`'s callers.
    owner: ownerOf(req),
    stages: query.stages ? query.stages.split(',').map((s) => s.trim()).filter(Boolean) : null,
    campaignEligible: query.campaignEligible === undefined ? null : query.campaignEligible === 'true',
  })

  return sendSuccess(res, {
    message: `${pagination.total} lead(s) found.`,
    data: { items: items.map((lead) => lead.toSummaryJSON()) },
    meta: { pagination },
  })
})

/**
 * Manual creation payload.
 *
 * Every field is a **string**, deliberately. They are handed to the importer's
 * `validateLeadRow`, which parses spreadsheet cells — dates, phone lists, pax
 * shapes and status words all arrive there as typed text, and pre-coercing them
 * here would mean this endpoint parsed them differently from an upload. The
 * only rules applied at this layer are length ceilings and the two enums that
 * are genuinely closed sets.
 */
const createLeadSchema = z.object({
  /** Blank means "allocate the next one". */
  reference: z.string().trim().max(64).optional().default(''),
  companyName: z.string().trim().max(256).optional().default(''),
  contactPerson: z.string().trim().max(256).optional().default(''),
  email: z.string().trim().max(320).optional().default(''),
  phone: z.string().trim().max(256).optional().default(''),
  quoteDate: z.string().trim().max(64).optional().default(''),
  travelDate: z.string().trim().max(128).optional().default(''),
  pax: z.string().trim().max(128).optional().default(''),
  city: z.string().trim().max(128).optional().default(''),
  handledBy: z.string().trim().max(64).optional().default(''),
  stage: z.string().trim().max(64).optional().default(''),
  notes: z.string().trim().max(4000).optional().default(''),
  /** Shown as "From". Where the enquiry came from. */
  source: z.string().trim().max(128).optional().default(''),
  /*
   * The manager who will hold the enquiry.
   *
   * An id, never a name: `Lead.owner` is a reference, and a name is neither
   * unique nor stable. Absent means "whoever is creating it", which is what
   * this endpoint has always done.
   */
  assignTo: objectId.optional(),
  /*
   * The travel agent's own city, which belongs to the company record rather
   * than the enquiry — `city` above is the travellers' departure city. Not a
   * lead field: it is threaded to `resolveCompany`, which already stores it.
   */
  agentCity: z.string().trim().max(128).optional().default(''),
  market: z.enum(MARKET_VALUES).optional(),

  /** Mirrors the workbook run's own switch. Default on, as an import is. */
  sendMail: z.boolean().optional().default(true),
  /** Fills `{{HandledBy}}`; falls back to the signed-in user's name. */
  agentName: z.string().trim().max(120).optional(),
})

/**
 * POST /api/v1/leads
 *
 * Creates one enquiry by hand. The service does the work; this resolves the
 * three things a request has that a service should not go looking for — the
 * ACTIVE template, the mailbox, and who is asking.
 */
export const create = asyncHandler(async (req, res) => {
  const { sendMail, agentName, assignTo, ...form } = createLeadSchema.parse(req.body)

  /**
   * Two different people, and the distinction matters.
   *
   * `creator` is whoever is filling the form. Their mailbox sends the
   * introduction and their ACTIVE template renders it, which is why template
   * resolution below stays on them — a sales user must not be blocked because
   * the manager they are assigning to has never set a template up.
   *
   * `owner` is who ends up holding the enquiry. It also scopes the reference
   * series and the company/contact records, because `(owner, reference)` is a
   * unique index: allocating from the creator's series and then saving under
   * the manager would produce a number from the wrong sequence.
   *
   * With no assignee the two are the same value, so nothing about the existing
   * behaviour changes.
   */
  const creator = ownerOf(req)
  const owner = assignTo ? await resolveAssignee(assignTo) : creator

  /**
   * The template and the mailbox are resolved exactly as `/leads/workbook/sync`
   * resolves them, including `createIfMissing` — a workspace whose Phase 2
   * connection has never been materialised as a mailbox must behave the same
   * here as it does for an upload.
   *
   * Both are resolved only when sending is asked for. A user creating a lead
   * with Auto Send off must not be blocked by "no template is active".
   */
  let template = null
  let provider = null
  let mailbox = null

  if (sendMail) {
    template = await resolveActiveTemplate({ owner: creator })
    const context = await resolveContext({ auth: req.auth, createIfMissing: true })
    provider = context.provider
    mailbox = context.mailbox
  }

  const result = await createLeadManually({
    owner,
    createdBy: req.auth.user._id,
    form,
    sendMail,
    template,
    provider,
    mailbox,
    agentName: agentName ?? req.auth?.user?.displayName ?? null,
  })

  // The same counter the workbook run increments, for the same reason.
  if (result.mail.sent) await recordUse({ id: template?._id, count: 1 })

  await recordAudit({
    req,
    event: 'LEAD_CREATED',
    summary: `Created the enquiry ${result.lead.reference}`,
    target: { id: String(result.lead._id), name: result.lead.reference },
    refs: { leadId: result.lead._id },
    // Whether an introduction went out is the consequential half: it means a
    // customer was emailed, which is not undoable.
    metadata: { mailSent: Boolean(result.mail?.sent), warnings: result.warnings ?? [] },
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: result.mail.sent
      ? `Lead ${result.lead.reference} created and the introduction was sent.`
      : `Lead ${result.lead.reference} created.`,
    data: {
      lead: result.lead.toSummaryJSON(),
      company: result.company ? { id: String(result.company._id), name: result.company.companyName } : null,
      contact: result.contact ? { id: String(result.contact._id), email: result.contact.primaryEmail } : null,
      mail: result.mail,
      warnings: result.warnings,
    },
  })
})

/**
 * GET /api/v1/leads/next-reference
 *
 * What the form shows as its placeholder, and what it would allocate on save.
 */
export const nextReferencePreview = asyncHandler(async (req, res) => {
  const { market, reference } = z
    .object({
      market: z.enum(MARKET_VALUES).optional(),
      reference: z.string().trim().max(64).optional(),
    })
    .parse(req.query)

  const owner = ownerOf(req)

  // Asking about a specific reference is a availability check, not an allocation.
  if (reference) {
    return sendSuccess(res, {
      message: 'Reference checked.',
      data: await checkReference({ owner, reference }),
    })
  }

  return sendSuccess(res, {
    message: 'Next reference resolved.',
    data: { reference: await peekNextReference({ owner, market }) },
  })
})

/**
 * GET /api/v1/leads/export
 *
 * Streams the filtered register as a workbook. Accepts the **same** query
 * parameters as `GET /leads`, parsed by the **same** schema, so "export what I
 * am looking at" cannot drift from what the list shows.
 */
export const exportLeads = asyncHandler(async (req, res) => {
  const query = listQuerySchema.parse(req.query)

  const { buffer, filename, contentType, count, truncated } = await exportLeadsWorkbook({
    owner: ownerOf(req),
    criteria: {
      ...query,
      stages: query.stages ? query.stages.split(',').map((s) => s.trim()).filter(Boolean) : null,
      campaignEligible:
        query.campaignEligible === undefined ? null : query.campaignEligible === 'true',
    },
  })

  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Length', buffer.length)
  // Row counts travel in headers because the body is a binary file. Both are
  // exposed so the browser, which is on another origin in a split deployment,
  // is allowed to read them.
  res.setHeader('X-Export-Count', String(count))
  if (truncated) res.setHeader('X-Export-Truncated', 'true')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Count, X-Export-Truncated')

  return res.status(HTTP_STATUS.OK).send(buffer)
})

/** GET /api/v1/leads/facets */
export const facets = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Filter options retrieved.',
    data: await leadService.leadFacets({ owner: ownerOf(req) }),
  }),
)

/** GET /api/v1/leads/statistics */
export const statistics = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Lead statistics retrieved.',
    data: await leadService.leadStatistics({ owner: ownerOf(req) }),
  }),
)

/** GET /api/v1/leads/pipeline */
export const pipeline = asyncHandler(async (req, res) => {
  const perStage = Math.min(50, Number(req.query.perStage) || 10)

  return sendSuccess(res, {
    message: 'Pipeline retrieved.',
    data: await leadService.pipelineBoard({ owner: ownerOf(req), perStage }),
  })
})

/** GET /api/v1/leads/search */
export const search = asyncHandler(async (req, res) => {
  const { q, limit } = z
    .object({ q: z.string().trim().max(200).optional().default(''), limit: z.coerce.number().int().min(1).max(50).optional().default(10) })
    .parse(req.query)

  return sendSuccess(res, {
    message: 'Search complete.',
    data: await leadService.globalSearch({ owner: ownerOf(req), query: q, limit }),
  })
})

/** POST /api/v1/leads/audience — resolve a campaign audience from lead criteria. */
export const audience = asyncHandler(async (req, res) => {
  const criteria = listQuerySchema.partial().parse(req.body ?? {})

  const result = await leadService.resolveLeadAudience({
    owner: ownerOf(req),
    criteria: {
      ...criteria,
      stages: criteria.stages ? String(criteria.stages).split(',').map((s) => s.trim()) : null,
    },
  })

  return sendSuccess(res, {
    message: `${result.recipients} recipient(s) from ${result.matchedLeads} eligible lead(s).`,
    data: {
      ...result,
      contactIds: result.contactIds.map((id) => id.toString()),
      leadIds: result.leadIds.map((id) => id.toString()),
    },
  })
})

/**
 * The managers an enquiry may be assigned to.
 *
 * Managers only, and active ones. The list is deliberately narrow: it is read
 * by any signed-in user who can create an enquiry, so it returns a display name
 * and an id and nothing else — enough to choose from, and no more of somebody's
 * record than choosing requires.
 */
export const assignees = asyncHandler(async (req, res) => {
  const managers = await User.find({
    role: ROLES.MANAGER,
    status: USER_STATUS.ACTIVE,
    isDeleted: { $ne: true },
  })
    .select('displayName email')
    .sort({ displayName: 1 })
    .lean()

  return sendSuccess(res, {
    message: 'Assignable managers loaded.',
    data: {
      items: managers.map((user) => ({
        id: String(user._id),
        name: user.displayName ?? user.email ?? 'Unnamed user',
      })),
    },
  })
})

/**
 * Resolves who an enquiry is being assigned to, or refuses.
 *
 * Enforced here rather than trusted from the client. The dropdown showing only
 * managers is a convenience; this is the rule. A sales user posting a
 * colleague's id — or their own — gets a 403, because the constraint is on the
 * *target* role, not on who is asking: an enquiry is assigned to a manager or
 * to nobody.
 *
 * 403 rather than 404 on purpose. The id came from a list this caller is
 * allowed to read, so its existence is not a secret; what is being refused is
 * the assignment, and saying so is more useful than pretending the user is
 * missing.
 */
async function resolveAssignee(assignTo) {
  const user = await User.findOne({ _id: assignTo, isDeleted: { $ne: true } })
    .select('role status displayName')
    .lean()

  if (!user) throw ApiError.notFound('That user does not exist.')

  if (user.role !== ROLES.MANAGER) {
    throw ApiError.forbidden('An enquiry can only be assigned to a manager.')
  }
  if (user.status !== USER_STATUS.ACTIVE) {
    throw ApiError.forbidden('That manager\'s account is not active.')
  }

  return user._id
}

/** GET /api/v1/leads/:id */
export const getById = asyncHandler(async (req, res) => {
  const lead = await loadLead(req, { anyOwner: true })

  const [company, contact, holder] = await Promise.all([
    lead.company ? Company.findById(lead.company) : null,
    lead.contact ? Contact.findById(lead.contact) : null,
    /*
     * Who holds the enquiry, resolved to a name here rather than on the model's
     * DTO — the list endpoints return hundreds of rows and must not each pay
     * for a user lookup. The detail returns one.
     */
    lead.owner ? User.findById(lead.owner).select('displayName email').lean() : null,
  ])

  return sendSuccess(res, {
    message: 'Lead retrieved.',
    data: {
      lead: lead.toPublicJSON(),
      company: company?.toPublicJSON() ?? null,
      contact: contact?.toPublicJSON() ?? null,
      /*
       * The server's own answer to "may I edit this?", so the Edit control is
       * rendered from the same rule the update endpoint enforces rather than
       * from the client's guess at it. The guard is still the guard — this
       * only stops the UI offering something the API would refuse.
       */
      canEdit: canEditLead(req, lead),
      /** Shown as "Assigned to". Null only for an enquiry with no owner. */
      owner: holder
        ? { id: String(holder._id), name: holder.displayName ?? holder.email ?? 'Unnamed user' }
        : null,
    },
  })
})


/**
 * The whole record in one save: the enquiry, its contact and its company.
 *
 * ## Why one endpoint rather than three calls from the client
 *
 * Three calls cannot report a partial outcome. If the contact saved and the
 * company did not, the browser has already told somebody "saved" twice and has
 * no way to say which half is now on disk. Doing it here means one
 * authorization, one validation pass, and one honest answer.
 *
 * ## Why the ids are not in the request body
 *
 * They are read off the enquiry. A caller who may edit this lead may edit *its*
 * contact and *its* company and nothing else — passing ids would turn a lead
 * they own into a lever on records they do not, which is the exact IDOR this
 * shape forecloses. Both linked documents are additionally re-loaded under the
 * enquiry owner's scope, so a stale link to somebody else's record cannot be
 * written through either.
 *
 * ## Atomicity
 *
 * This deployment uses no transactions, and introducing a replica-set
 * requirement for one form would be a far larger change than the feature.
 * Instead: everything is validated and every document is loaded *before*
 * anything is written, which removes the realistic failure — a request that was
 * never going to be valid, discovered halfway through. A write that still fails
 * mid-sequence reports exactly which parts were applied rather than claiming
 * success.
 */
export const updateFull = asyncHandler(async (req, res) => {
  // Validate first, and all of it. Nothing is loaded or written until the whole
  // payload is known to be acceptable.
  const payload = fullUpdateSchema.parse(req.body)

  const lead = await loadLead(req, { anyOwner: true })

  /*
   * The linked records, scoped to the *enquiry's* owner rather than the
   * caller's — that is what lets the organization owner edit another person's
   * company without widening the query to every company in the deployment.
   */
  const [contact, company] = await Promise.all([
    payload.contact && lead.contact
      ? Contact.findOne({ _id: lead.contact, owner: lead.owner })
      : null,
    payload.company && lead.company
      ? Company.findOne({ _id: lead.company, owner: lead.owner, isDeleted: false })
      : null,
  ])

  // Refuse before mutating anything, rather than saving the enquiry and then
  // discovering the company edit cannot be applied.
  if (payload.contact && !contact) {
    throw ApiError.notFound('This enquiry has no contact record to update.')
  }
  if (payload.company && !company) {
    throw ApiError.notFound('This enquiry has no company record to update.')
  }

  // --- apply, in memory ----------------------------------------------------
  if (payload.lead) {
    const data = payload.lead

    if (data.stage && data.stage !== lead.stage) {
      lead.moveToStage(data.stage, { by: ownerOf(req), reason: data.stageReason ?? 'Changed in the CRM' })
    }

    for (const field of [
      'handledBy', 'internalNotes', 'source', 'travelDate', 'travelDateText',
      'city', 'paxText', 'adultCount', 'childCount', 'doNotContact',
    ]) {
      if (data[field] !== undefined) lead[field] = data[field]
    }
  }

  if (payload.contact) {
    for (const [field, value] of Object.entries(payload.contact)) contact[field] = value
    contact.updatedBy = ownerOf(req)
  }

  if (payload.company) {
    for (const [field, value] of Object.entries(payload.company)) company[field] = value
  }

  // --- write ---------------------------------------------------------------
  const applied = []
  try {
    if (payload.lead) {
      await lead.save()
      applied.push('lead')
    }
    if (payload.contact) {
      await contact.save()
      applied.push('contact')
    }
    if (payload.company) {
      await company.save()
      applied.push('company')
    }
  } catch (error) {
    /*
     * Never report success for a save that did not happen. The message names
     * what reached the database so the reader knows what to re-enter, rather
     * than being told "something went wrong" about a form they have half saved.
     */
    const saved = applied.length > 0 ? `Saved: ${applied.join(', ')}.` : 'Nothing was saved.'
    throw ApiError.badRequest(`${error.message} ${saved}`.trim())
  }

  await recordAudit({
    req,
    event: 'LEAD_UPDATED',
    summary: `Updated the enquiry ${lead.reference}`,
    target: { id: String(lead._id), name: lead.reference },
    refs: { leadId: lead._id },
    metadata: {
      changedFields: Object.keys(payload.lead ?? {}),
      /** Which related records this one save also touched. */
      alsoUpdated: applied.filter((part) => part !== 'lead'),
      stage: lead.stage ?? null,
      onBehalfOfOwner: String(lead.owner) === String(ownerOf(req)) ? undefined : String(lead.owner),
    },
  })

  return sendSuccess(res, {
    message: 'Enquiry updated.',
    data: {
      lead: lead.toPublicJSON(),
      contact: contact ? contact.toPublicJSON() : null,
      company: company ? company.toPublicJSON() : null,
      updated: applied,
    },
  })
})

/** PUT /api/v1/leads/:id */
export const update = asyncHandler(async (req, res) => {
  const lead = await loadLead(req, { anyOwner: true })
  const data = updateLeadSchema.parse(req.body)

  if (data.stage && data.stage !== lead.stage) {
    lead.moveToStage(data.stage, { by: ownerOf(req), reason: data.stageReason ?? 'Changed in the CRM' })
  }

  for (const field of [
    'handledBy', 'internalNotes', 'source', 'travelDate', 'travelDateText',
    'city', 'paxText', 'adultCount', 'childCount', 'doNotContact',
  ]) {
    if (data[field] !== undefined) lead[field] = data[field]
  }

  await lead.save()

  await recordAudit({
    req,
    event: 'LEAD_UPDATED',
    summary: `Updated the enquiry ${lead.reference}`,
    target: { id: String(lead._id), name: lead.reference },
    refs: { leadId: lead._id },
    metadata: {
      changedFields: Object.keys(data),
      stage: lead.stage ?? null,
      /*
       * Recorded only when somebody edits an enquiry that is not theirs, which
       * today means the organization owner. An unowned edit should be findable
       * in the log without reading every LEAD_UPDATED entry.
       */
      onBehalfOfOwner: String(lead.owner) === String(ownerOf(req)) ? undefined : String(lead.owner),
    },
  })

  return sendSuccess(res, { message: 'Lead updated.', data: { lead: lead.toPublicJSON() } })
})

/** POST /api/v1/leads/bulk-stage */
export const bulkStage = asyncHandler(async (req, res) => {
  const { ids, stage, reason } = bulkStageSchema.parse(req.body)
  const owner = ownerOf(req)

  const leads = await Lead.find({ _id: { $in: ids }, owner, isDeleted: false })

  let moved = 0
  for (const lead of leads) {
    if (lead.stage === stage) continue
    lead.moveToStage(stage, { by: owner, reason: reason ?? 'Bulk update' })
    await lead.save()
    moved += 1
  }

  return sendSuccess(res, {
    message: `${moved} lead(s) moved to ${stage}.`,
    data: { requested: ids.length, moved, unchanged: leads.length - moved },
  })
})

/** DELETE /api/v1/leads/:id — soft delete. */
export const remove = asyncHandler(async (req, res) => {
  const lead = await loadLead(req)
  lead.isDeleted = true
  await lead.save()

  if (lead.company) {
    const company = await Company.findById(lead.company)
    if (company) await company.recount()
  }

  await recordAudit({
    req,
    event: 'LEAD_DELETED',
    summary: `Deleted the enquiry ${lead.reference}`,
    target: { id: String(lead._id), name: lead.reference },
    refs: { leadId: lead._id },
    affectedCount: 1,
    metadata: { soft: true, stage: lead.stage ?? null },
  })

  return sendSuccess(res, { message: 'Lead deleted.', data: { id: lead._id.toString(), deleted: true } })
})

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

/** GET /api/v1/companies */
export const listCompanies = asyncHandler(async (req, res) => {
  const { page, limit, sort, search: term, status, country } = z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
      sort: z.enum(['-leads', 'leads', 'name', '-name', '-recent']).optional().default('-leads'),
      search: z.string().trim().max(200).optional(),
      status: z.enum(COMPANY_STATUS_VALUES).optional(),
      country: z.string().trim().max(128).optional(),
    })
    .parse(req.query)

  const filter = { owner: ownerOf(req), isDeleted: false }
  if (status) filter.status = status
  if (country) filter.country = country
  if (term) {
    const escaped = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    filter.$or = [{ companyName: escaped }, { aliases: escaped }, { emailDomain: escaped }]
  }

  const sortSpec = {
    '-leads': { leadCount: -1 },
    leads: { leadCount: 1 },
    name: { companyName: 1 },
    '-name': { companyName: -1 },
    '-recent': { lastLeadAt: -1 },
  }[sort]

  const skip = (page - 1) * limit
  const [items, total] = await Promise.all([
    Company.find(filter).sort(sortSpec).skip(skip).limit(limit),
    Company.countDocuments(filter),
  ])

  return sendSuccess(res, {
    message: `${total} company/companies found.`,
    data: { items: items.map((company) => company.toPublicJSON()) },
    meta: {
      pagination: {
        page, limit, total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: skip + items.length < total,
        hasPrevious: page > 1,
      },
    },
  })
})

/** GET /api/v1/companies/:id — with its people and its enquiries. */
export const getCompany = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)
  const owner = ownerOf(req)

  const company = await Company.findOne({ _id: id, owner, isDeleted: false })
  if (!company) throw ApiError.notFound('No company with that id exists.')

  const [contacts, leads, stageCounts] = await Promise.all([
    Contact.find({ owner, companyId: company._id, isDeleted: false }).sort({ leadCount: -1 }).limit(100),
    Lead.find({ owner, company: company._id, isDeleted: false }).sort({ quoteDate: -1 }).limit(50),
    Lead.aggregate([
      { $match: { owner, company: company._id, isDeleted: false } },
      { $group: { _id: '$stage', count: { $sum: 1 } } },
    ]),
  ])

  return sendSuccess(res, {
    message: 'Company retrieved.',
    data: {
      company: company.toPublicJSON(),
      contacts: contacts.map((contact) => contact.toPublicJSON()),
      leads: leads.map((lead) => lead.toSummaryJSON()),
      byStage: Object.fromEntries(stageCounts.map((row) => [row._id, row.count])),
    },
  })
})

/** PUT /api/v1/companies/:id */
export const updateCompany = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)
  const data = companyUpdateSchema.parse(req.body)

  const company = await Company.findOne({ _id: id, owner: ownerOf(req), isDeleted: false })
  if (!company) throw ApiError.notFound('No company with that id exists.')

  for (const [field, value] of Object.entries(data)) company[field] = value
  await company.save()

  return sendSuccess(res, { message: 'Company updated.', data: { company: company.toPublicJSON() } })
})

/**
 * DELETE /api/v1/companies/:id
 *
 * Soft-deletes one company. `isDeleted: true` is the pattern every company
 * query in this module already filters on, so the record leaves the register
 * the moment this returns without anything else needing to know.
 *
 * ## Leads are deliberately untouched
 *
 * A `Lead` references its company by id. Deleting those leads would destroy
 * the enquiry register — the thing the CRM exists for — because somebody tidied
 * up a duplicate company row. Clearing the reference would silently detach
 * history that is still true. So neither happens: the lead keeps pointing at a
 * company that is no longer listed, exactly as a soft delete implies, and
 * restoring the company restores the association intact.
 */
export const deleteCompany = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)

  const company = await Company.findOne({ _id: id, owner: ownerOf(req), isDeleted: false })
  if (!company) throw ApiError.notFound('No company with that id exists.')

  company.isDeleted = true
  await company.save()

  return sendSuccess(res, {
    message: `${company.companyName} was deleted.`,
    data: { deleted: 1, id: String(company._id) },
  })
})

/**
 * DELETE /api/v1/companies
 *
 * Bulk delete. Either a list of ids, or `all: true` for the whole register.
 *
 * `all` operates on the database rather than on whatever the caller happened to
 * have loaded — deleting "all" while showing page one of thirty and removing
 * fifty rows is the kind of half-done destructive action nobody can tell has
 * gone wrong until much later.
 *
 * The two are mutually exclusive at the schema, so a request cannot ask for
 * both and leave the server to decide which was meant.
 */
export const deleteCompanies = asyncHandler(async (req, res) => {
  const { ids, all } = z
    .object({
      ids: z.array(objectId).min(1).max(500).optional(),
      all: z.literal(true).optional(),
    })
    .refine((value) => Boolean(value.all) !== Boolean(value.ids), {
      message: 'Send either `ids` or `all: true`, not both and not neither.',
    })
    .parse(req.body ?? {})

  // Always scoped to the caller's own register, exactly like every other
  // company query here. `all` means all of *theirs*.
  const filter = { owner: ownerOf(req), isDeleted: false }
  // `all` widens to the whole register; otherwise only the named ids.
  if (!all) filter._id = { $in: ids }

  const result = await Company.updateMany(filter, { $set: { isDeleted: true } })
  const deleted = result.modifiedCount ?? 0

  return sendSuccess(res, {
    message: `${deleted} company/companies deleted.`,
    data: { deleted },
  })
})

// ---------------------------------------------------------------------------
// Workbook import
// ---------------------------------------------------------------------------

/**
 * Reads the uploaded file off the request.
 *
 * The route mounts `express.raw`, so the body is already a Buffer — the same
 * approach the Phase 6 importer uses, avoiding a multipart dependency for what
 * is always a single file.
 */
function fileFrom(req) {
  const buffer = Buffer.isBuffer(req.body) ? req.body : null
  if (!buffer || buffer.length === 0) throw ApiError.badRequest('No file was uploaded.')

  const filename = String(req.get('x-filename') ?? 'workbook.xlsx')
  return { buffer, filename }
}

/**
 * POST /api/v1/leads/workbook/inspect
 *
 * Reads the workbook and reports what each sheet is, without writing anything.
 * This is what makes the wizard's "choose a sheet" step possible.
 */
export const inspectWorkbook = asyncHandler(async (req, res) => {
  const { buffer, filename } = fileFrom(req)

  const format = detectFormat(buffer, filename)
  if (format.format !== 'xlsx') {
    throw ApiError.badRequest(
      `Multi-sheet inspection needs an .xlsx workbook; this file is ${format.format}. ` +
        'Use the contacts importer for single-table CSV and legacy formats.',
    )
  }

  const sheets = listSheets(buffer).map((sheet) => {
    const parsed = fromXlsx(buffer, { sheet: sheet.name })
    return {
      name: sheet.name,
      headers: parsed.headers,
      rows: parsed.grid.slice(parsed.headerRowNumber),
      headerRowNumber: parsed.headerRowNumber,
      hidden: sheet.hidden,
    }
  })

  const classification = classifyWorkbook(sheets)

  return sendSuccess(res, {
    message: `${classification.leadSheets} lead sheet(s) found in ${sheets.length} worksheet(s).`,
    data: {
      filename,
      format: format.format,
      recommended: classification.recommended,
      sheets: classification.sheets.map((sheet, index) => ({
        ...sheet,
        headerRowNumber: sheets[index].headerRowNumber,
        hidden: sheets[index].hidden,
        headers: sheets[index].headers,
        preview: sheets[index].rows.slice(0, 5),
      })),
    },
  })
})

/**
 * POST /api/v1/leads/workbook/import
 *
 * Imports one worksheet. `dryRun` returns the preview without writing, which is
 * the same code path the real import takes — so the preview cannot disagree
 * with the outcome.
 */
export const importWorkbook = asyncHandler(async (req, res) => {
  const { buffer, filename } = fileFrom(req)

  const options = importSchema.parse(
    JSON.parse(req.get('x-import-options') ?? '{}'),
  )

  const owner = ownerOf(req)
  const parsed = fromXlsx(buffer, { sheet: options.sheet })
  const rows = parsed.grid.slice(parsed.headerRowNumber)

  // Reclassify rather than trusting a mapping the client may have invented; a
  // supplied mapping is merged over the detected one.
  const classified = classifyWorkbook([
    { name: options.sheet, headers: parsed.headers, rows },
  ]).sheets[0]

  if (classified.kind === SHEET_KIND.OPERATIONS && !options.mapping) {
    throw ApiError.badRequest(
      `"${options.sheet}" was identified as hotel operations data, not leads. ${classified.reason} ` +
        'Supply an explicit mapping if you are certain.',
    )
  }

  const mapping = options.mapping
    ? classified.mapping.map((entry) => {
        const override = options.mapping.find((candidate) => candidate.index === entry.index)
        return override ? { ...entry, field: override.field, source: 'manual' } : entry
      })
    : classified.mapping

  const common = {
    rows,
    mapping,
    sheetName: options.sheet,
    headerRowNumber: parsed.headerRowNumber,
    owner,
  }

  if (options.dryRun) {
    const preview = await analyseSheet(common)

    return sendSuccess(res, {
      message: `${preview.counts.valid} of ${preview.counts.total} row(s) are importable.`,
      data: { dryRun: true, filename, sheet: options.sheet, mapping, corrections: classified.corrections, ...preview },
    })
  }

  const { ImportJob } = await import('../../../models/importJob.model.js')

  const job = await ImportJob.create({
    owner,
    createdBy: owner,
    filename,
    fileSize: buffer.length,
    format: 'xlsx',
    status: IMPORT_STATUS.RUNNING,
    step: IMPORT_STEP.IMPORT,
    headers: parsed.headers,
    startedAt: new Date(),
  })

  const result = await importSheet({
    ...common,
    createdBy: owner,
    importJob: job._id,
    overwriteStage: options.overwriteStage,
  })

  // `partial` rather than a new status value: the existing vocabulary already
  // has a word for "finished, but not everything landed".
  job.status = result.failed > 0 || result.invalid > 0 ? IMPORT_STATUS.PARTIAL : IMPORT_STATUS.COMPLETED
  job.step = IMPORT_STEP.IMPORT
  job.cursor = result.total
  job.progress = {
    imported: result.created,
    updated: result.updated,
    skipped: result.duplicate,
    failed: result.failed + result.invalid,
  }
  job.finishedAt = new Date()
  await job.save()

  await recordAudit({
    req,
    event: 'WORKBOOK_IMPORTED',
    summary: `Imported ${filename} — ${result.created} created, ${result.updated} updated`,
    target: { id: String(job._id), name: filename },
    affectedCount: result.created + result.updated,
    metadata: {
      sheet: options.sheet ?? null,
      created: result.created,
      updated: result.updated,
      duplicate: result.duplicate,
      failed: result.failed,
      invalid: result.invalid,
      companies: result.distinctCompanies,
      contacts: result.distinctContacts,
    },
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message:
      `${result.created} lead(s) created, ${result.updated} updated across ` +
      `${result.distinctCompanies} company/companies and ${result.distinctContacts} contact(s).`,
    data: { importJob: job._id.toString(), sheet: options.sheet, corrections: classified.corrections, ...result },
  })
})

/** POST /api/v1/leads/workbook/:importJob/rollback */
export const rollback = asyncHandler(async (req, res) => {
  const { importJob } = z.object({ importJob: objectId }).parse(req.params)

  const result = await rollbackImport({ owner: ownerOf(req), importJob })

  return sendSuccess(res, {
    message: `Rolled back ${result.leads} lead(s).`,
    data: result,
  })
})
