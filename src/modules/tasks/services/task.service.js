/**
 * Task management (Phase 18).
 *
 * ## Who may do what, and where that is decided
 *
 * Two capabilities, both existing — no permission was added to the matrix:
 *
 *   `users.view`   — may read about other people. Gates reading somebody
 *                    else's tasks and the cross-user boards.
 *   `users.delete` — the owner-and-admin capability Phase 17.1 already uses for
 *                    "binding decisions about an employee's record". Gates
 *                    creating, reassigning and deleting a task, which is a
 *                    binding decision about what somebody must do.
 *
 * Everything else is self-service and needs no permission: the **assignee**
 * may move their own task's status, set its progress, comment and attach. That
 * split is enforced here, in the service, so it holds however the endpoint is
 * reached.
 *
 * ## Scope is a parameter, never a guess
 *
 * Every read takes an explicit `viewer` and an explicit scope. A handler that
 * decided for itself whether to widen the query is a handler that can widen it
 * wrongly; here the route has already established what the caller may see.
 *
 * ## Notifications are raised deliberately, not from the audit map
 *
 * `notifyFromAudit` can address an actor, a subject or the organization. A task
 * has a different audience: **the people on it** — the assignee and whoever
 * assigned it — minus whoever just acted. That is not expressible in the map,
 * so this module calls `notify()` directly with computed recipients while
 * `recordAudit()` writes the trail. Both are the centralized services; only the
 * routing is local.
 */

import { Types } from 'mongoose'

import { DOCUMENT_MIME_TYPES } from '../../../constants/employeeProfile.js'
import {
  MAX_TASK_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENTS,
  OPEN_TASK_STATUSES,
  TASK_PRIORITY_RANK,
  TASK_STATUS,
  TERMINAL_TASK_STATUSES,
  isOverdue,
  progressForStatus,
} from '../../../constants/tasks.js'
import { NOTIFICATION_TYPE } from '../../../models/notification.model.js'
import { Task } from '../../../models/task.model.js'
import { User } from '../../../models/user.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import { linkFor, notify } from '../../notifications/services/notifier.service.js'
import {
  removeFile,
  resolveStoredPath,
  sniffMimeType,
  storeFile,
} from '../../profile/services/documentStorage.service.js'

const log = createContextLogger('tasks')

/** Fields needed to name a person on a task. */
const PERSON_FIELDS = 'displayName email avatarUrl role'

/**
 * Loads a task or refuses.
 *
 * 404 for "no such task" and 403 for "not yours" are kept distinct on purpose:
 * a permission failure that answers 404 sends an operator looking for a missing
 * record instead of a missing grant.
 */
async function loadTask(taskId) {
  const task = await Task.findOne({ _id: taskId, isDeleted: { $ne: true } })

  if (!task) throw ApiError.notFound('That task could not be found.')

  return task
}

/** Whether this viewer is on the task at all. */
const isParticipant = (task, viewerId) =>
  String(task.assignee) === String(viewerId) || String(task.createdBy) === String(viewerId)

/**
 * Who should hear about a change to this task.
 *
 * The assignee and the author, minus whoever caused it — nobody needs telling
 * what they just did. Returns strings, deduplicated.
 */
function audienceFor(task, actorId) {
  const actor = String(actorId)

  return [...new Set([String(task.assignee), String(task.createdBy)])].filter((id) => id !== actor)
}

/** Raises one task notification. Never throws — a bell is not worth a 500. */
async function raise({ type, task, recipients, title, body, actorEmail, suffix }) {
  if (recipients.length === 0) return 0

  try {
    return await notify({
      type,
      recipients,
      title,
      body: body ?? null,
      link: linkFor(type, { id: task._id }),
      /**
       * Scoped to the task *and the event*, so re-delivery is idempotent while
       * two different things happening to one task still produce two bells.
       */
      dedupeKey: `task:${task._id}:${suffix}`,
      target: { type: 'task', id: task._id },
      actorEmail: actorEmail ?? null,
    })
  } catch (error) {
    log.warn('Task notification could not be raised', { taskId: String(task._id), message: error.message })
    return 0
  }
}

