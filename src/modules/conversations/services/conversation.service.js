/**
 * Reading the conversation CRM.
 *
 * Lists, filters, search, the thread view, the lead timeline and the dashboard
 * widgets. Everything is scoped by `owner`; nothing accepts a raw Mongo filter
 * from a caller, because that is how a filter parameter becomes a data leak.
 */

import mongoose from 'mongoose'

import { Company } from '../../../models/company.model.js'
import { Contact } from '../../../models/contact.model.js'
import { Conversation } from '../../../models/conversation.model.js'
import { ConversationActivity } from '../../../models/conversationActivity.model.js'
import { ConversationAttachment } from '../../../models/conversationAttachment.model.js'
import { ConversationMessage } from '../../../models/conversationMessage.model.js'
import { Lead } from '../../../models/lead.model.js'
import { LeadTask } from '../../../models/leadTask.model.js'
import {
  ACTIVE_CONVERSATION_STATUSES,
  CONVERSATION_STATUS,
  MESSAGE_DIRECTION,
  TASK_STATUS,
} from '../constants/conversationConstants.js'

/** Named filters the list screen offers. */
export const CONVERSATION_FILTERS = Object.freeze({
  ALL: 'all',
  UNREAD: 'unread',
  AWAITING_REPLY: 'awaiting_reply',
  NEEDS_RESPONSE: 'needs_response',
  ASSIGNED_TO_ME: 'assigned_to_me',
  UNASSIGNED: 'unassigned',
  TODAY: 'today',
  THIS_WEEK: 'this_week',
  HAS_ATTACHMENTS: 'has_attachments',
  HIGH_PRIORITY: 'high_priority',
  UNMATCHED: 'unmatched',
  CLOSED: 'closed',
  ARCHIVED: 'archived',
})

export const CONVERSATION_FILTER_VALUES = Object.freeze(Object.values(CONVERSATION_FILTERS))

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(String(value)) : null
}

function startOfToday() {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  return date
}

/**
 * Builds a Mongo filter from vetted parameters.
 *
 * Every branch is an explicit field; a caller cannot introduce an operator.
 */
export function buildConversationFilter({
  owner,
  userId = null,
  filter = CONVERSATION_FILTERS.ALL,
  lead = null,
  company = null,
  contact = null,
  campaign = null,
  assignedTo = null,
  status = null,
  search = null,
} = {}) {
  const query = { owner, isDeleted: false }

  if (lead) query.lead = toObjectId(lead)
  if (company) query.company = toObjectId(company)
  if (contact) query.contact = toObjectId(contact)
  if (campaign) query.campaign = toObjectId(campaign)
  if (assignedTo) query.assignedTo = toObjectId(assignedTo)
  if (status) query.status = status

  switch (filter) {
    case CONVERSATION_FILTERS.UNREAD:
      query.unreadCount = { $gt: 0 }
      break

    case CONVERSATION_FILTERS.AWAITING_REPLY:
      query.status = CONVERSATION_STATUS.AWAITING_REPLY
      break

    case CONVERSATION_FILTERS.NEEDS_RESPONSE:
      query.status = CONVERSATION_STATUS.AWAITING_US
      break

    case CONVERSATION_FILTERS.ASSIGNED_TO_ME:
      query.assignedTo = toObjectId(userId)
      break

    case CONVERSATION_FILTERS.UNASSIGNED:
      query.assignedTo = null
      query.status = { $in: ACTIVE_CONVERSATION_STATUSES }
      break

    case CONVERSATION_FILTERS.TODAY:
      query.lastActivityAt = { $gte: startOfToday() }
      break

    case CONVERSATION_FILTERS.THIS_WEEK:
      query.lastActivityAt = { $gte: new Date(Date.now() - 7 * 86_400_000) }
      break

    case CONVERSATION_FILTERS.HAS_ATTACHMENTS:
      query.attachmentCount = { $gt: 0 }
      break

    case CONVERSATION_FILTERS.HIGH_PRIORITY:
      // Pinned, or waiting on us for more than two days. Priority in a sales
      // inbox is about neglect, not about a flag the customer set.
      query.$or = [
        { isPinned: true },
        {
          status: CONVERSATION_STATUS.AWAITING_US,
          lastActivityAt: { $lte: new Date(Date.now() - 2 * 86_400_000) },
        },
      ]
      break

    case CONVERSATION_FILTERS.UNMATCHED:
      query.lead = null
      break

    case CONVERSATION_FILTERS.CLOSED:
      query.status = CONVERSATION_STATUS.CLOSED
      break

    case CONVERSATION_FILTERS.ARCHIVED:
      query.status = CONVERSATION_STATUS.ARCHIVED
      break

    default:
      // The working list hides finished threads unless asked for.
      if (!status) query.status = { $in: ACTIVE_CONVERSATION_STATUSES }
  }

  if (search) {
    const escaped = new RegExp(escapeRegex(search), 'i')
    query.$and = [
      ...(query.$and ?? []),
      { $or: [{ subject: escaped }, { counterpartyEmail: escaped }, { counterpartyName: escaped }] },
    ]
  }

  return query
}

