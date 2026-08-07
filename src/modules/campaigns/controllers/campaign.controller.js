/**
 * Campaign controller.
 *
 * Thin by design: validate HTTP input, delegate, wrap in the standard envelope.
 * No sending logic and no Graph symbol appears here.
 */

import { z } from 'zod'

import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import { Campaign } from '../../../models/campaign.model.js'
import { CampaignEvent } from '../../../models/campaignEvent.model.js'
import { CampaignRecipient } from '../../../models/campaignRecipient.model.js'
import { CampaignSequence } from '../../../models/campaignSequence.model.js'
import { CampaignTemplate } from '../../../models/campaignTemplate.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { isDefaultForUser, scopedMailboxFilter } from '../../../constants/mailboxAccess.js'
import { CONNECTION_STATUS } from '../../provider/constants/providerTypes.js'
import { resolveContext } from '../../provider/services/provider.service.js'
import {
  CAMPAIGN_PRIORITY,
  CAMPAIGN_STATUS_VALUES,
  RECIPIENT_STATUS_VALUES,
  TEMPLATE_CATEGORY_VALUES,
} from '../constants/campaignConstants.js'
import * as service from '../services/campaign.service.js'
import * as templateService from '../../templates/services/template.service.js'
import { drainCampaign } from '../services/queue.service.js'
import { campaignAnalytics, overallAnalytics, recordTemplatePerformance } from '../services/analytics.service.js'
import { mailboxHealthSnapshot } from '../services/throttle.service.js'
import { extractVariables } from '../services/personalisation.service.js'
import { createSequenceStep } from '../services/replyDetection.service.js'

const ownerOf = (req) => req.auth.user._id
const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'That is not a valid id.')

/** Loads a campaign the caller owns, or 404s. */
async function loadCampaign(req) {
  const { id } = z.object({ id: objectId }).parse(req.params)

  const campaign = await Campaign.findOne({ _id: id, owner: ownerOf(req) })

  // 404 rather than 403: distinguishing them would confirm the id exists.
  if (!campaign) throw ApiError.notFound('No campaign with that id exists.')

  return campaign
}

const audienceSchema = z.object({
  /** Lead-register criteria: stage, city, travel month, company, market. */
  leadCriteria: z.record(z.string(), z.any()).optional().nullable(),
  source: z.string().optional(),
  contactIds: z.array(objectId).max(50_000).optional(),
  groupIds: z.array(objectId).max(100).optional(),
  tags: z.array(z.string().trim().max(48)).max(50).optional(),
  filter: z.record(z.string(), z.any()).optional(),
  importJobId: objectId.optional(),
  excludedContactIds: z.array(objectId).max(50_000).optional(),
})

const createSchema = z.object({
  name: z.string().trim().min(1, 'A campaign needs a name.').max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  template: objectId.optional().nullable(),
  subject: z.string().trim().max(998).optional(),
  bodyHtml: z.string().max(500_000).optional(),
  senderMailboxes: z.array(objectId).max(20).optional(),
  audience: audienceSchema.optional(),
  throttle: z
    .object({
      perMinute: z.coerce.number().int().min(1).optional(),
      perHour: z.coerce.number().int().min(1).optional(),
      perDay: z.coerce.number().int().min(1).optional(),
      batchSize: z.coerce.number().int().min(1).optional(),
    })
    .optional(),
  /**
   * Campaign-scoped variable values — `{{Destination}}`, `{{Agent}}` and any
   * custom name a template declares. Without these the campaign-sourced
   * variables have no way in, and every message renders their fallback.
   */
  variables: z.record(z.string(), z.string().max(500)).optional(),
  priority: z.enum(CAMPAIGN_PRIORITY_KEYS()).optional(),
  sequence: objectId.optional().nullable(),
  scheduledFor: z.coerce.date().optional().nullable(),
})

/** Priority is exposed by name; the numbers are an implementation detail. */
function CAMPAIGN_PRIORITY_KEYS() {
  return Object.keys(CAMPAIGN_PRIORITY).map((key) => key.toLowerCase())
}

