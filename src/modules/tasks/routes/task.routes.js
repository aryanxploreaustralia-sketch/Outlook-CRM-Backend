/**
 * Task and goal routes (Phase 18).
 *
 * Mounted at `${API_PREFIX}/v1/tasks` and `${API_PREFIX}/v1/goals`.
 *
 * ## Authentication at the router, permissions per route
 *
 * `requireAuth` is applied to the router rather than to each route, for the
 * reason the rest of the codebase gives: a route added later cannot be left
 * unprotected by omission.
 *
 * ## Two capabilities, both already in the matrix
 *
 * Nothing was added to `constants/permissions.js` for this phase.
 *
 *   - **Reading and updating your own work** needs no permission at all. Every
 *     signed-in person has tasks; a permission required to see your own to-do
 *     list would mean an account could exist that cannot work.
 *   - **Assigning, reassigning and deleting** use `users.delete`, the
 *     owner-and-admin capability Phase 17.1 introduced for binding decisions
 *     about an employee's record. Telling somebody what they must do by when is
 *     exactly that.
 *
 * The narrower rules — only the assignee may move a status, only participants
 * may comment — are not permissions and are not expressible as ones. They are
 * facts about two people and a row, and they are enforced in the service.
 */

import express, { Router } from 'express'

import { MAX_TASK_ATTACHMENT_BYTES } from '../../../constants/tasks.js'
import { PERMISSIONS } from '../../../constants/permissions.js'
import { requireAuth } from '../../../middlewares/authenticate.js'
import { requirePermission } from '../../../middlewares/authorise.js'
import * as controller from '../controllers/task.controller.js'

/**
 * The body parser for attachments.
 *
 * `limit` is the real defence: it refuses an oversized body before it is
 * buffered into memory. The check in the service runs afterwards and produces
 * the friendlier message.
 */
const rawUpload = express.raw({ type: () => true, limit: MAX_TASK_ATTACHMENT_BYTES })

export const taskRouter = Router()

taskRouter.use(requireAuth)

// Literal paths before `:id`, so none of them can ever be captured as a task id.
taskRouter.get('/summary', controller.getTaskSummary)
taskRouter.get('/workspace', controller.getMyWorkspace)
taskRouter.get('/report', controller.getTaskReport)

/**
 * The console's task widgets.
 *
 * `analytics.view` — the capability that already means "may read across
 * people", and the same bar the performance highlights sit behind.
 */
taskRouter.get(
  '/highlights',
  requirePermission(PERMISSIONS.ANALYTICS_VIEW),
  controller.getTaskHighlights,
)

taskRouter.get('/', controller.getTasks)

taskRouter.post('/', requirePermission(PERMISSIONS.USERS_DELETE), controller.postTask)

taskRouter.get('/:id', controller.getTaskById)

/**
 * No permission on the route, deliberately.
 *
 * An assignee updating their own progress and an administrator changing a
 * deadline both arrive here, and only the service can tell them apart — it
 * knows which fields were sent. Gating the route on `users.delete` would lock
 * every employee out of their own to-do list.
 */
taskRouter.patch('/:id', controller.patchTask)

taskRouter.delete('/:id', requirePermission(PERMISSIONS.USERS_DELETE), controller.deleteTaskById)

taskRouter.post('/:id/comments', controller.postComment)
taskRouter.post('/:id/attachments', rawUpload, controller.postAttachment)
taskRouter.get('/:id/attachments/:attachmentId', controller.getAttachment)

export const goalRouter = Router()

goalRouter.use(requireAuth)

goalRouter.get('/summary', controller.getGoalSummary)
goalRouter.get('/', controller.getGoals)

/**
 * Setting a goal is a management act, including on yourself.
 *
 * Letting people set their own targets would make every achievement rate a
 * statement about how modest somebody chose to be.
 */
goalRouter.post('/', requirePermission(PERMISSIONS.USERS_DELETE), controller.postGoal)
goalRouter.patch('/:id', requirePermission(PERMISSIONS.USERS_DELETE), controller.patchGoal)
goalRouter.delete('/:id', requirePermission(PERMISSIONS.USERS_DELETE), controller.deleteGoalById)

export default taskRouter
