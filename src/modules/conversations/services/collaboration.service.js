/**
 * The human side of a conversation: notes, tasks, follow-ups and assignment.
 *
 * Every action here writes to the timeline as well as to its own collection, so
 * "why did this deal stall" is answerable from one ordered list rather than by
 * cross-referencing four screens.
 */

import { Conversation } from '../../../models/conversation.model.js'
import { ConversationActivity } from '../../../models/conversationActivity.model.js'
import { Lead } from '../../../models/lead.model.js'
import { LeadTask } from '../../../models/leadTask.model.js'
import { User } from '../../../models/user.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import {
  ACTIVITY_TYPE,
  FOLLOW_UP_PRESETS,
  TASK_STATUS,
  TASK_TYPE,
  TASK_TYPE_LABELS,
} from '../constants/conversationConstants.js'

const log = createContextLogger('conversations')

/**
 * Tags that survive sanitisation of a rich-text note.
 *
 * An allow-list, not a block-list. Notes are written by staff and read by
 * staff, but they are stored and re-rendered as HTML, so an unfiltered paste
 * from a customer's mail would be stored XSS aimed at colleagues.
 */
const ALLOWED_NOTE_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'p', 'br', 'ul', 'ol', 'li',
  'blockquote', 'code', 'pre', 'h3', 'h4', 'span', 'div', 'a',
])

/**
 * Strips everything but a small set of formatting tags.
 *
 * Deliberately hand-rolled rather than pulling in a sanitiser: the allowed set
 * is tiny and closed, and the alternative is a dependency with its own advisory
 * history for something this module uses in exactly one place.
 *
 * @param {?string} html
 * @returns {string}
 */
export function sanitiseNoteHtml(html) {
  const source = String(html ?? '')
  if (!source) return ''

  return (
    source
      // Whole elements that can execute or load, contents included.
      .replace(/<(script|style|iframe|object|embed|form|link|meta)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(script|style|iframe|object|embed|form|link|meta)\b[^>]*\/?>/gi, '')
      // Any remaining tag: keep it only if allowed, and strip its attributes
      // apart from a plain href.
      .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tag, attributes) => {
        const name = tag.toLowerCase()
        if (!ALLOWED_NOTE_TAGS.has(name)) return ''

        if (match.startsWith('</')) return `</${name}>`

        if (name === 'a') {
          const href = /href\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? ''
          // `javascript:` and `data:` in an href are script execution on click.
          const safe = /^(https?:|mailto:)/i.test(href) ? href : ''
          return safe
            ? `<a href="${safe.replace(/"/g, '&quot;')}" rel="noopener noreferrer" target="_blank">`
            : '<a>'
        }

        return `<${name}>`
      })
  )
}

/** Plain text from sanitised HTML, for previews and search. */
export function noteToText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Resolves `@name` mentions to users.
 *
 * Matched against display name and the local part of the email, because people
 * type `@priya`, not `@Priya Raman <priya@…>`.
 */
export async function resolveMentions({ text }) {
  const handles = [...String(text ?? '').matchAll(/@([\w.-]{2,64})/g)].map((match) => match[1].toLowerCase())
  if (handles.length === 0) return []

  const users = await User.find({}).select('_id displayName email')

  const matched = users.filter((user) => {
    const display = String(user.displayName ?? '').toLowerCase().replace(/\s+/g, '')
    const local = String(user.email ?? '').split('@')[0].toLowerCase()
    return handles.some((handle) => display.startsWith(handle) || local === handle)
  })

  return matched.map((user) => user._id)
}

/**
 * Adds an internal note.
 *
 * `isInternal` is set unconditionally — there is no path through this function
 * that produces a customer-visible note, so a future change would have to be
 * deliberate rather than accidental.
 */
export async function addNote({ owner, actor, leadId = null, conversationId = null, body, isPinned = false }) {
  if (!leadId && !conversationId) {
    throw ApiError.badRequest('A note must belong to an enquiry or a conversation.')
  }

  const html = sanitiseNoteHtml(body)
  const text = noteToText(html)

  if (!text.trim()) throw ApiError.badRequest('The note is empty.')

  const conversation = conversationId
    ? await Conversation.findOne({ _id: conversationId, owner, isDeleted: false })
    : null

  const resolvedLead = leadId ?? conversation?.lead ?? null
  const lead = resolvedLead ? await Lead.findOne({ _id: resolvedLead, owner, isDeleted: false }) : null

  if (conversationId && !conversation) throw ApiError.notFound('No conversation with that id exists.')
  if (leadId && !lead) throw ApiError.notFound('No enquiry with that id exists.')

  const mentions = await resolveMentions({ text })

  const note = await ConversationActivity.record({
    owner,
    type: ACTIVITY_TYPE.NOTE_ADDED,
    summary: text.slice(0, 200),
    body: html,
    lead: lead?._id ?? null,
    conversation: conversation?._id ?? null,
    company: lead?.company ?? conversation?.company ?? null,
    actor,
    mentions,
    isPinned,
  })

  if (mentions.length > 0) {
    log.info('Note mentions users', { note: note._id.toString(), mentions: mentions.length })
  }

  return note
}

