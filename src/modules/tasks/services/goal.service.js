/**
 * Goals and KPI tracking (Phase 18).
 *
 * ## A goal is a target laid over an existing measurement
 *
 * Progress is never stored and never recomputed here. Each goal names a metric,
 * and the metric names a field on `performanceRows()` — the Phase 17.3 engine
 * that already produces every figure the dashboards show. This service reads
 * that engine over the goal's own window and divides.
 *
 * The consequence is the point: a goal cannot disagree with the performance
 * screen beside it, because there is only one measurement. A stored `achieved`
 * column would be a second copy that drifts the moment a message is deleted or
 * the refresh job misses a run.
 *
 * ## Windows are per goal, not per request
 *
 * A daily goal and a monthly goal on the same person are measured over different
 * ranges, so the engine is called **once per distinct window** rather than once
 * per goal — three goals sharing a month cost one pass.
 *
 * ## Achievement latches
 *
 * `achievedAt` is written the first time a goal crosses its target, and never
 * cleared. Its only jobs are to fire the notification once and to record when it
 * happened; the percentage shown is always live.
 */

import {
  GOAL_METRIC_DEFINITIONS,
  GOAL_PERIOD,
  GOAL_PERIOD_LABELS,
  goalWindow,
} from '../../../constants/tasks.js'
import { Goal } from '../../../models/goal.model.js'
import { NOTIFICATION_TYPE } from '../../../models/notification.model.js'
import { User } from '../../../models/user.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import { performanceRows } from '../../admin/services/employeePerformance.service.js'
import { linkFor, notify } from '../../notifications/services/notifier.service.js'

const log = createContextLogger('goals')

/** A window's cache key. Two goals over the same range share one engine pass. */
const windowKey = ({ from, to }) => `${from.getTime()}:${to.getTime()}`

/**
 * Measures a set of goals.
 *
 * @param {Array} goals Goal documents.
 * @returns {Promise<Array>} Each goal's public shape plus its live progress.
 */
export async function measureGoals(goals) {
  if (goals.length === 0) return []

  /** One engine pass per distinct window. */
  const windows = new Map()
  for (const goal of goals) {
    const key = windowKey({ from: goal.periodStart, to: goal.periodEnd })
    if (!windows.has(key)) windows.set(key, { from: goal.periodStart, to: goal.periodEnd })
  }

  const measured = new Map(
    await Promise.all(
      [...windows.entries()].map(async ([key, window]) => {
        const rows = await performanceRows(window, { includeInactive: true })
        return [key, new Map(rows.map((row) => [row.id, row.metrics]))]
      }),
    ),
  )

  const now = new Date()

  return goals.map((goal) => {
    const key = windowKey({ from: goal.periodStart, to: goal.periodEnd })
    const definition = GOAL_METRIC_DEFINITIONS[goal.metric]
    const metrics = measured.get(key)?.get(String(goal.user)) ?? {}

    const current = metrics[definition?.source] ?? 0
    const percentage = goal.target === 0 ? null : Math.round((current / goal.target) * 100)

    /**
     * How much of the window has elapsed, so "60% done with 90% of the month
     * gone" reads differently from "60% done on the 3rd".
     *
     * Clamped: a goal being looked at after its window closed is 100% elapsed,
     * not 130%.
     */
    const span = goal.periodEnd.getTime() - goal.periodStart.getTime()
    const elapsed = Math.min(
      Math.max((now.getTime() - goal.periodStart.getTime()) / span, 0),
      1,
    )

    return {
      ...goal.toPublicJSON(),
      current,
      remaining: Math.max(goal.target - current, 0),
      percentage,
      isAchieved: current >= goal.target,
      /** True only while there is still time — a missed goal is not "behind". */
      isBehind: now <= goal.periodEnd && percentage !== null && percentage / 100 < elapsed,
      isExpired: now > goal.periodEnd,
      elapsedPercentage: Math.round(elapsed * 100),
      source: 'live-aggregation',
    }
  })
}

/**
 * Somebody's goals, measured.
 *
 * `activeOnly` returns the windows that contain today — the set a person can
 * still do something about, which is what a dashboard wants.
 */
export async function listGoals({ userId, activeOnly = true, period = null }) {
  const filter = { user: userId, isDeleted: false }

  if (period) filter.period = period

  if (activeOnly) {
    const now = new Date()
    filter.periodStart = { $lte: now }
    filter.periodEnd = { $gte: now }
  }

  const goals = await Goal.find(filter).sort({ periodEnd: 1, metric: 1 })

  return measureGoals(goals)
}