/** GET /api/v1/campaigns */
export const list = asyncHandler(async (req, res) => {
  const query = z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      status: z.enum(CAMPAIGN_STATUS_VALUES).optional(),
      search: z.string().trim().max(200).optional(),
    })
    .parse(req.query)

  const filter = { owner: ownerOf(req) }
  if (query.status) filter.status = query.status
  if (query.search) {
    filter.name = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }

  const skip = (query.page - 1) * query.limit

  const [items, total] = await Promise.all([
    Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(query.limit),
    Campaign.countDocuments(filter),
  ])

  return sendSuccess(res, {
    message: 'Campaigns retrieved successfully.',
    data: { items: items.map((campaign) => campaign.toSummaryJSON()) },
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

/** POST /api/v1/campaigns */
export const create = asyncHandler(async (req, res) => {
  const data = createSchema.parse(req.body)
  const owner = ownerOf(req)

  const campaign = await service.createCampaign({
    owner,
    createdBy: owner,
    data: {
      ...data,
      priority: data.priority ? CAMPAIGN_PRIORITY[data.priority.toUpperCase()] : undefined,
    },
  })

  await recordAudit({
    req,
    event: 'CAMPAIGN_CREATED',
    summary: `Created the campaign "${campaign.name}"`,
    target: { id: String(campaign._id), name: campaign.name },
    refs: { campaignId: campaign._id },
    affectedCount: campaign.stats?.recipients ?? 0,
    metadata: { recipients: campaign.stats?.recipients ?? 0, priority: campaign.priority ?? null },
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: `Campaign "${campaign.name}" created with ${campaign.stats.recipients} recipient(s).`,
    data: { campaign: campaign.toPublicJSON() },
  })
})

/** GET /api/v1/campaigns/:id */
export const getById = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)

  return sendSuccess(res, {
    message: 'Campaign retrieved successfully.',
    data: { campaign: campaign.toPublicJSON() },
  })
})

/** PUT /api/v1/campaigns/:id — draft only. */
export const update = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)
  const data = createSchema.partial().parse(req.body)

  if (campaign.status !== 'draft') {
    throw ApiError.badRequest(
      `This campaign is ${campaign.status}. Only a draft can be edited — clone it to make changes.`,
    )
  }

  for (const field of ['name', 'description', 'subject', 'bodyHtml', 'senderMailboxes', 'scheduledFor']) {
    if (data[field] !== undefined) campaign[field] = data[field]
  }

  // Replaced wholesale rather than merged: clearing a variable has to be
  // possible, and a merge would make a removed key stick forever.
  if (data.variables !== undefined) campaign.variables = new Map(Object.entries(data.variables))

  if (data.throttle) campaign.throttle = { ...campaign.throttle.toObject(), ...data.throttle }
  if (data.priority) campaign.priority = CAMPAIGN_PRIORITY[data.priority.toUpperCase()]

  campaign.updatedBy = ownerOf(req)
  await campaign.save()

  // The audience is rebuilt rather than patched, so removing a group actually
  // removes its members.
  if (data.audience) {
    campaign.audience = data.audience
    await campaign.save()
    await CampaignRecipient.deleteMany({ campaign: campaign._id })
    await service.buildRecipients({ campaign, owner: ownerOf(req) })
  }

  await recordAudit({
    req,
    event: 'CAMPAIGN_UPDATED',
    summary: `Updated the campaign "${campaign.name}"`,
    target: { id: String(campaign._id), name: campaign.name },
    refs: { campaignId: campaign._id },
    // The field names that changed, not their values. A campaign body carries
    // the message content, and copying it here would duplicate the campaign
    // into the log on every edit.
    metadata: { changedFields: Object.keys(data) },
  })

  return sendSuccess(res, {
    message: 'Campaign updated successfully.',
    data: { campaign: campaign.toPublicJSON() },
  })
})

/** POST /api/v1/campaigns/:id/audience — rebuild the recipient list. */
export const rebuildAudience = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)
  const audience = audienceSchema.parse(req.body)

  if (campaign.status !== 'draft') {
    throw ApiError.badRequest('The audience can only be changed while the campaign is a draft.')
  }

  campaign.audience = audience
  await campaign.save()

  await CampaignRecipient.deleteMany({ campaign: campaign._id })
  const result = await service.buildRecipients({ campaign, owner: ownerOf(req) })

  return sendSuccess(res, {
    message: `${result.created} recipient(s) added.`,
    data: { campaign: campaign.toPublicJSON(), ...result },
  })
})

/** GET /api/v1/campaigns/:id/preview */
export const preview = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)

  return sendSuccess(res, {
    message: 'Preview generated.',
    data: await service.previewCampaign({ campaign, limit: 3 }),
  })
})