/** Pins or unpins a note so it sits above the timeline. */
export async function setNotePinned({ owner, noteId, isPinned }) {
  const note = await ConversationActivity.findOne({ _id: noteId, owner, type: ACTIVITY_TYPE.NOTE_ADDED })
  if (!note) throw ApiError.notFound('No note with that id exists.')

  note.isPinned = Boolean(isPinned)
  await note.save()

  return note
}

/**
 * Creates a task or a follow-up.
 *
 * `preset` maps the quick-pick buttons (tomorrow, 3 days, a week) onto a due
 * date, so the client never computes one — a client-side date is in the
 * browser's timezone and would drift against the server's reminder sweep.
 */
export async function createTask({
  owner,
  actor,
  leadId = null,
  conversationId = null,
  messageId = null,
  type = TASK_TYPE.OTHER,
  title = null,
  notes = null,
  dueAt = null,
  preset = null,
  priority = 'normal',
  assignedTo = null,
  isFollowUp = false,
}) {
  const conversation = conversationId
    ? await Conversation.findOne({ _id: conversationId, owner, isDeleted: false })
    : null

  if (conversationId && !conversation) throw ApiError.notFound('No conversation with that id exists.')

  const resolvedLeadId = leadId ?? conversation?.lead ?? null
  const lead = resolvedLeadId ? await Lead.findOne({ _id: resolvedLeadId, owner, isDeleted: false }) : null

  if (leadId && !lead) throw ApiError.notFound('No enquiry with that id exists.')
  if (!lead && !conversation) throw ApiError.badRequest('A task must belong to an enquiry or a conversation.')

  let due = dueAt ? new Date(dueAt) : null

  if (!due && preset) {
    const chosen = FOLLOW_UP_PRESETS.find((option) => option.id === preset)
    if (!chosen) throw ApiError.badRequest(`"${preset}" is not a follow-up interval.`)

    // Set to 09:00 UTC rather than "now plus N days": a reminder that fires at
    // 23:47 because that is when the note was written is useless.
    due = new Date(Date.now() + chosen.days * 86_400_000)
    due.setUTCHours(9, 0, 0, 0)
  }

  const task = await LeadTask.create({
    owner,
    createdBy: actor,
    lead: lead?._id ?? null,
    conversation: conversation?._id ?? null,
    company: lead?.company ?? conversation?.company ?? null,
    message: messageId,
    type,
    title: title ?? TASK_TYPE_LABELS[type] ?? 'Follow up',
    notes,
    dueAt: due,
    priority,
    assignedTo: assignedTo ?? actor,
    isFollowUp,
  })

  await ConversationActivity.record({
    owner,
    type: isFollowUp ? ACTIVITY_TYPE.FOLLOW_UP_SCHEDULED : ACTIVITY_TYPE.TASK_CREATED,
    summary: due
      ? `${task.title} — due ${due.toISOString().slice(0, 10)}`
      : task.title,
    lead: task.lead,
    conversation: task.conversation,
    company: task.company,
    task: task._id,
    message: messageId,
    actor,
    detail: { type, dueAt: due, priority },
  })

  return task
}

/** Updates a task; completing it writes a timeline entry. */
export async function updateTask({ owner, actor, taskId, changes }) {
  const task = await LeadTask.findOne({ _id: taskId, owner, isDeleted: false })
  if (!task) throw ApiError.notFound('No task with that id exists.')

  const wasDone = task.status === TASK_STATUS.DONE

  for (const field of ['title', 'notes', 'type', 'priority', 'dueAt', 'assignedTo']) {
    if (changes[field] !== undefined) task[field] = changes[field]
  }

  if (changes.status !== undefined && changes.status !== task.status) {
    if (changes.status === TASK_STATUS.DONE) task.complete(actor)
    else {
      task.status = changes.status
      task.completedAt = null
      task.completedBy = null
    }
  }

  await task.save()

  if (!wasDone && task.status === TASK_STATUS.DONE) {
    await ConversationActivity.record({
      owner,
      type: ACTIVITY_TYPE.TASK_COMPLETED,
      summary: `Completed: ${task.title}`,
      lead: task.lead,
      conversation: task.conversation,
      company: task.company,
      task: task._id,
      actor,
    })
  }

  return task
}