/** Lists conversations. Pinned first, then newest activity. */
export async function listConversations({ owner, page = 1, limit = 50, ...criteria }) {
  const query = buildConversationFilter({ owner, ...criteria })
  const skip = (page - 1) * limit

  const [items, total] = await Promise.all([
    Conversation.find(query).sort({ isPinned: -1, lastActivityAt: -1 }).skip(skip).limit(limit),
    Conversation.countDocuments(query),
  ])

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: skip + items.length < total,
      hasPrevious: page > 1,
    },
  }
}

/**
 * One conversation with everything the three-panel view needs.
 *
 * Assembled in one call rather than five round trips, because the middle and
 * right panels render together and a staggered load makes the page jump.
 */
export async function getConversationDetail({ owner, conversationId }) {
  const conversation = await Conversation.findOne({ _id: conversationId, owner, isDeleted: false })
  if (!conversation) return null

  const [messages, attachments, activity, lead] = await Promise.all([
    ConversationMessage.find({ conversation: conversation._id, isDeleted: false }).sort({ occurredAt: 1 }),
    ConversationAttachment.find({ conversation: conversation._id, isDeleted: false }).sort({ createdAt: 1 }),
    ConversationActivity.find({ owner, conversation: conversation._id }).sort({ occurredAt: -1 }).limit(50),
    conversation.lead ? Lead.findById(conversation.lead) : null,
  ])

  const [company, contact, tasks] = await Promise.all([
    conversation.company ? Company.findById(conversation.company) : null,
    conversation.contact ? Contact.findById(conversation.contact) : null,
    LeadTask.find({
      owner,
      isDeleted: false,
      $or: [
        { conversation: conversation._id },
        ...(conversation.lead ? [{ lead: conversation.lead }] : []),
      ],
    })
      .sort({ status: 1, dueAt: 1 })
      .limit(50),
  ])

  // Attachments are grouped per message so the thread can render them inline
  // without the client having to bucket a flat list.
  const attachmentsByMessage = new Map()
  for (const attachment of attachments) {
    const key = attachment.message.toString()
    if (!attachmentsByMessage.has(key)) attachmentsByMessage.set(key, [])
    attachmentsByMessage.get(key).push(attachment.toPublicJSON())
  }

  return {
    conversation: conversation.toPublicJSON(),
    messages: messages.map((message) => ({
      ...message.toPublicJSON(),
      attachments: attachmentsByMessage.get(message._id.toString()) ?? [],
    })),
    attachments: attachments.map((attachment) => attachment.toPublicJSON()),
    activity: activity.map((entry) => entry.toPublicJSON()),
    tasks: tasks.map((task) => task.toPublicJSON()),
    lead: lead?.toPublicJSON() ?? null,
    company: company?.toPublicJSON() ?? null,
    contact: contact?.toPublicJSON() ?? null,
  }
}

/**
 * The full business history of one enquiry.
 *
 * Import, campaign, sends, replies, notes, tasks, stage changes — one ordered
 * list. Everything is already an activity row, so this is a single indexed read
 * rather than a merge across five collections.
 */
