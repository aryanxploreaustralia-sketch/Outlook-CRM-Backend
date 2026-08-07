/**
 * Conversation, task and sync endpoints.
 *
 * Validation lives in the Zod schemas at the top; handlers assume a parsed
 * payload and never read `req.body` directly.
 */

import { z } from 'zod'

import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { Conversation } from '../../../models/conversation.model.js'
import { ConversationActivity } from '../../../models/conversationActivity.model.js'
import { ConversationMessage } from '../../../models/conversationMessage.model.js'
import { resolveContext } from '../../provider/services/provider.service.js'
import {
  CONVERSATION_STATUS,
  FOLLOW_UP_PRESETS,
  MESSAGE_DIRECTION,
  TASK_PRIORITY_VALUES,
  TASK_STATUS_VALUES,
  TASK_TYPE_VALUES,
} from '../constants/conversationConstants.js'
import * as conversations from '../services/conversation.service.js'
import * as collaboration from '../services/collaboration.service.js'
import * as attachments from '../services/attachment.service.js'
import { attachLead, recordOutgoing } from '../services/conversationSync.service.js'
import { moveLeadStage } from '../services/leadWorkflow.service.js'
import { runReplySync } from '../services/replySync.service.js'

const ownerOf = (req) => req.auth.user._id
const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'That is not a valid id.')

const listSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  filter: z.enum(conversations.CONVERSATION_FILTER_VALUES).optional().default('all'),
  lead: objectId.optional(),
  company: objectId.optional(),
  contact: objectId.optional(),
  campaign: objectId.optional(),
  assignedTo: objectId.optional(),
  status: z.enum(Object.values(CONVERSATION_STATUS)).optional(),
  search: z.string().trim().max(200).optional(),
})

const replySchema = z.object({
  conversationId: objectId,
  bodyHtml: z.string().min(1, 'The reply is empty.').max(500_000),
  /** Reply-all copies everyone the customer had on the thread. */
  replyAll: z.boolean().optional().default(false),
  cc: z.array(z.string().email()).max(50).optional().default([]),
  subject: z.string().trim().max(998).optional(),
})

const noteSchema = z.object({
  leadId: objectId.optional(),
  conversationId: objectId.optional(),
  body: z.string().min(1, 'The note is empty.').max(20_000),
  isPinned: z.boolean().optional().default(false),
})

const taskSchema = z.object({
  leadId: objectId.optional(),
  conversationId: objectId.optional(),
  messageId: objectId.optional(),
  type: z.enum(TASK_TYPE_VALUES).optional(),
  title: z.string().trim().min(1).max(256).optional(),
  notes: z.string().trim().max(4000).optional(),
  dueAt: z.coerce.date().optional(),
  preset: z.enum(FOLLOW_UP_PRESETS.map((option) => option.id)).optional(),
  priority: z.enum(TASK_PRIORITY_VALUES).optional().default('normal'),
  assignedTo: objectId.optional(),
  isFollowUp: z.boolean().optional().default(false),
})

const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(256).optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  type: z.enum(TASK_TYPE_VALUES).optional(),
  status: z.enum(TASK_STATUS_VALUES).optional(),
  priority: z.enum(TASK_PRIORITY_VALUES).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  assignedTo: objectId.nullable().optional(),
})

/** Loads a conversation the caller owns, or 404s. */
async function loadConversation(req) {
  const { id } = z.object({ id: objectId }).parse(req.params)
  const conversation = await Conversation.findOne({ _id: id, owner: ownerOf(req), isDeleted: false })
  if (!conversation) throw ApiError.notFound('No conversation with that id exists.')
  return conversation
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** GET /api/v1/conversations */
export const list = asyncHandler(async (req, res) => {
  const query = listSchema.parse(req.query)

  const { items, pagination } = await conversations.listConversations({
    owner: ownerOf(req),
    userId: ownerOf(req),
    ...query,
  })

  return sendSuccess(res, {
    message: `${pagination.total} conversation(s) found.`,
    data: { items: items.map((conversation) => conversation.toSummaryJSON()) },
    meta: { pagination },
  })
})

/** GET /api/v1/conversations/filters — counts for the sidebar badges. */
export const filters = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Filter counts retrieved.',
    data: await conversations.filterCounts({ owner: ownerOf(req), userId: ownerOf(req) }),
  }),
)

/** GET /api/v1/conversations/statistics */
export const statistics = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Conversation statistics retrieved.',
    data: await conversations.conversationStatistics({ owner: ownerOf(req), userId: ownerOf(req) }),
  }),
)