/** Assigns a conversation, and its open tasks with it. */
export async function assignConversation({ owner, actor, conversationId, assignedTo }) {
  const conversation = await Conversation.findOne({ _id: conversationId, owner, isDeleted: false })
  if (!conversation) throw ApiError.notFound('No conversation with that id exists.')

  const previous = conversation.assignedTo?.toString() ?? null
  conversation.assignedTo = assignedTo
  await conversation.save()

  /**
   * Unassigned tasks follow the conversation.
   *
   * A thread handed to a colleague carries its outstanding work; leaving the
   * tasks behind means the new owner inherits a conversation with no visible
   * obligations. Tasks already assigned to a named person are left alone.
   */
  await LeadTask.updateMany(
    {
      owner,
      conversation: conversation._id,
      status: { $in: [TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS] },
      $or: [{ assignedTo: null }, { assignedTo: previous }],
    },
    { $set: { assignedTo } },
  )

  const user = assignedTo ? await User.findById(assignedTo).select('displayName email') : null

  await ConversationActivity.record({
    owner,
    type: ACTIVITY_TYPE.ASSIGNED,
    summary: user ? `Assigned to ${user.displayName ?? user.email}` : 'Unassigned',
    lead: conversation.lead,
    conversation: conversation._id,
    company: conversation.company,
    actor,
    detail: { from: previous, to: assignedTo?.toString() ?? null },
  })

  return conversation
}

/** Changes a conversation's status by hand. */
export async function setConversationStatus({ owner, actor, conversationId, status }) {
  const conversation = await Conversation.findOne({ _id: conversationId, owner, isDeleted: false })
  if (!conversation) throw ApiError.notFound('No conversation with that id exists.')

  const previous = conversation.status
  conversation.status = status
  conversation.closedAt = status === 'closed' ? new Date() : null
  conversation.archivedAt = status === 'archived' ? new Date() : null
  await conversation.save()

  await ConversationActivity.record({
    owner,
    type: ACTIVITY_TYPE.STATUS_CHANGED,
    summary: `Conversation ${status}`,
    lead: conversation.lead,
    conversation: conversation._id,
    company: conversation.company,
    actor,
    detail: { from: previous, to: status },
  })

  return conversation
}

/**
 * The work list for a user.
 *
 * Overdue first, then due soonest. A flat "sorted by due date" list buries the
 * overdue items once there are more than a screenful of upcoming ones.
 */
export async function listTasks({ owner, assignedTo = null, status = null, overdue = false, page = 1, limit = 50 }) {
  const query = { owner, isDeleted: false }

  if (assignedTo) query.assignedTo = assignedTo
  if (status) query.status = status
  else query.status = { $in: [TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS] }

  if (overdue) query.dueAt = { $lte: new Date(), $ne: null }

  const skip = (page - 1) * limit

  const [items, total] = await Promise.all([
    LeadTask.find(query).sort({ dueAt: 1, priority: -1 }).skip(skip).limit(limit),
    LeadTask.countDocuments(query),
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
 * Marks due follow-ups as reminded and writes them to the timeline.
 *
 * The reminder flag is persisted, so a task is announced once. Deriving "due"
 * from the date alone would re-notify on every sweep until someone closed it.
 */
export async function sweepDueFollowUps({ owner = null, now = new Date() } = {}) {
  const query = {
    isDeleted: false,
    status: { $in: [TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS] },
    dueAt: { $ne: null, $lte: now },
    reminderSentAt: null,
  }
  if (owner) query.owner = owner

  const due = await LeadTask.find(query).limit(500)

  for (const task of due) {
    task.reminderSentAt = new Date()
    await task.save()

    await ConversationActivity.record({
      owner: task.owner,
      type: ACTIVITY_TYPE.FOLLOW_UP_DUE,
      summary: `Due now: ${task.title}`,
      lead: task.lead,
      conversation: task.conversation,
      company: task.company,
      task: task._id,
      detail: { dueAt: task.dueAt },
    })
  }

  if (due.length > 0) log.info('Follow-up reminders swept', { count: due.length })

  return { reminded: due.length, tasks: due }
}

export default {
  addNote,
  setNotePinned,
  createTask,
  updateTask,
  assignConversation,
  setConversationStatus,
  listTasks,
  sweepDueFollowUps,
  sanitiseNoteHtml,
  noteToText,
  resolveMentions,
}