export async function getLeadTimeline({ owner, leadId, limit = 200 }) {
  const lead = await Lead.findOne({ _id: leadId, owner, isDeleted: false })
  if (!lead) return null

  const [activity, conversations, tasks, attachments, pinned, messages] = await Promise.all([
    ConversationActivity.find({ owner, lead: lead._id }).sort({ occurredAt: -1 }).limit(limit),
    Conversation.find({ owner, lead: lead._id, isDeleted: false }).sort({ lastActivityAt: -1 }),
    LeadTask.find({ owner, lead: lead._id, isDeleted: false }).sort({ status: 1, dueAt: 1 }),
    ConversationAttachment.find({ owner, lead: lead._id, isDeleted: false }).sort({ createdAt: -1 }),
    ConversationActivity.find({ owner, lead: lead._id, isPinned: true }).sort({ occurredAt: -1 }),

    /**
     * The correspondence itself (Phase H4).
     *
     * Added because the enquiry screen shows the thread — our introduction, the
     * customer's answer, and everything after — and fetching the activity feed
     * and then a second request per conversation to get its messages would make
     * the one screen a salesperson lives in the slowest in the product.
     *
     * Oldest first: this is read as a conversation, top to bottom, unlike the
     * activity feed which is read as "what changed most recently".
     */
    ConversationMessage.find({ owner, lead: lead._id })
      .sort({ occurredAt: 1 })
      .limit(limit),
  ])

  return {
    lead: lead.toPublicJSON(),
    timeline: activity.map((entry) => entry.toPublicJSON()),
    pinnedNotes: pinned.map((entry) => entry.toPublicJSON()),
    conversations: conversations.map((conversation) => conversation.toSummaryJSON()),
    messages: messages.map((message) => message.toPublicJSON()),
    tasks: tasks.map((task) => task.toPublicJSON()),
    attachments: attachments.map((attachment) => attachment.toPublicJSON()),
  }
}

/**
 * Search across conversations, messages, attachments, leads and companies.
 *
 * Five targeted queries rather than one aggregation: a salesperson typing
 * "Dubai" may want the thread, the sentence inside a reply, the PDF, the
 * enquiry or the agency, and collapsing them into one ranked list would bury
 * four of the five.
 */
export async function searchEverything({ owner, query, limit = 10 }) {
  const text = String(query ?? '').trim()
  if (!text) {
    return { query: text, conversations: [], messages: [], attachments: [], leads: [], companies: [], total: 0 }
  }

  const escaped = new RegExp(escapeRegex(text), 'i')

  const [conversations, messages, attachments, leads, companies] = await Promise.all([
    Conversation.find({
      owner,
      isDeleted: false,
      $or: [{ subject: escaped }, { counterpartyEmail: escaped }, { counterpartyName: escaped }],
    })
      .sort({ lastActivityAt: -1 })
      .limit(limit),

    ConversationMessage.find({
      owner,
      isDeleted: false,
      $or: [{ subject: escaped }, { bodyStripped: escaped }],
    })
      .sort({ occurredAt: -1 })
      .limit(limit)
      .select('conversation lead subject bodyStripped from direction occurredAt'),

    ConversationAttachment.find({ owner, isDeleted: false, fileName: escaped })
      .sort({ createdAt: -1 })
      .limit(limit),

    Lead.find({
      owner,
      isDeleted: false,
      $or: [
        { reference: escaped },
        { contactPerson: escaped },
        { companyName: escaped },
        { email: escaped },
        { phones: escaped },
        { city: escaped },
      ],
    })
      .sort({ quoteDate: -1 })
      .limit(limit),

    Company.find({ owner, isDeleted: false, $or: [{ companyName: escaped }, { emailDomain: escaped }] })
      .sort({ leadCount: -1 })
      .limit(limit),
  ])

  return {
    query: text,
    conversations: conversations.map((c) => c.toSummaryJSON()),
    messages: messages.map((message) => ({
      id: message._id.toString(),
      conversation: message.conversation.toString(),
      lead: message.lead?.toString() ?? null,
      subject: message.subject,
      // A snippet around the hit, not the whole body — the result list is a
      // list, not a reader.
      snippet: snippetAround(message.bodyStripped, text),
      from: message.from,
      direction: message.direction,
      occurredAt: message.occurredAt,
    })),
    attachments: attachments.map((a) => a.toPublicJSON()),
    leads: leads.map((lead) => lead.toSummaryJSON()),
    companies: companies.map((company) => company.toPublicJSON()),
    total:
      conversations.length + messages.length + attachments.length + leads.length + companies.length,
  }
}

