/**
 * Task and goal reporting (Phase 18).
 *
 * ## Everything here is a view over the two services beside it
 *
 * The completion counts come from `task.service`, the goal figures from
 * `goal.service`, and the per-person metrics from the Phase 17.3 performance
 * engine. Nothing in this file counts anything itself.
 *
 * That is deliberate to the point of being the whole design. "Task completion
 * rate" appears on the employee dashboard, on the admin board, in User 360 and
 * in this report; if any two of them computed it, they would eventually
 * disagree, and nobody looking at two plausible percentages can tell which is
 * wrong.
 *
 * ## Productivity trends
 *
 * A daily series of tasks completed, gap-filled. An aggregation only emits
 * buckets that matched something, and plotting that draws a straight line over
 * a quiet week as though work happened during it.
 */

import { Types } from 'mongoose'

import { TASK_STATUS } from '../../../constants/tasks.js'
import { Task } from '../../../models/task.model.js'
import { performanceRows } from '../../admin/services/employeePerformance.service.js'
import { goalSummary } from './goal.service.js'
import { taskSummary } from './task.service.js'

/** A gap-filled daily series of completions. */
async function completionTrend({ from, to, userId = null }) {
  const match = {
    isDeleted: { $ne: true },
    status: TASK_STATUS.DONE,
    completedAt: { $gte: from, $lte: to },
  }

  if (userId) match.assignee = new Types.ObjectId(String(userId))

  const rows = await Task.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateTrunc: { date: '$completedAt', unit: 'day' } },
        value: { $sum: 1 },
        /** Hours from creation to completion, so the trend can show both. */
        hours: { $avg: { $divide: [{ $subtract: ['$completedAt', '$createdAt'] }, 3_600_000] } },
      },
    },
    { $sort: { _id: 1 } },
  ])

  const byDay = new Map(rows.map((row) => [new Date(row._id).getTime(), row]))

  const buckets = []
  const cursor = new Date(from)
  cursor.setUTCHours(0, 0, 0, 0)

  while (cursor <= to) {
    const row = byDay.get(cursor.getTime())

    buckets.push({
      periodStart: new Date(cursor).toISOString(),
      label: cursor.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      value: row?.value ?? 0,
      /**
       * Null rather than zero on a day nothing finished.
       *
       * A zero-hour average would read as "everything was instant" and would
       * drag the line down for days on which nothing happened at all.
       */
      averageHours: row ? Number(row.hours.toFixed(1)) : null,
    })

    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return buckets
}

/**
 * One person's report.
 *
 * @param {{ userId: string, from: Date, to: Date }} params
 */
export async function buildUserTaskReport({ userId, from, to }) {
  const [summary, goals, trend] = await Promise.all([
    taskSummary({ userId, from, to }),
    goalSummary({ userId }),
    completionTrend({ from, to, userId }),
  ])

  return {
    tasks: summary,
    goals: {
      achievementRate: goals.achievementRate,
      counts: goals.counts,
      items: goals.goals,
    },
    trend,
    meta: {
      source: 'live-collection',
      from: from.toISOString(),
      to: to.toISOString(),
      generatedAt: new Date().toISOString(),
    },
  }
}

/**
 * The whole team's report.
 *
 * One `performanceRows()` pass supplies every person's task figures, because
 * Phase 18 folded them into that engine. Calling the task aggregation again per
 * person would be the duplication this file exists to avoid.
 */
export async function buildTeamTaskReport({ from, to }) {
  const [summary, rows, trend] = await Promise.all([
    taskSummary({ from, to }),
    performanceRows({ from, to }),
    completionTrend({ from, to }),
  ])

  const people = rows
    .map((row) => ({
      id: row.id,
      displayName: row.displayName,
      email: row.email,
      avatarUrl: row.avatarUrl,
      roleLabel: row.roleLabel,
      assigned: row.metrics.tasksAssigned,
      completed: row.metrics.tasksCompleted,
      open: row.metrics.tasksOpen,
      overdue: row.metrics.tasksOverdue,
      completionRate: row.metrics.taskCompletionRate,
      averageCompletionHours: row.metrics.taskAverageCompletionHours,
      score: row.performance.score,
      level: row.performance.level,
    }))
    // People with no assigned work are dropped rather than shown at 0%: they
    // have not failed to complete anything, and a table of them buries whoever
    // actually has work outstanding.
    .filter((person) => person.assigned > 0)
    .sort((a, b) => (b.completionRate ?? -1) - (a.completionRate ?? -1))

  return {
    tasks: summary,
    people,
    trend,
    meta: {
      source: 'live-aggregation',
      from: from.toISOString(),
      to: to.toISOString(),
      generatedAt: new Date().toISOString(),
    },
  }
}

/**
 * The console's task widgets: due today, overdue, completed today, and who is
 * behind.
 *
 * Sits beside the Phase 17.3 performance highlights rather than inside them —
 * that endpoint answers "who stood out", this one answers "what needs doing
 * today", and merging them would make one response that neither screen wants
 * all of.
 */