/** GET /api/v1/conversations/search */
export const search = asyncHandler(async (req, res) => {
  const { q, limit } = z
    .object({
      q: z.string().trim().max(200).optional().default(''),
      limit: z.coerce.number().int().min(1).max(50).optional().default(10),
    })
    .parse(req.query)

  return sendSuccess(res, {
    message: 'Search complete.',
    data: await conversations.searchEverything({ owner: ownerOf(req), query: q, limit }),
  })
})

/** GET /api/v1/conversations/tasks */
export const listTasks = asyncHandler(async (req, res) => {
  const query = z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
      status: z.enum(TASK_STATUS_VALUES).optional(),
      assignedTo: objectId.optional(),
      mine: z.enum(['true', 'false']).optional(),
      overdue: z.enum(['true', 'false']).optional(),
    })
    .parse(req.query)

  const { items, pagination } = await collaboration.listTasks({
    owner: ownerOf(req),
    assignedTo: query.mine === 'true' ? ownerOf(req) : query.assignedTo,
    status: query.status,
    overdue: query.overdue === 'true',
    page: query.page,
    limit: query.limit,
  })

  return sendSuccess(res, {
    message: `${pagination.total} task(s) found.`,
    data: { items: items.map((task) => task.toPublicJSON()) },
    meta: { pagination },
  })
})

/** GET /api/v1/conversations/lead/:leadId — the full business history. */
export const leadTimeline = asyncHandler(async (req, res) => {
  const { leadId } = z.object({ leadId: objectId }).parse(req.params)

  const timeline = await conversations.getLeadTimeline({ owner: ownerOf(req), leadId })
  if (!timeline) throw ApiError.notFound('No enquiry with that id exists.')

  return sendSuccess(res, { message: 'Lead timeline retrieved.', data: timeline })
})

/** GET /api/v1/conversations/:id */
export const getById = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)

  const detail = await conversations.getConversationDetail({ owner: ownerOf(req), conversationId: id })
  if (!detail) throw ApiError.notFound('No conversation with that id exists.')

  return sendSuccess(res, { message: 'Conversation retrieved.', data: detail })
})

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/conversations/reply
 *
 * Sends through the Phase 5 provider abstraction, then threads the sent message
 * immediately rather than waiting for the sent folder to sync — a salesperson
 * must see their own reply the moment they send it.
 */
export const reply = asyncHandler(async (req, res) => {
  const data = replySchema.parse(req.body)
  const owner = ownerOf(req)

  const conversation = await Conversation.findOne({ _id: data.conversationId, owner, isDeleted: false })
  if (!conversation) throw ApiError.notFound('No conversation with that id exists.')

  const lastIncoming = await ConversationMessage.findOne({
    conversation: conversation._id,
    direction: MESSAGE_DIRECTION.INCOMING,
  }).sort({ occurredAt: -1 })

  const to = lastIncoming?.from?.address
    ? [{ address: lastIncoming.from.address, name: lastIncoming.from.name }]
    : conversation.counterpartyEmail
      ? [{ address: conversation.counterpartyEmail, name: conversation.counterpartyName }]
      : []

  if (to.length === 0) throw ApiError.badRequest('There is nobody to reply to on this conversation.')

  /**
   * Reply-all copies the original recipients minus ourselves.
   *
   * Without the exclusion the mailbox would copy itself on every reply, and the
   * sent-folder sync would then ingest it as an inbound message.
   */
  const ourAddresses = new Set(
    [req.auth?.user?.email, req.auth?.mailbox?.emailAddress].filter(Boolean).map((a) => a.toLowerCase()),
  )

  const cc = data.replyAll
    ? [...(lastIncoming?.cc ?? []), ...(lastIncoming?.to ?? [])]
        .filter((recipient) => recipient?.address && !ourAddresses.has(recipient.address))
        .filter((recipient) => !to.some((target) => target.address === recipient.address))
    : data.cc.map((address) => ({ address, name: null }))

  const subject =
    data.subject ??
    (conversation.subject.toLowerCase().startsWith('re:')
      ? conversation.subject
      : `Re: ${conversation.subject}`)

  const { provider, mailbox, isMock } = await resolveContext({ auth: req.auth, createIfMissing: true })

  const sent = await provider.send(
    {
      to,
      cc,
      subject,
      bodyHtml: data.bodyHtml,
      /**
       * Threading headers, so the customer's client files our reply with the
       * rest of the conversation instead of starting a new one.
       */
      inReplyTo: lastIncoming?.internetMessageId ?? null,
      references: [
        ...(lastIncoming?.references ?? []),
        ...(lastIncoming?.internetMessageId ? [lastIncoming.internetMessageId] : []),
      ],
    },
    { mailbox },
  )

  const stored = await recordOutgoing({
    owner,
    conversation,
    provider: provider.type,
    actor: owner,
    message: {
      from: { address: mailbox?.emailAddress ?? req.auth?.user?.email ?? null, name: null },
      to,
      cc,
      subject,
      bodyHtml: data.bodyHtml,
      bodyText: data.bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      inReplyTo: lastIncoming?.internetMessageId ?? null,
      references: [
        ...(lastIncoming?.references ?? []),
        ...(lastIncoming?.internetMessageId ? [lastIncoming.internetMessageId] : []),
      ],
      providerMessageId: sent?.providerMessageId ?? null,
      internetMessageId: sent?.internetMessageId ?? null,
      sentAt: new Date(),
    },
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: isMock ? 'Reply recorded (simulated send).' : 'Reply sent.',
    data: { mockMode: isMock, message: stored.toPublicJSON(), conversation: conversation.toSummaryJSON() },
  })
})