/** Attaches the people, so a list does not need one lookup per row. */
async function withPeople(tasks, viewerId) {
  const ids = [
    ...new Set(tasks.flatMap((task) => [String(task.assignee), String(task.createdBy)])),
  ].filter(Boolean)

  const people = await User.find({ _id: { $in: ids } }).select(PERSON_FIELDS).lean()
  const byId = new Map(people.map((person) => [String(person._id), person]))

  const describe = (id) => {
    const person = byId.get(String(id))
    if (!person) return null

    return {
      id: String(person._id),
      displayName: person.displayName ?? null,
      email: person.email ?? null,
      avatarUrl: person.avatarUrl ?? null,
    }
  }

  return tasks.map((task) => ({
    ...task.toPublicJSON({ viewerId }),
    assigneeUser: describe(task.assignee),
    createdByUser: describe(task.createdBy),
  }))
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Lists tasks.
 *
 * @param {object} params
 * @param {object} params.viewer          The signed-in user.
 * @param {boolean} params.canSeeEveryone Whether the route established that.
 * @param {object} params.query           Filters, already validated.
 */
export async function listTasks({ viewer, canSeeEveryone, query = {} }) {
  const {
    assignee,
    status,
    priority,
    scope = 'assigned',
    search,
    dueBefore,
    dueAfter,
    overdue,
    page = 1,
    limit = 25,
    sort = 'smart',
  } = query

  const filter = { isDeleted: { $ne: true } }

  /**
   * The scope decides whose tasks these are, and the permission decides whether
   * the caller may ask for anybody else's.
   *
   * `assigned` and `created` are always safe — they are scoped to the caller.
   * `all`, and any explicit `assignee`, require the cross-user capability, and
   * are refused rather than silently narrowed: quietly returning your own tasks
   * when you asked for everybody's is a lie about what you are looking at.
   */
  if (scope === 'created') {
    filter.createdBy = viewer._id
  } else if (scope === 'all' || assignee) {
    if (!canSeeEveryone) {
      throw ApiError.forbidden('You may only read your own tasks.')
    }
    if (assignee) filter.assignee = new Types.ObjectId(String(assignee))
  } else {
    filter.assignee = viewer._id
  }

  if (status?.length) filter.status = { $in: status }
  if (priority?.length) filter.priority = { $in: priority }

  if (dueBefore || dueAfter) {
    filter.dueAt = {}
    if (dueAfter) filter.dueAt.$gte = dueAfter
    if (dueBefore) filter.dueAt.$lte = dueBefore
  }

  // Overdue is derived, not stored: a stored flag would need a job to keep it
  // true and would be wrong between runs.
  if (overdue) {
    filter.dueAt = { ...(filter.dueAt ?? {}), $lt: new Date() }
    filter.status = { $in: OPEN_TASK_STATUSES }
  }

  if (search) {
    const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(safe, 'i')
    filter.$or = [{ title: pattern }, { description: pattern }]
  }

  const sorts = {
    /** Urgent first, then soonest due, then newest. The default for a to-do list. */
    smart: { priorityRank: -1, dueAt: 1, createdAt: -1 },
    due: { dueAt: 1, priorityRank: -1 },
    created: { createdAt: -1 },
    priority: { priorityRank: -1, createdAt: -1 },
    status: { status: 1, priorityRank: -1 },
  }

  const [rows, total] = await Promise.all([
    Task.find(filter)
      .sort(sorts[sort] ?? sorts.smart)
      .skip((page - 1) * limit)
      .limit(limit),
    Task.countDocuments(filter),
  ])

  return {
    items: await withPeople(rows, viewer._id),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    meta: { scope, source: 'live-collection', generatedAt: new Date().toISOString() },
  }
}

/** One task, with its comments and attachments. */
export async function getTask({ taskId, viewer, canSeeEveryone }) {
  const task = await loadTask(taskId)

  if (!canSeeEveryone && !isParticipant(task, viewer._id)) {
    throw ApiError.forbidden('That task is not yours to read.')
  }

  const [described] = await withPeople([task], viewer._id)

  return described
}

/**
 * The counts every dashboard opens with.
 *
 * One aggregation rather than six `countDocuments` calls: the six answers come
 * from the same scan, and six round trips for one card is the sort of thing
 * that makes a dashboard feel slow for no reason.
 */
export async function taskSummary({ userId = null, from = null, to = null } = {}) {
  const now = new Date()

  const endOfToday = new Date(now)
  endOfToday.setUTCHours(23, 59, 59, 999)

  const startOfToday = new Date(now)
  startOfToday.setUTCHours(0, 0, 0, 0)

  const match = { isDeleted: { $ne: true } }
  if (userId) match.assignee = new Types.ObjectId(String(userId))

  const [row] = await Task.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        open: { $sum: { $cond: [{ $in: ['$status', OPEN_TASK_STATUSES] }, 1, 0] } },
        todo: { $sum: { $cond: [{ $eq: ['$status', TASK_STATUS.TODO] }, 1, 0] } },
        inProgress: { $sum: { $cond: [{ $eq: ['$status', TASK_STATUS.IN_PROGRESS] }, 1, 0] } },
        done: { $sum: { $cond: [{ $eq: ['$status', TASK_STATUS.DONE] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$status', TASK_STATUS.CANCELLED] }, 1, 0] } },
        dueToday: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $in: ['$status', OPEN_TASK_STATUSES] },
                  { $gte: ['$dueAt', startOfToday] },
                  { $lte: ['$dueAt', endOfToday] },
                ],
              },
              1,
              0,
            ],
          },
        },
        overdue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $in: ['$status', OPEN_TASK_STATUSES] },
                  { $ne: ['$dueAt', null] },
                  { $lt: ['$dueAt', now] },
                ],
              },
              1,
              0,
            ],
          },
        },
        completedToday: {
          $sum: { $cond: [{ $gte: ['$completedAt', startOfToday] }, 1, 0] },
        },
        /** Only over tasks finished in the window, in milliseconds. */
        completionMs: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', TASK_STATUS.DONE] },
                  ...(from ? [{ $gte: ['$completedAt', from] }] : []),
                  ...(to ? [{ $lte: ['$completedAt', to] }] : []),
                ],
              },
              { $subtract: ['$completedAt', '$createdAt'] },
              0,
            ],
          },
        },
        completedInWindow: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', TASK_STATUS.DONE] },
                  ...(from ? [{ $gte: ['$completedAt', from] }] : []),
                  ...(to ? [{ $lte: ['$completedAt', to] }] : []),
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ])

  const summary = row ?? {
    total: 0, open: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0,
    dueToday: 0, overdue: 0, completedToday: 0, completionMs: 0, completedInWindow: 0,
  }

  /**
   * Rates are null when nothing has been assigned or finished.
   *
   * Zero percent completion reads as failure; "no tasks yet" is not a failure,
   * and the difference matters on a screen somebody is judged by.
   */
  const decided = summary.done + summary.cancelled

  return {
    total: summary.total,
    open: summary.open,
    todo: summary.todo,
    inProgress: summary.inProgress,
    done: summary.done,
    cancelled: summary.cancelled,
    dueToday: summary.dueToday,
    overdue: summary.overdue,
    completedToday: summary.completedToday,
    completedInWindow: summary.completedInWindow,
    completionRate:
      summary.total === 0 ? null : Number(((summary.done / summary.total) * 100).toFixed(1)),
    /** Of the tasks that reached a decision, how many were finished rather than dropped. */
    decidedCompletionRate:
      decided === 0 ? null : Number(((summary.done / decided) * 100).toFixed(1)),
    averageCompletionHours:
      summary.completedInWindow === 0
        ? null
        : Number((summary.completionMs / summary.completedInWindow / 3_600_000).toFixed(1)),
  }
}