export async function buildTaskHighlights({ from, to } = {}) {
  const now = new Date()

  const startOfToday = new Date(now)
  startOfToday.setUTCHours(0, 0, 0, 0)

  const endOfToday = new Date(now)
  endOfToday.setUTCHours(23, 59, 59, 999)

  const [summary, dueToday, overdue, completedToday, rows] = await Promise.all([
    taskSummary({ from, to }),
    Task.find({
      isDeleted: { $ne: true },
      status: { $in: ['todo', 'in_progress'] },
      dueAt: { $gte: startOfToday, $lte: endOfToday },
    })
      .select('title assignee dueAt priority priorityRank status')
      .sort({ priorityRank: -1, dueAt: 1 })
      .limit(10)
      .lean(),
    Task.find({
      isDeleted: { $ne: true },
      status: { $in: ['todo', 'in_progress'] },
      dueAt: { $ne: null, $lt: startOfToday },
    })
      .select('title assignee dueAt priority priorityRank status')
      .sort({ dueAt: 1 })
      .limit(10)
      .lean(),
    Task.find({ isDeleted: { $ne: true }, completedAt: { $gte: startOfToday } })
      .select('title assignee completedAt')
      .sort({ completedAt: -1 })
      .limit(10)
      .lean(),
    performanceRows({ from, to }),
  ])

  const byId = new Map(rows.map((row) => [row.id, row]))
  const name = (id) => {
    const row = byId.get(String(id))
    return row ? (row.displayName ?? row.email) : 'Unknown user'
  }

  const describe = (task) => ({
    id: String(task._id),
    title: task.title,
    assignee: String(task.assignee),
    assigneeName: name(task.assignee),
    dueAt: task.dueAt ?? null,
    completedAt: task.completedAt ?? null,
    priority: task.priority ?? null,
    status: task.status ?? null,
  })

  /**
   * Who is carrying overdue work, worst first.
   *
   * Distinct from the 17.3 "needs attention" list, which is about a profile
   * being incomplete or a mailbox failing. This one is about work that is late,
   * which is the thing a manager can act on today.
   */
  const behind = rows
    .filter((row) => row.metrics.tasksOverdue > 0)
    .map((row) => ({
      id: row.id,
      displayName: row.displayName,
      email: row.email,
      overdue: row.metrics.tasksOverdue,
      open: row.metrics.tasksOpen,
      completionRate: row.metrics.taskCompletionRate,
    }))
    .sort((a, b) => b.overdue - a.overdue)
    .slice(0, 8)

  return {
    summary,
    dueToday: dueToday.map(describe),
    overdue: overdue.map(describe),
    completedToday: completedToday.map(describe),
    behind,
    meta: { source: 'live-collection', generatedAt: new Date().toISOString() },
  }
}

/**
 * The employee's own board: today, what is coming, and how the goals stand.
 *
 * One call rather than four, because it is one screen and four round trips to
 * paint it is how a dashboard comes to feel slow.
 */
export async function buildMyWorkspace({ userId }) {
  const now = new Date()

  const endOfToday = new Date(now)
  endOfToday.setUTCHours(23, 59, 59, 999)

  const inSevenDays = new Date(now)
  inSevenDays.setUTCDate(inSevenDays.getUTCDate() + 7)

  const startOfToday = new Date(now)
  startOfToday.setUTCHours(0, 0, 0, 0)

  const assignee = new Types.ObjectId(String(userId))
  const open = { $in: ['todo', 'in_progress'] }

  const [summary, goals, today, upcoming, recentlyCompleted] = await Promise.all([
    taskSummary({ userId }),
    goalSummary({ userId }),
    Task.find({
      assignee,
      isDeleted: { $ne: true },
      status: open,
      // Today's work *and* anything already late, because a list called "today"
      // that hides last week's overdue task is how it stays overdue.
      $or: [{ dueAt: { $lte: endOfToday } }, { dueAt: null, priority: { $in: ['high', 'urgent'] } }],
    })
      .sort({ priorityRank: -1, dueAt: 1 })
      .limit(20),
    Task.find({
      assignee,
      isDeleted: { $ne: true },
      status: open,
      dueAt: { $gt: endOfToday, $lte: inSevenDays },
    })
      .sort({ dueAt: 1 })
      .limit(20),
    Task.find({ assignee, isDeleted: { $ne: true }, completedAt: { $ne: null } })
      .sort({ completedAt: -1 })
      .limit(10),
  ])

  const shape = (task) => task.toPublicJSON({ viewerId: userId })

  return {
    summary,
    goals: { achievementRate: goals.achievementRate, counts: goals.counts, items: goals.goals },
    today: today.map(shape),
    upcoming: upcoming.map(shape),
    recentlyCompleted: recentlyCompleted.map(shape),
    completedToday: recentlyCompleted.filter((task) => task.completedAt >= startOfToday).length,
    meta: { source: 'live-collection', generatedAt: new Date().toISOString() },
  }
}

export default {
  buildMyWorkspace,
  buildTaskHighlights,
  buildTeamTaskReport,
  buildUserTaskReport,
}