/** POST /api/v1/conversations/note */
export const addNote = asyncHandler(async (req, res) => {
  const data = noteSchema.parse(req.body)

  const note = await collaboration.addNote({
    owner: ownerOf(req),
    actor: ownerOf(req),
    leadId: data.leadId ?? null,
    conversationId: data.conversationId ?? null,
    body: data.body,
    isPinned: data.isPinned,
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: 'Note added.',
    data: { note: note.toPublicJSON() },
  })
})

/** PATCH /api/v1/conversations/note/:id/pin */
export const pinNote = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)
  const { isPinned } = z.object({ isPinned: z.boolean() }).parse(req.body)

  const note = await collaboration.setNotePinned({ owner: ownerOf(req), noteId: id, isPinned })

  return sendSuccess(res, {
    message: isPinned ? 'Note pinned.' : 'Note unpinned.',
    data: { note: note.toPublicJSON() },
  })
})

/** POST /api/v1/conversations/task */
export const createTask = asyncHandler(async (req, res) => {
  const data = taskSchema.parse(req.body)

  const task = await collaboration.createTask({
    owner: ownerOf(req),
    actor: ownerOf(req),
    ...data,
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: data.isFollowUp ? 'Follow-up scheduled.' : 'Task created.',
    data: { task: task.toPublicJSON() },
  })
})

/** POST /api/v1/conversations/followup — a task with a quick-pick interval. */
export const createFollowUp = asyncHandler(async (req, res) => {
  const data = taskSchema.parse({ ...req.body, isFollowUp: true })

  if (!data.preset && !data.dueAt) {
    throw ApiError.badRequest(
      `Choose an interval (${FOLLOW_UP_PRESETS.map((option) => option.id).join(', ')}) or give a date.`,
    )
  }

  const task = await collaboration.createTask({
    owner: ownerOf(req),
    actor: ownerOf(req),
    ...data,
    type: data.type ?? 'follow_up',
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: `Follow-up scheduled for ${task.dueAt?.toISOString().slice(0, 10) ?? 'later'}.`,
    data: { task: task.toPublicJSON() },
  })
})

/** PUT /api/v1/conversations/task/:id */
export const updateTask = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)
  const changes = taskUpdateSchema.parse(req.body)

  const task = await collaboration.updateTask({
    owner: ownerOf(req),
    actor: ownerOf(req),
    taskId: id,
    changes,
  })

  return sendSuccess(res, { message: 'Task updated.', data: { task: task.toPublicJSON() } })
})

/** POST /api/v1/conversations/:id/assign */
export const assign = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)
  const { assignedTo } = z.object({ assignedTo: objectId.nullable() }).parse(req.body)

  const conversation = await collaboration.assignConversation({
    owner: ownerOf(req),
    actor: ownerOf(req),
    conversationId: id,
    assignedTo,
  })

  return sendSuccess(res, {
    message: 'Conversation assigned.',
    data: { conversation: conversation.toSummaryJSON() },
  })
})

/** POST /api/v1/conversations/:id/status */
export const setStatus = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)
  const { status } = z
    .object({ status: z.enum(Conversation.MANUAL_STATUSES) })
    .parse(req.body)

  const conversation = await collaboration.setConversationStatus({
    owner: ownerOf(req),
    actor: ownerOf(req),
    conversationId: id,
    status,
  })

  return sendSuccess(res, {
    message: `Conversation ${status}.`,
    data: { conversation: conversation.toSummaryJSON() },
  })
})