/** Completed tasks per person, for the performance engine. */
export async function completedTaskMetrics({ from, to } = {}) {
  const window = {}
  if (from) window.$gte = from
  if (to) window.$lte = to

  const rows = await Task.aggregate([
    { $match: { isDeleted: { $ne: true } } },
    {
      $group: {
        _id: '$assignee',
        assigned: { $sum: 1 },
        // Completed *in the window*, while `assigned` counts everything that
        // exists — a task set last month and finished today is this month's
        // completion but not this month's assignment.
        completed: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', TASK_STATUS.DONE] },
                  ...(from ? [{ $gte: ['$completedAt', from] }] : []),
                  ...(to ? [{ $lte: ['$completedAt', to] }] : []),
                ],
              },
              1,
              0,
            ],
          },
        },
        open: { $sum: { $cond: [{ $in: ['$status', OPEN_TASK_STATUSES] }, 1, 0] } },
        overdue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $in: ['$status', OPEN_TASK_STATUSES] },
                  { $ne: ['$dueAt', null] },
                  { $lt: ['$dueAt', new Date()] },
                ],
              },
              1,
              0,
            ],
          },
        },
        completionMs: {
          $sum: {
            $cond: [
              { $eq: ['$status', TASK_STATUS.DONE] },
              { $subtract: ['$completedAt', '$createdAt'] },
              0,
            ],
          },
        },
        everCompleted: { $sum: { $cond: [{ $eq: ['$status', TASK_STATUS.DONE] }, 1, 0] } },
      },
    },
  ])

  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        tasksAssigned: row.assigned,
        tasksCompleted: row.completed,
        tasksOpen: row.open,
        tasksOverdue: row.overdue,
        taskCompletionRate:
          row.assigned === 0 ? null : Number(((row.everCompleted / row.assigned) * 100).toFixed(1)),
        averageCompletionHours:
          row.everCompleted === 0
            ? null
            : Number((row.completionMs / row.everCompleted / 3_600_000).toFixed(1)),
      },
    ]),
  )
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Creates and assigns a task. */
export async function createTask({ input, actor, req }) {
  const assignee = await User.findOne({ _id: input.assignee, isDeleted: { $ne: true } })
    .select('displayName email status isActive')
    .lean()

  if (!assignee) throw ApiError.badRequest('That person could not be found.')

  /**
   * Refused rather than allowed with a warning.
   *
   * A suspended account cannot sign in, so the task would sit unread and the
   * assigner would believe it was seen. Better to fail at the moment somebody
   * can still choose differently.
   */
  if (assignee.isActive === false) {
    throw ApiError.badRequest('That account is not active and cannot be assigned work.')
  }

  const task = await Task.create({
    title: input.title,
    description: input.description ?? null,
    assignee: assignee._id,
    createdBy: actor._id,
    priority: input.priority,
    priorityRank: TASK_PRIORITY_RANK[input.priority],
    dueAt: input.dueAt ?? null,
    tags: input.tags ?? [],
  })

  await recordAudit({
    req,
    actor,
    event: 'TASK_CREATED',
    summary: `Assigned "${task.title}" to ${assignee.displayName ?? assignee.email}`,
    target: { type: 'task', id: task._id },
    performedFor: assignee,
    metadata: { priority: task.priority, dueAt: task.dueAt },
  })

  await raise({
    type: NOTIFICATION_TYPE.TASK_ASSIGNED,
    task,
    recipients: audienceFor(task, actor._id),
    title: `New task: ${task.title}`,
    body: task.dueAt ? `Due ${new Date(task.dueAt).toDateString()}` : null,
    actorEmail: actor.email,
    suffix: 'assigned',
  })

  const [described] = await withPeople([task], actor._id)

  return described
}