/** Extracts ~160 characters around the first occurrence of `term`. */
function snippetAround(body, term) {
  const text = String(body ?? '').replace(/\s+/g, ' ')
  const index = text.toLowerCase().indexOf(term.toLowerCase())

  if (index === -1) return text.slice(0, 160)

  const start = Math.max(0, index - 60)
  const end = Math.min(text.length, index + term.length + 100)

  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * Dashboard widgets.
 *
 * One query per widget: cheap, independently cacheable, and a failure in one
 * does not blank the panel.
 */
export async function conversationStatistics({ owner, userId = null }) {
  const today = startOfToday()
  const weekAgo = new Date(Date.now() - 7 * 86_400_000)

  const [
    unreadReplies,
    todaysReplies,
    awaitingResponse,
    awaitingCustomer,
    openConversations,
    closedConversations,
    unmatched,
    followUpsDue,
    openTasks,
    assignedToMe,
    responseTimes,
  ] = await Promise.all([
    Conversation.countDocuments({ owner, isDeleted: false, unreadCount: { $gt: 0 } }),
    ConversationMessage.countDocuments({
      owner,
      direction: MESSAGE_DIRECTION.INCOMING,
      occurredAt: { $gte: today },
    }),
    Conversation.countDocuments({ owner, isDeleted: false, status: CONVERSATION_STATUS.AWAITING_US }),
    Conversation.countDocuments({ owner, isDeleted: false, status: CONVERSATION_STATUS.AWAITING_REPLY }),
    Conversation.countDocuments({ owner, isDeleted: false, status: { $in: ACTIVE_CONVERSATION_STATUSES } }),
    Conversation.countDocuments({ owner, isDeleted: false, status: CONVERSATION_STATUS.CLOSED }),
    Conversation.countDocuments({ owner, isDeleted: false, lead: null }),
    LeadTask.countDocuments({
      owner,
      isDeleted: false,
      status: { $in: [TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS] },
      dueAt: { $lte: new Date() },
    }),
    LeadTask.countDocuments({
      owner,
      isDeleted: false,
      status: { $in: [TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS] },
    }),
    userId
      ? Conversation.countDocuments({ owner, isDeleted: false, assignedTo: userId, status: { $in: ACTIVE_CONVERSATION_STATUSES } })
      : 0,
    Conversation.aggregate([
      { $match: { owner, isDeleted: false, firstResponseMs: { $ne: null }, lastActivityAt: { $gte: weekAgo } } },
      { $group: { _id: null, average: { $avg: '$firstResponseMs' }, count: { $sum: 1 } } },
    ]),
  ])

  const average = responseTimes[0]?.average ?? null

  return {
    unreadReplies,
    todaysReplies,
    awaitingResponse,
    awaitingCustomer,
    openConversations,
    closedConversations,
    unmatched,
    followUpsDue,
    openTasks,
    assignedToMe,
    /**
     * Null rather than 0 when nothing has been measured.
     *
     * "0 hours average response" on an account that has never replied reads as
     * instant service; an em dash reads as what it is.
     */
    averageResponseMs: average === null ? null : Math.round(average),
    averageResponseHours: average === null ? null : Math.round((average / 3_600_000) * 10) / 10,
    measuredOver: responseTimes[0]?.count ?? 0,
  }
}

/** Counts per named filter, for the sidebar badges. */
export async function filterCounts({ owner, userId = null }) {
  const entries = await Promise.all(
    CONVERSATION_FILTER_VALUES.map(async (filter) => {
      const query = buildConversationFilter({ owner, userId, filter })
      return [filter, await Conversation.countDocuments(query)]
    }),
  )

  return Object.fromEntries(entries)
}

export default {
  listConversations,
  getConversationDetail,
  getLeadTimeline,
  searchEverything,
  conversationStatistics,
  filterCounts,
  buildConversationFilter,
  CONVERSATION_FILTERS,
}