/** POST /api/v1/campaigns/:id/launch */
export const launch = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)
  const { scheduledFor } = z
    .object({ scheduledFor: z.coerce.date().optional().nullable() })
    .parse(req.body ?? {})

  const launched = await service.launchCampaign({
    campaign,
    owner: ownerOf(req),
    scheduledFor: scheduledFor ?? null,
  })

  await recordAudit({
    req,
    event: 'CAMPAIGN_STARTED',
    summary: scheduledFor
      ? `Scheduled the campaign "${launched.name}"`
      : `Started the campaign "${launched.name}"`,
    target: { id: String(launched._id), name: launched.name },
    refs: { campaignId: launched._id },
    affectedCount: launched.stats?.recipients ?? 0,
    metadata: {
      scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      recipients: launched.stats?.recipients ?? 0,
    },
  })

  return sendSuccess(res, {
    message: scheduledFor
      ? `Campaign scheduled for ${new Date(scheduledFor).toISOString()}.`
      : 'Campaign launched.',
    data: { campaign: launched.toPublicJSON() },
  })
})

/**
 * POST /api/v1/campaigns/:id/send
 *
 * Drains a bounded number of batches and returns what happened. Bounded rather
 * than run-to-completion so a large campaign cannot hold an HTTP request open
 * for hours; the client calls again, or a scheduler does.
 */
export const send = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)
  const owner = ownerOf(req)

  const { maxBatches } = z
    .object({ maxBatches: z.coerce.number().int().min(1).max(200).optional().default(20) })
    .parse(req.body ?? {})

  // Sending goes through the provider abstraction, never Graph directly.
  const { provider, mailbox, isMock } = await resolveContext({ auth: req.auth, createIfMissing: true })

  if (!mailbox) {
    throw ApiError.badRequest('No mailbox is connected. Connect one before sending.')
  }

  // A campaign with no explicit mailboxes falls back to the connected one.
  if (campaign.senderMailboxes.length === 0) {
    campaign.senderMailboxes = [mailbox._id]
    await campaign.save()
  }

  const result = await drainCampaign({ campaign, provider, owner, maxBatches })

  if (result.campaign.status === 'completed') {
    await recordTemplatePerformance({ campaign: result.campaign })
    // Queue the next sequence step, if the campaign has one.
    await createSequenceStep({ campaign: result.campaign, owner, createdBy: owner })
  }

  return sendSuccess(res, {
    message: result.ran
      ? `${result.totals.sent} sent, ${result.totals.failed} failed, ${result.totals.bounced} bounced. ${result.remaining} remaining.`
      : result.reason,
    data: { mockMode: isMock, ...result, campaign: result.campaign.toPublicJSON() },
  })
})

/** POST /api/v1/campaigns/:id/control — pause · resume · cancel · archive. */
export const control = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)
  const { action } = z
    .object({ action: z.enum(['pause', 'resume', 'cancel', 'archive']) })
    .parse(req.body)

  const updated = await service.controlCampaign({ campaign, action })

  /**
   * Four verbs, three events.
   *
   * `resume` is recorded as a start because that is what it does to the
   * customer — mail begins going out again — and an operator scanning for "when
   * did this campaign begin sending" should find both. `cancel` and `archive`
   * are terminal, so they share the completion event, with the verb itself in
   * the metadata so the two remain distinguishable.
   */
  const EVENT_FOR = {
    pause: 'CAMPAIGN_PAUSED',
    resume: 'CAMPAIGN_STARTED',
    cancel: 'CAMPAIGN_COMPLETED',
    archive: 'CAMPAIGN_COMPLETED',
  }

  await recordAudit({
    req,
    event: EVENT_FOR[action],
    summary: `${action[0].toUpperCase()}${action.slice(1)}d the campaign "${updated.name}"`,
    target: { id: String(updated._id), name: updated.name },
    refs: { campaignId: updated._id },
    metadata: { action, status: updated.status ?? null },
  })

  return sendSuccess(res, {
    message: `Campaign ${action}d.`,
    data: { campaign: updated.toPublicJSON() },
  })
})

/** POST /api/v1/campaigns/:id/clone */
export const clone = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)
  const { name } = z.object({ name: z.string().trim().max(200).optional() }).parse(req.body ?? {})
  const owner = ownerOf(req)

  const result = await service.cloneCampaign({ campaign, owner, createdBy: owner, name })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: `Cloned as "${result.campaign.name}" with ${result.recipients} recipient(s).`,
    data: { campaign: result.campaign.toPublicJSON() },
  })
})