/**
 * Updates a task.
 *
 * Two kinds of change with two different rules, resolved here rather than in
 * two endpoints: the **assignee** may report on their own work (status,
 * progress), while changing what the work *is* — title, deadline, priority, who
 * it belongs to — is a management action.
 */
export async function updateTask({ taskId, patch, actor, canManage, req }) {
  const task = await loadTask(taskId)

  const isAssignee = String(task.assignee) === String(actor._id)
  const selfFields = new Set(['status', 'progress'])
  const wantsManagement = Object.keys(patch).some((key) => !selfFields.has(key))

  if (wantsManagement && !canManage) {
    throw ApiError.forbidden('Only the person who assigned this task may change its details.')
  }

  if (!wantsManagement && !isAssignee && !canManage) {
    throw ApiError.forbidden('Only the assignee may update this task.')
  }

  const before = { status: task.status, assignee: String(task.assignee), progress: task.progress }
  let reassignedTo = null

  if (patch.title !== undefined) task.title = patch.title
  if (patch.description !== undefined) task.description = patch.description
  if (patch.dueAt !== undefined) task.dueAt = patch.dueAt
  if (patch.tags !== undefined) task.tags = patch.tags

  if (patch.priority !== undefined) {
    task.priority = patch.priority
    task.priorityRank = TASK_PRIORITY_RANK[patch.priority]
  }

  if (patch.assignee !== undefined && String(patch.assignee) !== before.assignee) {
    const next = await User.findOne({ _id: patch.assignee, isDeleted: { $ne: true } })
      .select('displayName email isActive')
      .lean()

    if (!next) throw ApiError.badRequest('That person could not be found.')
    if (next.isActive === false) {
      throw ApiError.badRequest('That account is not active and cannot be assigned work.')
    }

    task.assignee = next._id
    reassignedTo = next
  }

  if (patch.progress !== undefined) task.progress = patch.progress

  if (patch.status !== undefined && patch.status !== task.status) {
    task.status = patch.status

    if (TERMINAL_TASK_STATUSES.includes(patch.status)) {
      // The moment of the transition, not of any later save.
      task.completedAt = new Date()
      task.completedBy = actor._id
    } else {
      // Reopened. The old completion timestamp would otherwise claim a finish
      // that was undone, and every average built on it would be wrong.
      task.completedAt = null
      task.completedBy = null
    }
  }

  task.progress = progressForStatus(task.status, task.progress)

  await task.save()

  // --- what actually happened, said precisely ------------------------------
  const statusChanged = patch.status !== undefined && patch.status !== before.status
  const completed = statusChanged && patch.status === TASK_STATUS.DONE

  await recordAudit({
    req,
    actor,
    event: completed ? 'TASK_COMPLETED' : statusChanged ? 'TASK_STATUS_CHANGED' : reassignedTo ? 'TASK_ASSIGNED' : 'TASK_UPDATED',
    summary: completed
      ? `Completed "${task.title}"`
      : statusChanged
        ? `Moved "${task.title}" to ${task.status}`
        : reassignedTo
          ? `Reassigned "${task.title}" to ${reassignedTo.displayName ?? reassignedTo.email}`
          : `Updated "${task.title}"`,
    target: { type: 'task', id: task._id },
    performedFor: reassignedTo ?? { _id: task.assignee },
    metadata: { from: before.status, to: task.status, fields: Object.keys(patch) },
  })

  if (completed) {
    await raise({
      type: NOTIFICATION_TYPE.TASK_COMPLETED,
      task,
      recipients: audienceFor(task, actor._id),
      title: `Completed: ${task.title}`,
      actorEmail: actor.email,
      suffix: `completed:${task.completedAt?.getTime()}`,
    })
  } else if (reassignedTo) {
    await raise({
      type: NOTIFICATION_TYPE.TASK_ASSIGNED,
      task,
      recipients: [String(task.assignee)].filter((id) => id !== String(actor._id)),
      title: `New task: ${task.title}`,
      actorEmail: actor.email,
      suffix: `assigned:${task.assignee}`,
    })
  } else {
    await raise({
      type: NOTIFICATION_TYPE.TASK_UPDATED,
      task,
      recipients: audienceFor(task, actor._id),
      title: `Updated: ${task.title}`,
      body: statusChanged ? `Now ${task.status.replace('_', ' ')}` : null,
      actorEmail: actor.email,
      suffix: `updated:${task.updatedAt.getTime()}`,
    })
  }

  const [described] = await withPeople([task], actor._id)

  return described
}

