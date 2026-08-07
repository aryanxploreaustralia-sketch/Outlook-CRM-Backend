/**
 * Task and goal controllers (Phase 18).
 *
 * Thin, as everywhere here: parse, call a service, shape the response. The one
 * thing these handlers do decide is **what the caller may see**, and they decide
 * it by reading the permission engine rather than by inspecting roles — then
 * they hand the answer to the service as a plain boolean. No handler queries
 * with a scope it worked out for itself.
 */

import { createReadStream } from 'node:fs'

import { PERMISSIONS } from '../../../constants/permissions.js'
import { permissionsForRole } from '../../../constants/roleMatrix.js'
import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { resolveRange } from '../../admin/validators/adminAnalytics.validator.js'
import * as goals from '../services/goal.service.js'
import * as reports from '../services/taskReport.service.js'
import * as tasks from '../services/task.service.js'
import {
  goalCreateSchema,
  goalListQuerySchema,
  goalUpdateSchema,
  objectIdSchema,
  taskCommentSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
} from '../validators/task.validator.js'

/**
 * Whether this caller may read about other people.
 *
 * Read from the matrix, so adding a role that holds `users.view` carries this
 * with it and nothing here changes.
 */
const canSeeEveryone = (req) => permissionsForRole(req.auth.user.role).has(PERMISSIONS.USERS_VIEW)

/**
 * Whether this caller may assign, reassign or delete work.
 *
 * `users.delete` — the capability Phase 17.1 already uses for binding decisions
 * about an employee's record. No new permission was introduced.
 */
const canManage = (req) => permissionsForRole(req.auth.user.role).has(PERMISSIONS.USERS_DELETE)

/** The raw bytes of an upload, mirroring the document centre exactly. */
function fileFrom(req) {
  const buffer = Buffer.isBuffer(req.body) ? req.body : null

  if (!buffer || buffer.length === 0) throw ApiError.badRequest('No file was uploaded.')

  return {
    buffer,
    // Attacker-controlled text: bounded, and stripped of anything that could
    // describe a location.
    originalFileName: String(req.get('x-filename') ?? 'attachment')
      .replaceAll(/[/\\]/g, '_')
      .slice(0, 256),
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** GET /api/v1/tasks */
export const getTasks = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Tasks loaded.',
    data: await tasks.listTasks({
      viewer: req.auth.user,
      canSeeEveryone: canSeeEveryone(req),
      query: taskListQuerySchema.parse(req.query),
    }),
  }),
)

/**
 * GET /api/v1/tasks/summary
 *
 * Scoped to the caller unless they ask for somebody else and may. The refusal is
 * explicit rather than a silent narrowing — see the note in `listTasks`.
 */
export const getTaskSummary = asyncHandler(async (req, res) => {
  const requested = req.query.user ? objectIdSchema.parse(req.query.user) : null

  if (requested && requested !== String(req.auth.user._id) && !canSeeEveryone(req)) {
    throw ApiError.forbidden("You may only read your own task summary.")
  }

  return sendSuccess(res, {
    message: 'Task summary loaded.',
    data: await tasks.taskSummary({ userId: requested ?? req.auth.user._id }),
  })
})

/** GET /api/v1/tasks/:id */
export const getTaskById = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Task loaded.',
    data: await tasks.getTask({
      taskId: objectIdSchema.parse(req.params.id),
      viewer: req.auth.user,
      canSeeEveryone: canSeeEveryone(req),
    }),
  }),
)

/** POST /api/v1/tasks */
export const postTask = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Task assigned.',
    data: await tasks.createTask({
      input: taskCreateSchema.parse(req.body ?? {}),
      actor: req.auth.user,
      req,
    }),
  }),
)

/** PATCH /api/v1/tasks/:id */
export const patchTask = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Task updated.',
    data: await tasks.updateTask({
      taskId: objectIdSchema.parse(req.params.id),
      patch: taskUpdateSchema.parse(req.body ?? {}),
      actor: req.auth.user,
      canManage: canManage(req),
      req,
    }),
  }),
)

/** DELETE /api/v1/tasks/:id */
export const deleteTaskById = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Task deleted.',
    data: await tasks.deleteTask({
      taskId: objectIdSchema.parse(req.params.id),
      actor: req.auth.user,
      req,
    }),
  }),
)

/** POST /api/v1/tasks/:id/comments */
export const postComment = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Comment added.',
    data: await tasks.addComment({
      taskId: objectIdSchema.parse(req.params.id),
      body: taskCommentSchema.parse(req.body ?? {}).body,
      actor: req.auth.user,
      canSeeEveryone: canSeeEveryone(req),
      req,
    }),
  }),
)

/** POST /api/v1/tasks/:id/attachments — raw body, filename in a header. */
export const postAttachment = asyncHandler(async (req, res) => {
  const { buffer, originalFileName } = fileFrom(req)

  return sendSuccess(res, {
    message: `${originalFileName} attached.`,
    data: await tasks.addAttachment({
      taskId: objectIdSchema.parse(req.params.id),
      buffer,
      originalFileName,
      actor: req.auth.user,
      canSeeEveryone: canSeeEveryone(req),
      req,
    }),
  })
})