/**
 * Sets a goal.
 *
 * The window is computed from the period and stored, so the goal keeps pointing
 * at the month it was set for after the calendar turns.
 */
export async function createGoal({ input, actor, req }) {
  const target = await User.findOne({ _id: input.user, isDeleted: { $ne: true } })
    .select('displayName email')
    .lean()

  if (!target) throw ApiError.badRequest('That person could not be found.')

  const definition = GOAL_METRIC_DEFINITIONS[input.metric]
  if (!definition) throw ApiError.badRequest('That is not a metric this CRM measures.')

  const { from, to } = goalWindow(input.period, input.anchor ?? new Date())

  const existing = await Goal.findOne({
    user: target._id,
    metric: input.metric,
    period: input.period,
    periodStart: from,
    isDeleted: false,
  })

  if (existing) {
    throw ApiError.conflict(
      `A ${GOAL_PERIOD_LABELS[input.period].toLowerCase()} ${definition.label.toLowerCase()} goal already exists for this period. Edit it instead.`,
    )
  }

  const goal = await Goal.create({
    user: target._id,
    createdBy: actor._id,
    period: input.period,
    metric: input.metric,
    target: input.target,
    periodStart: from,
    periodEnd: to,
    note: input.note ?? null,
  })

  await recordAudit({
    req,
    actor,
    event: 'GOAL_CREATED',
    summary: `Set a ${GOAL_PERIOD_LABELS[goal.period].toLowerCase()} goal of ${goal.target} ${definition.unit} for ${target.displayName ?? target.email}`,
    target: { type: 'goal', id: goal._id },
    performedFor: target,
    metadata: { metric: goal.metric, target: goal.target, period: goal.period },
  })

  // The person it is set for, unless they set it themselves.
  if (String(target._id) !== String(actor._id)) {
    await raiseGoalNotification({
      type: NOTIFICATION_TYPE.GOAL_ASSIGNED,
      goal,
      recipients: [String(target._id)],
      title: `New ${GOAL_PERIOD_LABELS[goal.period].toLowerCase()} goal: ${goal.target} ${definition.unit}`,
      body: goal.note ?? definition.label,
      actorEmail: actor.email,
      suffix: 'assigned',
    })
  }

  const [measured] = await measureGoals([goal])

  return measured
}

/** Changes the target or the note. The metric, person and window are fixed. */
export async function updateGoal({ goalId, patch, actor, req }) {
  const goal = await Goal.findOne({ _id: goalId, isDeleted: false })

  if (!goal) throw ApiError.notFound('That goal could not be found.')

  if (patch.target !== undefined) goal.target = patch.target
  if (patch.note !== undefined) goal.note = patch.note

  /**
   * Raising a target above what has already been achieved clears the latch.
   *
   * Otherwise a goal moved from 50 to 500 would keep claiming it was achieved
   * on the strength of the old, easier number.
   */
  if (patch.target !== undefined && goal.achievedAt) {
    const [measured] = await measureGoals([goal])
    if (!measured.isAchieved) goal.achievedAt = null
  }

  await goal.save()

  await recordAudit({
    req,
    actor,
    event: 'GOAL_UPDATED',
    summary: `Changed a goal to ${goal.target} ${GOAL_METRIC_DEFINITIONS[goal.metric]?.unit ?? ''}`.trim(),
    target: { type: 'goal', id: goal._id },
    performedFor: { _id: goal.user },
    metadata: { metric: goal.metric, target: goal.target },
  })

  const [measured] = await measureGoals([goal])

  return measured
}

/** Removes a goal. Soft, so a period's history stays readable. */
export async function deleteGoal({ goalId, actor, req }) {
  const goal = await Goal.findOne({ _id: goalId, isDeleted: false })

  if (!goal) throw ApiError.notFound('That goal could not be found.')

  goal.isDeleted = true
  await goal.save()

  await recordAudit({
    req,
    actor,
    event: 'GOAL_DELETED',
    summary: `Removed a ${GOAL_PERIOD_LABELS[goal.period].toLowerCase()} ${GOAL_METRIC_DEFINITIONS[goal.metric]?.label.toLowerCase() ?? goal.metric} goal`,
    target: { type: 'goal', id: goal._id },
    performedFor: { _id: goal.user },
    metadata: { metric: goal.metric, target: goal.target },
  })

  return { id: String(goal._id), isDeleted: true }
}