/** Adds a comment. Anybody on the task may; readers with the wide grant may too. */
export async function addComment({ taskId, body, actor, canSeeEveryone, req }) {
  const task = await loadTask(taskId)

  if (!canSeeEveryone && !isParticipant(task, actor._id)) {
    throw ApiError.forbidden('That task is not yours to comment on.')
  }

  task.comments.push({
    author: actor._id,
    authorEmail: actor.email ?? null,
    authorName: actor.displayName ?? null,
    body,
  })

  await task.save()

  await recordAudit({
    req,
    actor,
    event: 'TASK_COMMENTED',
    summary: `Commented on "${task.title}"`,
    target: { type: 'task', id: task._id },
    performedFor: { _id: task.assignee },
    // The comment body is deliberately absent: the audit log is a record of
    // actions, not a second copy of the conversation.
    metadata: { commentCount: task.comments.length },
  })

  await raise({
    type: NOTIFICATION_TYPE.TASK_COMMENTED,
    task,
    recipients: audienceFor(task, actor._id),
    title: `New comment on ${task.title}`,
    body: `${actor.displayName ?? actor.email} commented`,
    actorEmail: actor.email,
    suffix: `comment:${task.comments.at(-1)._id}`,
  })

  const [described] = await withPeople([task], actor._id)

  return described
}