/**
 * GET /api/v1/tasks/:id/attachments/:attachmentId
 *
 * `nosniff` matters more here than almost anywhere: these are user-uploaded
 * bytes, and without it a browser may sniff a crafted file into something
 * executable regardless of the type declared.
 */
export const getAttachment = asyncHandler(async (req, res) => {
  const file = await tasks.readAttachment({
    taskId: objectIdSchema.parse(req.params.id),
    attachmentId: objectIdSchema.parse(req.params.attachmentId),
    viewer: req.auth.user,
    canSeeEveryone: canSeeEveryone(req),
  })

  const disposition = req.query.download === '1' ? 'attachment' : 'inline'

  res.setHeader('Content-Type', file.mimeType)
  res.setHeader('Content-Length', file.size)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${file.originalFileName.replaceAll('"', '')}"`,
  )

  return createReadStream(file.absolutePath).pipe(res)
})

// ---------------------------------------------------------------------------
// Boards and reports
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/tasks/workspace
 *
 * The employee's own board. No id and no permission: the subject is the
 * session, so there is nothing to widen.
 */
export const getMyWorkspace = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Workspace loaded.',
    data: await reports.buildMyWorkspace({ userId: req.auth.user._id }),
  }),
)

/**
 * GET /api/v1/tasks/report
 *
 * One person's, or the whole team's. The team view needs the cross-user
 * capability; asking for somebody else by id needs it too.
 */
export const getTaskReport = asyncHandler(async (req, res) => {
  const range = resolveRange(req.query)
  const scope = req.query.scope === 'team' ? 'team' : 'user'
  const requested = req.query.user ? objectIdSchema.parse(req.query.user) : null

  const wantsOthers = scope === 'team' || (requested && requested !== String(req.auth.user._id))

  if (wantsOthers && !canSeeEveryone(req)) {
    throw ApiError.forbidden('You may only read your own report.')
  }

  /**
   * A report needs bounds even when the caller asked for "all time".
   *
   * An unbounded trend has no first bucket to scaffold from, so the open preset
   * falls back to thirty days — the same fallback the analytics trend uses.
   */
  const to = range.to ?? new Date()
  const from = range.from ?? new Date(to.getTime() - 29 * 86_400_000)

  const data =
    scope === 'team'
      ? await reports.buildTeamTaskReport({ from, to })
      : await reports.buildUserTaskReport({
          userId: requested ?? req.auth.user._id,
          from,
          to,
        })

  return sendSuccess(res, {
    message: 'Report loaded.',
    data: { ...data, range: { preset: range.preset, from, to } },
  })
})

/** GET /api/v1/tasks/highlights — the console's task widgets. */
export const getTaskHighlights = asyncHandler(async (req, res) => {
  const range = resolveRange(req.query)

  return sendSuccess(res, {
    message: 'Task highlights loaded.',
    data: {
      ...(await reports.buildTaskHighlights({ from: range.from, to: range.to })),
      range: { preset: range.preset, from: range.from ?? null, to: range.to ?? null },
    },
  })
})

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/** GET /api/v1/goals */
export const getGoals = asyncHandler(async (req, res) => {
  const query = goalListQuerySchema.parse(req.query)
  const requested = query.user ?? null

  if (requested && requested !== String(req.auth.user._id) && !canSeeEveryone(req)) {
    throw ApiError.forbidden('You may only read your own goals.')
  }

  return sendSuccess(res, {
    message: 'Goals loaded.',
    data: {
      items: await goals.listGoals({
        userId: requested ?? req.auth.user._id,
        activeOnly: query.activeOnly,
        period: query.period ?? null,
      }),
    },
  })
})

/** GET /api/v1/goals/summary */
export const getGoalSummary = asyncHandler(async (req, res) => {
  const requested = req.query.user ? objectIdSchema.parse(req.query.user) : null

  if (requested && requested !== String(req.auth.user._id) && !canSeeEveryone(req)) {
    throw ApiError.forbidden('You may only read your own goals.')
  }

  return sendSuccess(res, {
    message: 'Goal summary loaded.',
    data: await goals.goalSummary({ userId: requested ?? req.auth.user._id }),
  })
})

/** POST /api/v1/goals */
export const postGoal = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Goal set.',
    data: await goals.createGoal({
      input: goalCreateSchema.parse(req.body ?? {}),
      actor: req.auth.user,
      req,
    }),
  }),
)

/** PATCH /api/v1/goals/:id */
export const patchGoal = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Goal updated.',
    data: await goals.updateGoal({
      goalId: objectIdSchema.parse(req.params.id),
      patch: goalUpdateSchema.parse(req.body ?? {}),
      actor: req.auth.user,
      req,
    }),
  }),
)

/** DELETE /api/v1/goals/:id */
export const deleteGoalById = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Goal removed.',
    data: await goals.deleteGoal({
      goalId: objectIdSchema.parse(req.params.id),
      actor: req.auth.user,
      req,
    }),
  }),
)

export default {
  deleteGoalById,
  getMyWorkspace,
  getTaskHighlights,
  getTaskReport,
  deleteTaskById,
  getAttachment,
  getGoalSummary,
  getGoals,
  getTaskById,
  getTaskSummary,
  getTasks,
  patchGoal,
  patchTask,
  postAttachment,
  postComment,
  postGoal,
  postTask,
}