/** Raises one goal notification. Never throws. */
async function raiseGoalNotification({ type, goal, recipients, title, body, actorEmail, suffix }) {
  if (recipients.length === 0) return 0

  try {
    return await notify({
      type,
      recipients,
      title,
      body: body ?? null,
      link: linkFor(type, { id: goal._id }),
      dedupeKey: `goal:${goal._id}:${suffix}`,
      target: { type: 'goal', id: goal._id },
      actorEmail: actorEmail ?? null,
    })
  } catch (error) {
    log.warn('Goal notification could not be raised', { goalId: String(goal._id), message: error.message })
    return 0
  }
}

/**
 * Latches newly-achieved goals and tells the person.
 *
 * Called from the scheduler tick, not on read. Achievement is a push: computing
 * it when somebody happens to open a page would congratulate whoever looked and
 * silently skip everybody else — and would fire from a GET, which should not
 * write.
 *
 * @returns {Promise<{ examined: number, achieved: number }>}
 */
export async function settleAchievedGoals({ now = new Date() } = {}) {
  const live = await Goal.find({
    isDeleted: false,
    achievedAt: null,
    periodStart: { $lte: now },
    periodEnd: { $gte: now },
  }).limit(500)

  if (live.length === 0) return { examined: 0, achieved: 0 }

  const measured = await measureGoals(live)
  let achieved = 0

  for (const [index, result] of measured.entries()) {
    if (!result.isAchieved) continue

    const goal = live[index]
    goal.achievedAt = now
    await goal.save()
    achieved += 1

    await recordAudit({
      // No request and no human actor: the scheduler observed it. Attributed to
      // the person whose goal it is, which is whose activity caused it.
      actor: { _id: goal.user, email: null, role: null },
      event: 'GOAL_ACHIEVED',
      summary: `Achieved a ${GOAL_PERIOD_LABELS[goal.period].toLowerCase()} goal of ${goal.target} ${GOAL_METRIC_DEFINITIONS[goal.metric]?.unit ?? ''}`.trim(),
      target: { type: 'goal', id: goal._id },
      performedFor: { _id: goal.user },
      metadata: { metric: goal.metric, target: goal.target, reached: result.current },
    })

    await raiseGoalNotification({
      type: NOTIFICATION_TYPE.GOAL_ACHIEVED,
      goal,
      recipients: [String(goal.user)],
      title: `Goal achieved: ${result.metricLabel}`,
      body: `${result.current} of ${goal.target} ${result.unit}`,
      suffix: 'achieved',
    })
  }

  return { examined: live.length, achieved }
}

/**
 * A person's KPI summary: their goals, and how they are doing against them.
 *
 * Used by User 360 and the employee dashboard. Deliberately not a score — the
 * performance engine already produces one, and a second composite over the same
 * measurements would be a second answer to the same question.
 */
export async function goalSummary({ userId }) {
  const goals = await listGoals({ userId, activeOnly: true })

  const withPercentage = goals.filter((goal) => goal.percentage !== null)

  return {
    goals,
    counts: {
      total: goals.length,
      achieved: goals.filter((goal) => goal.isAchieved).length,
      behind: goals.filter((goal) => goal.isBehind && !goal.isAchieved).length,
      daily: goals.filter((goal) => goal.period === GOAL_PERIOD.DAILY).length,
      weekly: goals.filter((goal) => goal.period === GOAL_PERIOD.WEEKLY).length,
      monthly: goals.filter((goal) => goal.period === GOAL_PERIOD.MONTHLY).length,
    },
    /**
     * The mean progress across active goals, capped per goal at 100.
     *
     * Uncapped, one goal at 400% would hide three at 20% — an "achievement
     * rate" that rises when somebody ignores most of their targets is worse
     * than no number at all. Null when there are no goals: nothing to average.
     */
    achievementRate: withPercentage.length
      ? Number(
          (
            withPercentage.reduce((sum, goal) => sum + Math.min(goal.percentage, 100), 0) /
            withPercentage.length
          ).toFixed(1),
        )
      : null,
    meta: { source: 'live-aggregation', generatedAt: new Date().toISOString() },
  }
}

export default {
  createGoal,
  deleteGoal,
  goalSummary,
  listGoals,
  measureGoals,
  settleAchievedGoals,
  updateGoal,
}