/** Attaches a file. Bytes on disk, metadata on the task — the 17.1 strategy. */
export async function addAttachment({ taskId, buffer, originalFileName, actor, canSeeEveryone, req }) {
  const task = await loadTask(taskId)

  if (!canSeeEveryone && !isParticipant(task, actor._id)) {
    throw ApiError.forbidden('That task is not yours to attach to.')
  }

  if ((task.attachments ?? []).length >= MAX_TASK_ATTACHMENTS) {
    throw ApiError.conflict(`A task may hold at most ${MAX_TASK_ATTACHMENTS} attachments.`)
  }

  if (buffer.length > MAX_TASK_ATTACHMENT_BYTES) {
    throw ApiError.badRequest(
      `That file is ${Math.round(buffer.length / 1024 / 1024)} MB. The limit is 10 MB.`,
    )
  }

  /**
   * The type is sniffed from the bytes, never taken from the request.
   *
   * Same rule and the same sniffer as the document centre: `Content-Type` is
   * whatever the client felt like sending, and the extension the file is stored
   * under is derived from what it actually is.
   */
  const mimeType = sniffMimeType(buffer)
  const extension = DOCUMENT_MIME_TYPES[mimeType]

  if (!extension) {
    throw ApiError.badRequest('Attachments must be a PDF, PNG or JPEG file.')
  }

  const stored = await storeFile({ userId: task.assignee, buffer, extension })

  task.attachments.push({
    storageKey: stored.storageKey,
    originalFileName,
    mimeType,
    size: stored.size,
    checksum: stored.checksum,
    uploadedBy: actor._id,
  })

  await task.save()

  await recordAudit({
    req,
    actor,
    event: 'TASK_ATTACHMENT_ADDED',
    summary: `Attached ${originalFileName} to "${task.title}"`,
    target: { type: 'task', id: task._id },
    performedFor: { _id: task.assignee },
    metadata: { fileName: originalFileName, size: stored.size },
  })

  const [described] = await withPeople([task], actor._id)

  return described
}

/** Resolves an attachment for streaming. The storage key never leaves here. */
export async function readAttachment({ taskId, attachmentId, viewer, canSeeEveryone }) {
  const task = await loadTask(taskId)

  if (!canSeeEveryone && !isParticipant(task, viewer._id)) {
    throw ApiError.forbidden('That task is not yours to read.')
  }

  const attachment = task.attachments.id(attachmentId)

  if (!attachment) throw ApiError.notFound('That attachment could not be found.')

  return {
    absolutePath: resolveStoredPath(attachment.storageKey),
    mimeType: attachment.mimeType,
    size: attachment.size,
    originalFileName: attachment.originalFileName,
  }
}

/**
 * Soft-deletes a task.
 *
 * The bytes of its attachments are unlinked — they are the only part that costs
 * anything to keep and the only part nobody will audit — while the row and its
 * comments stay, because they are the record of what was asked.
 */
export async function deleteTask({ taskId, actor, req }) {
  const task = await loadTask(taskId)

  task.isDeleted = true
  task.deletedAt = new Date()
  task.deletedBy = actor._id

  for (const attachment of task.attachments ?? []) {
    await removeFile(attachment.storageKey)
  }

  await task.save()

  await recordAudit({
    req,
    actor,
    event: 'TASK_DELETED',
    summary: `Deleted "${task.title}"`,
    target: { type: 'task', id: task._id },
    performedFor: { _id: task.assignee },
    metadata: { status: task.status, attachments: (task.attachments ?? []).length },
  })

  return { id: String(task._id), isDeleted: true }
}

/**
 * Raises the overdue notification for anything that has just passed its due date.
 *
 * Called by the scheduler tick rather than on read: a notification is a push,
 * and computing it when somebody happens to open a page would tell whoever
 * looked first and nobody else. The dedupe key is the **due date**, so one late
 * task produces one bell however many times this runs.
 */
export async function notifyOverdueTasks({ now = new Date() } = {}) {
  const overdue = await Task.find({
    isDeleted: { $ne: true },
    status: { $in: OPEN_TASK_STATUSES },
    dueAt: { $ne: null, $lt: now },
  })
    .select('title assignee createdBy dueAt status')
    .limit(500)

  let raised = 0

  for (const task of overdue) {
    if (!isOverdue(task, now)) continue

    raised += await raise({
      type: NOTIFICATION_TYPE.TASK_OVERDUE,
      task,
      recipients: [...new Set([String(task.assignee), String(task.createdBy)])],
      title: `Overdue: ${task.title}`,
      body: `Was due ${new Date(task.dueAt).toDateString()}`,
      suffix: `overdue:${new Date(task.dueAt).toISOString().slice(0, 10)}`,
    })
  }

  return { examined: overdue.length, raised }
}

export default {
  addAttachment,
  addComment,
  completedTaskMetrics,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  notifyOverdueTasks,
  readAttachment,
  taskSummary,
  updateTask,
}
