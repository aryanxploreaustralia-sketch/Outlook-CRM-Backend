/**
 * Task and goal input validation (Phase 18).
 *
 * ## What the schemas deliberately omit
 *
 * `createdBy`, `completedAt`, `completedBy` and `isDeleted` are absent from
 * every schema. They are the server's to write, and a client that sent them
 * would have them stripped rather than honoured — the same rule that keeps
 * `role` and `status` out of the profile schema.
 *
 * `status` and `progress` are accepted on update but nowhere else: a task is
 * created as `todo` at 0%, because "create it already finished" is not a thing
 * anybody needs and it would leave a completion with no work behind it.
 */

import { z } from 'zod'

import {
  GOAL_METRIC_VALUES,
  GOAL_PERIOD_VALUES,
  MAX_COMMENT_LENGTH,
  TASK_PRIORITY,
  TASK_PRIORITY_VALUES,
  TASK_STATUS_VALUES,
} from '../../../constants/tasks.js'

export const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'That is not a valid id.')

/** Accepts one value or a comma-separated list, and normalises to an array. */
const listOf = (values) =>
  z
    .string()
    .trim()
    .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1))
    .optional()

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1, 'A task needs a title.').max(200),
  description: z.string().trim().max(5000).nullish(),
  assignee: objectIdSchema,
  priority: z.enum(TASK_PRIORITY_VALUES).default(TASK_PRIORITY.NORMAL),
  /**
   * Any date, including one in the past.
   *
   * Backdating is legitimate — work that was owed last week is still owed — and
   * refusing it would only push people into lying about the deadline.
   */
  dueAt: z.coerce.date().nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
})

export const taskUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).nullable(),
    assignee: objectIdSchema,
    status: z.enum(TASK_STATUS_VALUES),
    priority: z.enum(TASK_PRIORITY_VALUES),
    dueAt: z.coerce.date().nullable(),
    progress: z.coerce.number().int().min(0).max(100),
    tags: z.array(z.string().trim().min(1).max(40)).max(10),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Nothing to update.',
  })

export const taskCommentSchema = z.object({
  body: z.string().trim().min(1, 'A comment needs something in it.').max(MAX_COMMENT_LENGTH),
})

export const taskListQuerySchema = z.object({
  /**
   * Whose tasks.
   *
   * `assigned` (mine to do) is the default because that is what a person opens
   * the page for. `all` and an explicit `assignee` are refused by the service
   * without the cross-user capability.
   */
  scope: z.enum(['assigned', 'created', 'all']).default('assigned'),
  assignee: objectIdSchema.optional(),
  status: listOf(TASK_STATUS_VALUES),
  priority: listOf(TASK_PRIORITY_VALUES),
  search: z.string().trim().min(1).max(120).optional(),
  dueBefore: z.coerce.date().optional(),
  dueAfter: z.coerce.date().optional(),
  overdue: z
    .enum(['1', 'true', '0', 'false'])
    .transform((value) => value === '1' || value === 'true')
    .optional(),
  sort: z.enum(['smart', 'due', 'created', 'priority', 'status']).default('smart'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const goalCreateSchema = z.object({
  user: objectIdSchema,
  period: z.enum(GOAL_PERIOD_VALUES),
  metric: z.enum(GOAL_METRIC_VALUES),
  /**
   * At least one. A goal of zero is achieved before it is set, which is not a
   * goal; the model enforces the same floor.
   */
  target: z.coerce.number().int().min(1).max(1_000_000),
  /** Any date inside the wanted period. Defaults to now, i.e. this one. */
  anchor: z.coerce.date().optional(),
  note: z.string().trim().max(512).nullish(),
})

export const goalUpdateSchema = z
  .object({
    target: z.coerce.number().int().min(1).max(1_000_000),
    note: z.string().trim().max(512).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' })

export const goalListQuerySchema = z.object({
  user: objectIdSchema.optional(),
  period: z.enum(GOAL_PERIOD_VALUES).optional(),
  activeOnly: z
    .enum(['1', 'true', '0', 'false'])
    .transform((value) => value === '1' || value === 'true')
    .default('true'),
})

export default {
  goalCreateSchema,
  goalListQuerySchema,
  goalUpdateSchema,
  objectIdSchema,
  taskCommentSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
}