/** POST /api/v1/conversations/:id/read */
export const markRead = asyncHandler(async (req, res) => {
  const conversation = await loadConversation(req)
  const { isRead } = z.object({ isRead: z.boolean().optional().default(true) }).parse(req.body ?? {})

  await ConversationMessage.updateMany(
    { conversation: conversation._id, direction: MESSAGE_DIRECTION.INCOMING },
    { $set: { isRead } },
  )

  await conversation.recalculate()

  return sendSuccess(res, {
    message: isRead ? 'Marked as read.' : 'Marked as unread.',
    data: { conversation: conversation.toSummaryJSON() },
  })
})

/**
 * POST /api/v1/conversations/:id/link
 *
 * Resolves an unmatched or mis-matched conversation by hand. Goes through the
 * same `attachLead` the sync uses, so a manual link produces identical state.
 */
export const link = asyncHandler(async (req, res) => {
  const conversation = await loadConversation(req)
  const { leadId } = z.object({ leadId: objectId }).parse(req.body)

  const updated = await attachLead({
    owner: ownerOf(req),
    conversation,
    leadId,
    actor: ownerOf(req),
    match: { strategy: 'lead_reference', confidence: 1 },
  })

  return sendSuccess(res, {
    message: 'Conversation linked to the enquiry.',
    data: { conversation: updated.toSummaryJSON() },
  })
})

/** POST /api/v1/conversations/:id/stage — move the enquiry from the thread. */
export const changeStage = asyncHandler(async (req, res) => {
  const conversation = await loadConversation(req)
  const { stage, reason } = z
    .object({ stage: z.string().min(1), reason: z.string().trim().max(512).optional() })
    .parse(req.body)

  if (!conversation.lead) throw ApiError.badRequest('This conversation is not linked to an enquiry.')

  const lead = await moveLeadStage({
    owner: ownerOf(req),
    leadId: conversation.lead,
    stage,
    actor: ownerOf(req),
    reason,
    conversation,
  })

  if (!lead) throw ApiError.notFound('The linked enquiry no longer exists.')

  return sendSuccess(res, { message: `Enquiry moved to ${stage}.`, data: { lead: lead.toSummaryJSON() } })
})

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/conversations/sync
 *
 * Pulls the inbox through the Phase 5 provider, turns what it finds into
 * conversations, then drains the attachment queue.
 *
 * ## Phase H4: the body moved, the behaviour did not
 *
 * The four steps this used to perform inline now live in `runReplySync`, which
 * the background worker also calls. The request shape, the response shape and
 * the outcome are unchanged — but there is now exactly one description in the
 * codebase of what a sync is, so the automatic and manual paths cannot drift.
 */
export const sync = asyncHandler(async (req, res) => {
  const { full, downloadAttachments } = z
    .object({
      full: z.boolean().optional().default(false),
      downloadAttachments: z.boolean().optional().default(true),
    })
    .parse(req.body ?? {})

  const result = await runReplySync({
    owner: ownerOf(req),
    auth: req.auth,
    full,
    downloadAttachments,
  })

  return sendSuccess(res, { message: result.message, data: result })
})

/** GET /api/v1/conversations/attachments/:id/download */
export const downloadAttachment = asyncHandler(async (req, res) => {
  const { id } = z.object({ id: objectId }).parse(req.params)

  const { attachment, stream, disposition } = await attachments.openAttachment({
    owner: ownerOf(req),
    attachmentId: id,
  })

  res.setHeader('Content-Type', attachment.mimeType)
  res.setHeader('Content-Length', attachment.size)
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${attachment.fileName.replace(/"/g, '')}"`,
  )
  /**
   * Stops a browser from second-guessing the declared type.
   *
   * Without it a text/plain file whose contents look like HTML can be rendered
   * as HTML, which turns a customer's attachment into stored XSS.
   */
  res.setHeader('X-Content-Type-Options', 'nosniff')

  return stream.pipe(res)
})

/** GET /api/v1/conversations/activity — the recent activity feed. */
export const activityFeed = asyncHandler(async (req, res) => {
  const { limit, lead } = z
    .object({
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
      lead: objectId.optional(),
    })
    .parse(req.query)

  const query = { owner: ownerOf(req) }
  if (lead) query.lead = lead

  const entries = await ConversationActivity.find(query).sort({ occurredAt: -1 }).limit(limit)

  return sendSuccess(res, {
    message: `${entries.length} activity entry/entries retrieved.`,
    data: { items: entries.map((entry) => entry.toPublicJSON()) },
  })
})