/** GET /api/v1/campaigns/:id/recipients */
export const recipients = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)

  const query = z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
      status: z.enum(RECIPIENT_STATUS_VALUES).optional(),
    })
    .parse(req.query)

  const filter = { campaign: campaign._id }
  if (query.status) filter.status = query.status

  const skip = (query.page - 1) * query.limit

  const [items, total] = await Promise.all([
    CampaignRecipient.find(filter).sort({ createdAt: 1 }).skip(skip).limit(query.limit),
    CampaignRecipient.countDocuments(filter),
  ])

  return sendSuccess(res, {
    message: 'Recipients retrieved successfully.',
    data: { items: items.map((recipient) => recipient.toPublicJSON()) },
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

/** GET /api/v1/campaigns/:id/events — the audit timeline. */
export const events = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)

  const limit = Math.min(Number(req.query.limit ?? 100), 500)

  const items = await CampaignEvent.find({ campaign: campaign._id })
    .sort({ occurredAt: -1 })
    .limit(limit)

  return sendSuccess(res, {
    message: 'Campaign events retrieved successfully.',
    data: { items: items.map((event) => event.toPublicJSON()) },
  })
})

/** GET /api/v1/campaigns/:id/analytics */
export const analytics = asyncHandler(async (req, res) => {
  const campaign = await loadCampaign(req)

  return sendSuccess(res, {
    message: 'Campaign analytics retrieved successfully.',
    data: await campaignAnalytics({ campaign, owner: ownerOf(req) }),
  })
})

/** GET /api/v1/campaigns/analytics — cross-campaign summary. */
export const overview = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Campaign overview retrieved successfully.',
    data: await overallAnalytics({ owner: ownerOf(req) }),
  }),
)

// --- Templates -------------------------------------------------------------

const templateSchema = z.object({
  name: z.string().trim().min(1, 'A template needs a name.').max(200),
  description: z.string().trim().max(1000).optional().nullable(),
  category: z.enum(TEMPLATE_CATEGORY_VALUES).optional(),
  subject: z.string().trim().min(1, 'A template needs a subject.').max(998),
  bodyHtml: z.string().min(1, 'A template needs a body.').max(500_000),
  bodyText: z.string().max(500_000).optional(),
  variables: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(64),
        fallback: z.string().max(256).optional().default(''),
        source: z.enum(['contact', 'campaign', 'custom']).optional().default('contact'),
        description: z.string().max(256).optional().nullable(),
      }),
    )
    .max(50)
    .optional(),
})

/** GET /api/v1/campaigns/templates */
export const listTemplates = asyncHandler(async (req, res) => {
  const filter = { owner: ownerOf(req), isDeleted: false }
  if (req.query.category) filter.category = req.query.category

  const items = await CampaignTemplate.find(filter).sort({ useCount: -1, name: 1 })

  return sendSuccess(res, {
    message: 'Templates retrieved successfully.',
    data: { items: items.map((template) => template.toPublicJSON()) },
  })
})

/** POST /api/v1/campaigns/templates */
export const createTemplate = asyncHandler(async (req, res) => {
  const data = templateSchema.parse(req.body)
  const owner = ownerOf(req)

  try {
    const template = await CampaignTemplate.create({ ...data, owner, createdBy: owner })

    return sendSuccess(res, {
      statusCode: HTTP_STATUS.CREATED,
      message: `Template "${template.name}" created.`,
      data: {
        template: template.toPublicJSON(),
        // Surfaced so the builder can prompt for anything the template needs.
        variablesUsed: extractVariables(data.subject, data.bodyHtml),
      },
    })
  } catch (error) {
    if (error?.code === 11000) {
      throw ApiError.conflict(`You already have a template named "${data.name}".`)
    }
    throw error
  }
})

/**
 * DELETE /api/v1/campaigns/templates/:id
 *
 * The legacy path to the same template library. It deletes through the template
 * service rather than writing `isDeleted` itself, so the rules cannot differ
 * between the two surfaces.
 *
 * That mattered: this handler previously soft-deleted any template it was given.
 * Deleting the ACTIVE one left the workspace with templates but none active,
 * which stops the morning workbook run emailing new enquiries until somebody
 * notices and activates another. The service refuses anything but a draft, and
 * the route now carries the same role guard as `DELETE /templates/:id`.
 *
 * The response is unchanged — same message, same `{ id, deleted: true }` — so
 * the existing client keeps working exactly as before on the path that was
 * always allowed.
 */
export const deleteTemplate = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)

  await templateService.deleteTemplate({ owner: ownerOf(req), id })

  return sendSuccess(res, { message: 'Template deleted.', data: { id, deleted: true } })
})

// --- Sequences -------------------------------------------------------------

/** GET /api/v1/campaigns/sequences */
export const listSequences = asyncHandler(async (req, res) => {
  const items = await CampaignSequence.find({ owner: ownerOf(req), isDeleted: false }).sort({ name: 1 })

  return sendSuccess(res, {
    message: 'Sequences retrieved successfully.',
    data: { items: items.map((sequence) => sequence.toPublicJSON()) },
  })
})

/** POST /api/v1/campaigns/sequences */
export const createSequence = asyncHandler(async (req, res) => {
  const data = z
    .object({
      name: z.string().trim().min(1).max(200),
      description: z.string().trim().max(1000).optional().nullable(),
      stopOnReply: z.boolean().optional().default(true),
      steps: z
        .array(
          z.object({
            delayDays: z.coerce.number().int().min(0).max(365),
            template: objectId,
            subjectOverride: z.string().trim().max(998).optional().nullable(),
            name: z.string().trim().max(200).optional().nullable(),
            onlyIfNotOpened: z.boolean().optional().default(false),
          }),
        )
        .min(1, 'A sequence needs at least one step.')
        .max(10),
    })
    .parse(req.body)

  const owner = ownerOf(req)

  try {
    const sequence = await CampaignSequence.create({ ...data, owner, createdBy: owner })

    return sendSuccess(res, {
      statusCode: HTTP_STATUS.CREATED,
      message: `Sequence "${sequence.name}" created with ${sequence.steps.length} step(s) over ${sequence.totalDays()} days.`,
      data: { sequence: sequence.toPublicJSON() },
    })
  } catch (error) {
    if (error?.code === 11000) {
      throw ApiError.conflict(`You already have a sequence named "${data.name}".`)
    }
    throw error
  }
})

export default {
  list, create, getById, update, rebuildAudience, preview, launch, send, control, clone,
  recipients, events, analytics, overview,
  listTemplates, createTemplate, deleteTemplate,
  listSequences, createSequence,
}

/**
 * GET /api/v1/campaigns/mailboxes
 *
 * The mailboxes available to send from, with their rotation health.
 *
 * Lives here rather than under `/provider` because it answers a campaign
 * question — *which mailboxes can this campaign rotate across* — and carries
 * the queue's health counters, which the provider module knows nothing about.
 * The builder cannot offer rotation without it.
 */
export const listMailboxes = asyncHandler(async (req, res) => {
  const owner = ownerOf(req)

  /**
   * Connected mailboxes only, default first.
   *
   * `Mailbox` keys its owner as `user`, not `owner`.
   *
   * The status filter matters more now that a workspace can hold several: a
   * disconnected mailbox offered in the rotation picker is a campaign that
   * launches and then fails on every message routed to it, and the operator has
   * no way to tell from the builder that they picked a broken one. Reconnecting
   * from Account puts it straight back in this list.
   */
  /**
   * Scoped by **access**, not ownership, since Phase 14.5.
   *
   * The same rule the send path uses, so the builder cannot offer a sender that
   * the send would then refuse. A strict superset of the old `{ user: owner }`
   * filter, so no campaign that could be built yesterday cannot be built today.
   */
  const mailboxes = await Mailbox.find(
    scopedMailboxFilter(owner, { status: CONNECTION_STATUS.CONNECTED }),
  ).sort({ isDefault: -1, connectedAt: -1 })

  const health = new Map(
    mailboxHealthSnapshot(mailboxes.map((mailbox) => mailbox._id)).map((entry) => [
      String(entry.mailbox ?? entry.id),
      entry,
    ]),
  )

  return sendSuccess(res, {
    message: `${mailboxes.length} mailbox(es) available for sending.`,
    data: {
      items: mailboxes.map((mailbox) => ({
        id: mailbox._id.toString(),
        emailAddress: mailbox.emailAddress,
        displayName: mailbox.displayName,
        provider: mailbox.provider,
        status: mailbox.status,
        /** Lets the builder pre-select *this user's* usual sender. */
        isDefault: isDefaultForUser(mailbox, owner),
        health: health.get(mailbox._id.toString()) ?? null,
      })),
    },
  })
})
