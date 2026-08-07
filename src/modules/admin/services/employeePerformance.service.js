/**
 * The employee performance engine (Phase 17.3).
 *
 * ## One computation, four consumers
 *
 * `performanceRows()` is the whole engine. It gathers every metric for every
 * person in one pass and scores them. The leaderboard, the dashboard widgets,
 * the comparison view and one person's dashboard all call it and then *select*
 * from what it returns.
 *
 * That is the point of the design. A "top performer" widget that computed its
 * own score would eventually disagree with the leaderboard it sits above, and
 * the disagreement would be invisible — two plausible numbers, no way to tell
 * which is wrong. There is one number, computed once, and every screen is a
 * different view of it.
 *
 * ## Everything is derived
 *
 * No collection was added for this phase and nothing is stored. Every figure is
 * aggregated from what the CRM already records at the moment it is asked for,
 * which is what makes these numbers incapable of drifting from the screens they
 * come from.
 *
 * ## What is not measured
 *
 * Three of the brief's fields cannot be derived from this CRM's data, so they
 * are `null` with a stated reason rather than a plausible-looking number —
 * emails *delivered*, opens and clicks, and average session duration. The
 * reasons are in `performance.repository.js` and travel to the client in
 * `notMeasured`, so the console can say why rather than showing a dash.
 */

import {
  AUDIT_ACTION_INDEX,
  AUDIT_ACTION_LABELS,
  AUDIT_CATEGORY,
  AUDIT_SEVERITY,
} from '../../../constants/auditEvents.js'
import { ApiError } from '../../../utils/ApiError.js'
import { ROLE_LABELS } from '../../../constants/roles.js'
import { USER_STATUS, deriveUserStatus } from '../../../constants/userStatus.js'
import { profileCompletion } from '../../../constants/employeeProfile.js'
import { config } from '../../../config/index.js'
import { User } from '../../../models/user.model.js'
import {
  computePerformanceScore,
  performanceLevel,
  scoreDefinition,
} from '../constants/performanceScore.js'
import * as analytics from '../repositories/adminAnalytics.repository.js'
import * as performance from '../repositories/performance.repository.js'
import { completedTaskMetrics } from '../../tasks/services/task.service.js'

/** Days in a window. Unbounded windows are scored as a month. */
export function windowDays({ from, to }) {
  if (!from || !to) return 30
  return Math.max(Math.round((to - from) / 86_400_000), 1)
}

/** Percentage to one decimal, or null when the denominator is zero. */
const rate = (numerator, denominator) =>
  !denominator ? null : Number(((numerator / denominator) * 100).toFixed(1))

/**
 * The figures this CRM does not record, and why.
 *
 * Served with every performance response. A console that renders "—" teaches
 * the reader that the number is broken; one that says "Microsoft does not report
 * delivery" teaches them what the system knows.
 */
export const NOT_MEASURED = Object.freeze({
  emailsDelivered:
    'Microsoft Graph accepts a message for delivery and reports nothing afterwards. Sent means accepted.',
  opens:
    'Open and click tracking is not implemented — no tracking pixel and no link rewriting.',
  averageSessionDuration:
    'Expired sessions are deleted by a TTL index, so finished sessions leave nothing to measure. Live sessions are counted instead.',
})

/**
 * Everybody's metrics and score for one window.
 *
 * Nine aggregations, all concurrent, none of them per-user: the cost is a
 * function of the window, not of how many people are in the directory.
 *
 * @param {{ from?: Date, to?: Date }} window
 * @param {{ role?: string, includeInactive?: boolean }} [options]
 */
export async function performanceRows(window = {}, { role, includeInactive = false } = {}) {
  const days = windowDays(window)

  const userFilter = { isDeleted: { $ne: true } }
  if (!includeInactive) userFilter.status = { $ne: USER_STATUS.DISABLED }
  if (role) userFilter.role = role

  const [users, base, mail, responses, campaigns, leads, audit, sessions, mailboxes, documents, tasks] =
    await Promise.all([
      User.find(userFilter)
        .select(
          'displayName email avatarUrl role status isActive isDeleted lastLoginAt createdAt ' +
            'phone employeeId department designation dateOfBirth gender address emergencyContact ' +
            'profilePhoto joiningDate',
        )
        .lean(),
      analytics.userActivityMetrics(window),
      performance.mailOutcomeMetrics(window),
      performance.responseTimeMetrics(window),
      performance.campaignMetrics(window),
      performance.leadMetrics(window),
      performance.auditActivityMetrics(window),
      performance.liveSessionMetrics(),
      performance.mailboxAssignmentCounts(),
      performance.documentVerificationMetrics(),
      /**
       * Phase 18. Assigned work, counted by the module that owns it.
       *
       * The task service exposes one aggregation for this; the engine does not
       * reach into the `Task` collection itself. That keeps "what counts as a
       * completed task" — done, not cancelled — defined in exactly one place.
       */
      completedTaskMetrics(window),
    ])

  return users.map((user) => {
    const key = String(user._id)

    const mailRow = mail.get(key)
    const campaignRow = campaigns.get(key)
    const leadRow = leads.get(key)
    const auditRow = audit.get(key)
    const responseRow = responses.get(key)
    const documentRow = documents.get(key)
    const taskRow = tasks.get(key)

    const completion = profileCompletion(user)

    const emailsSent = mailRow?.sent ?? 0
    const replies = base.replies.get(key)?.replies ?? 0

    /**
     * Last activity prefers the live session, then the most recent recorded
     * action, then the durable login timestamp.
     *
     * Sessions are swept by a TTL index, so the first is precise while it exists
     * and absent afterwards. Using only it would report a long-standing account
     * as never active.
     */
    const lastActivityAt =
      sessions.get(key)?.lastUsedAt ??
      base.lastSeen.get(key)?.lastActivityAt ??
      auditRow?.lastActionAt ??
      user.lastLoginAt ??
      null

    const metrics = {
      // --- Communication ---------------------------------------------------
      emailsSent,
      emailsFailed: mailRow?.failed ?? 0,
      emailsPending: mailRow?.pending ?? 0,
      emailsDelivered: null,
      replies,
      replyThreads: base.replies.get(key)?.threads ?? 0,
      /**
       * Replies per hundred sends.
       *
       * Not a true reply rate and labelled as such: a reply is counted against
       * the thread's owner, while a send is counted against its sender, and the
       * two need not be the same person on the same message. It is the closest
       * honest figure this schema supports.
       */
      replyRate: rate(replies, emailsSent),
      responseMinutes: responseRow?.medianMinutes ?? null,
      responseMinutesAverage: responseRow?.averageMinutes ?? null,
      responsesMeasured: responseRow?.responses ?? 0,
      mailboxes: mailboxes.get(key)?.mailboxes ?? 0,

      // --- Campaigns -------------------------------------------------------
      campaigns: campaignRow?.created ?? base.campaigns.get(key)?.campaigns ?? 0,
      campaignsRunning: campaignRow?.running ?? 0,
      campaignsCompleted: campaignRow?.completed ?? 0,
      campaignsScheduled: campaignRow?.scheduled ?? 0,
      campaignsDraft: campaignRow?.draft ?? 0,
      campaignRecipients: campaignRow?.recipients ?? 0,
      campaignSent: campaignRow?.sent ?? 0,
      campaignFailed: (campaignRow?.failed ?? 0) + (campaignRow?.bounced ?? 0),
      /**
       * Of everything a campaign actually attempted, how much left.
       *
       * The denominator is attempts, not recipients: a campaign still queuing
       * four thousand people has not failed to send to them yet. Null until
       * something has been attempted.
       */
      campaignSuccessRate: rate(
        campaignRow?.sent ?? 0,
        (campaignRow?.sent ?? 0) + (campaignRow?.failed ?? 0) + (campaignRow?.bounced ?? 0),
      ),
      campaignFailureRate: rate(
        (campaignRow?.failed ?? 0) + (campaignRow?.bounced ?? 0),
        (campaignRow?.sent ?? 0) + (campaignRow?.failed ?? 0) + (campaignRow?.bounced ?? 0),
      ),

      // --- Leads -----------------------------------------------------------
      leadsCreated: leadRow?.total ?? base.leads.get(key)?.leadsCreated ?? 0,
      leadsNew: leadRow?.bands?.new ?? 0,
      leadsContacted: leadRow?.bands?.contacted ?? 0,
      leadsQualified: leadRow?.bands?.qualified ?? 0,
      leadsConverted: leadRow?.bands?.converted ?? 0,
      leadsClosed: leadRow?.bands?.closed ?? 0,
      leadConversionRate: rate(leadRow?.bands?.converted ?? 0, leadRow?.total ?? 0),

      // --- Directory (counted, no longer scored) ---------------------------
      companiesAdded: base.companies.get(key)?.companiesAdded ?? 0,
      contactsAdded: base.contacts.get(key)?.contactsAdded ?? 0,

      // --- Attendance ------------------------------------------------------
      loginDays: auditRow?.loginDays ?? 0,
      logins: auditRow?.logins ?? 0,
      activeDays: auditRow?.activeDays ?? 0,
      recordedActions: auditRow?.events ?? 0,
      workingMinutes: auditRow?.workingMinutes ?? 0,
      liveSessions: sessions.get(key)?.sessions ?? 0,
      averageSessionMinutes: null,

      // --- Assigned work (Phase 18) ----------------------------------------
      tasksAssigned: taskRow?.tasksAssigned ?? 0,
      tasksCompleted: taskRow?.tasksCompleted ?? 0,
      tasksOpen: taskRow?.tasksOpen ?? 0,
      tasksOverdue: taskRow?.tasksOverdue ?? 0,
      taskCompletionRate: taskRow?.taskCompletionRate ?? null,
      taskAverageCompletionHours: taskRow?.averageCompletionHours ?? null,

      // --- Profile ---------------------------------------------------------
      profileCompletion: completion.percentage,
      documents: documentRow?.documents ?? 0,
      documentsVerified: documentRow?.verified ?? 0,
      documentVerifiedPercent: documentRow?.verifiedPercent ?? null,
    }

    const scored = computePerformanceScore(metrics, { windowDays: days, lastActivityAt })

    /**
     * Efficiency, separately from the score.
     *
     * The score answers "how much"; this answers "how well did it land". It is
     * the mean of the outcome rates that exist for this person — reply rate
     * (capped at 100, since replies can outnumber sends on a busy thread),
     * campaign success and lead conversion — and it is null when none of them
     * has a denominator, because an average of nothing is not zero.
     */
    const efficiencyParts = [
      metrics.replyRate === null ? null : Math.min(metrics.replyRate, 100),
      metrics.campaignSuccessRate,
      metrics.leadConversionRate,
      /**
       * Phase 18. Completed work lands here rather than in the score.
       *
       * The brief's six scoring weights were fixed in 17.3 and sum to 100; a
       * seventh factor would mean rebalancing all of them, which changes every
       * historical comparison for a reason nobody asked for. Efficiency is the
       * right home anyway — it is the average of *outcome rates*, and "of the
       * work you were given, how much did you finish" is exactly that.
       */
      metrics.taskCompletionRate,
    ].filter((value) => value !== null)

    const efficiency = efficiencyParts.length
      ? Number((efficiencyParts.reduce((a, b) => a + b, 0) / efficiencyParts.length).toFixed(1))
      : null

    return {
      id: key,
      displayName: user.displayName ?? null,
      email: user.email ?? null,
      avatarUrl: user.avatarUrl ?? null,
      role: user.role ?? null,
      roleLabel: ROLE_LABELS[user.role] ?? user.role ?? null,
      status: deriveUserStatus(user),
      department: user.department ?? null,
      designation: user.designation ?? null,
      lastLoginAt: user.lastLoginAt ?? null,
      lastActivityAt,
      metrics,
      performance: scored,
      efficiency,
      efficiencyBasis: efficiencyParts.length,
    }
  })
}

/**
 * Ranks rows by score and stamps each with its position.
 *
 * The rank is over **everybody in the window**, not over the page or the
 * filtered subset, so "3rd" means third in the organisation rather than third
 * of whoever happened to be on screen.
 */
export function rankRows(rows) {
  const ordered = [...rows].sort((a, b) => b.performance.score - a.performance.score)

  return new Map(ordered.map((row, index) => [row.id, index + 1]))
}

/**
 * One person's complete performance dashboard.
 *
 * Sections 1–5 come from the shared row; 6 and 7 are the trend series the 14.6
 * chart endpoint already produces, reused rather than reimplemented; 8 is the
 * audit trail for this actor.
 *
 * @param {{ userId: string, from?: Date, to?: Date, timelineLimit?: number }} params
 */
export async function buildEmployeePerformance({ userId, from, to, timelineLimit = 20 }) {
  const window = { from, to }
  const days = windowDays(window)

  const rows = await performanceRows(window, { includeInactive: true })
  const ranks = rankRows(rows)
  const row = rows.find((candidate) => candidate.id === String(userId))

  // No such account — which is not the same as an account with nothing to
  // report. Returning an empty dashboard would render a wall of zeroes for
  // somebody who does not exist.
  if (!row) throw ApiError.notFound('That user could not be found.')

  const [weekly, monthly, timeline] = await Promise.all([
    trendSeries({ userId, days: 7, unit: 'day' }),
    trendSeries({ userId, days: 30, unit: 'day' }),
    performance.actorTimeline({ actorId: userId, from, to, limit: timelineLimit }),
  ])

  const peers = rows.filter((candidate) => candidate.status !== 'disabled')
  const average = (pick) => {
    const values = peers.map(pick).filter((value) => value !== null && value !== undefined)
    return values.length
      ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1))
      : null
  }

  return {
    user: {
      id: row.id,
      displayName: row.displayName,
      email: row.email,
      avatarUrl: row.avatarUrl,
      role: row.role,
      roleLabel: row.roleLabel,
      status: row.status,
      department: row.department,
      designation: row.designation,
    },

    // --- Section 1 ---------------------------------------------------------
    summary: {
      score: row.performance.score,
      level: row.performance.level,
      efficiency: row.efficiency,
      efficiencyLevel: performanceLevel(row.efficiency),
      efficiencyBasis: row.efficiencyBasis,
      rank: ranks.get(row.id) ?? null,
      rankOf: rows.length,
      profileCompletion: row.metrics.profileCompletion,
      documentVerifiedPercent: row.metrics.documentVerifiedPercent,
      documents: row.metrics.documents,
      documentsVerified: row.metrics.documentsVerified,
      teamAverageScore: average((peer) => peer.performance.score),
    },

    // --- Sections 2–4 ------------------------------------------------------
    communication: {
      emailsSent: row.metrics.emailsSent,
      emailsDelivered: row.metrics.emailsDelivered,
      emailsFailed: row.metrics.emailsFailed,
      emailsPending: row.metrics.emailsPending,
      replies: row.metrics.replies,
      replyThreads: row.metrics.replyThreads,
      replyRate: row.metrics.replyRate,
      responseMinutes: row.metrics.responseMinutes,
      responseMinutesAverage: row.metrics.responseMinutesAverage,
      responsesMeasured: row.metrics.responsesMeasured,
      mailboxes: row.metrics.mailboxes,
    },

    campaigns: {
      created: row.metrics.campaigns,
      running: row.metrics.campaignsRunning,
      scheduled: row.metrics.campaignsScheduled,
      completed: row.metrics.campaignsCompleted,
      draft: row.metrics.campaignsDraft,
      recipients: row.metrics.campaignRecipients,
      sent: row.metrics.campaignSent,
      failed: row.metrics.campaignFailed,
      successRate: row.metrics.campaignSuccessRate,
      failureRate: row.metrics.campaignFailureRate,
    },

    leads: {
      created: row.metrics.leadsCreated,
      new: row.metrics.leadsNew,
      contacted: row.metrics.leadsContacted,
      qualified: row.metrics.leadsQualified,
      converted: row.metrics.leadsConverted,
      closed: row.metrics.leadsClosed,
      pending: row.metrics.leadsNew + row.metrics.leadsContacted + row.metrics.leadsQualified,
      conversionRate: row.metrics.leadConversionRate,
    },

    /** Phase 18. The work assigned to this person, beside the work they chose. */
    tasks: {
      assigned: row.metrics.tasksAssigned,
      completed: row.metrics.tasksCompleted,
      open: row.metrics.tasksOpen,
      overdue: row.metrics.tasksOverdue,
      completionRate: row.metrics.taskCompletionRate,
      averageCompletionHours: row.metrics.taskAverageCompletionHours,
    },

    // --- Section 5 ---------------------------------------------------------
    activity: {
      loginDays: row.metrics.loginDays,
      logins: row.metrics.logins,
      activeDays: row.metrics.activeDays,
      recordedActions: row.metrics.recordedActions,
      lastLoginAt: row.lastLoginAt,
      lastActivityAt: row.lastActivityAt,
      workingMinutes: row.metrics.workingMinutes,
      workingHours: Number((row.metrics.workingMinutes / 60).toFixed(1)),
      liveSessions: row.metrics.liveSessions,
      averageSessionMinutes: null,
      /** What the two derived attendance figures actually rest on. */
      basis: {
        source: 'audit-log',
        note: 'Login days and working hours come from recorded actions in the audit log — the span from the first to the last action each day. Not an attendance record.',
        retentionDays: config.audit.retentionEnabled ? config.audit.retentionDays : null,
      },
    },

    // --- Sections 6 and 7 --------------------------------------------------
    weekly,
    monthly,

    // --- Section 8 ---------------------------------------------------------
    /**
     * The label, category and severity are resolved from the registry, not read
     * from the row.
     *
     * `AuditLog` stores the action string and nothing else about how to word it
     * — `toPublicJSON` does exactly this resolution. An earlier version of this
     * service selected a `label` field that does not exist, and every entry in
     * the timeline rendered with a blank title.
     */
    timeline: timeline.map((entry) => {
      const definition = AUDIT_ACTION_INDEX[entry.action] ?? null

      return {
        id: String(entry._id),
        action: entry.action,
        category: entry.category ?? definition?.category ?? AUDIT_CATEGORY.SYSTEM,
        label: AUDIT_ACTION_LABELS[entry.action] ?? entry.action,
        summary: entry.summary,
        severity: entry.severity ?? definition?.severity ?? AUDIT_SEVERITY.NOTICE,
        result: entry.result ?? 'success',
        target: entry.entityName ?? null,
        at: entry.occurredAt,
      }
    }),

    metrics: row.metrics,
    components: row.performance.components,
    scoring: scoreDefinition(days),
    notMeasured: NOT_MEASURED,
    meta: {
      source: 'live-aggregation',
      windowDays: days,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      generatedAt: new Date().toISOString(),
    },
  }
}

/**
 * A gap-filled daily series for one person over the last `days` days.
 *
 * Reuses the 14.6 trend aggregation. The gap filling matters: an aggregation
 * only emits buckets that matched something, and plotting that draws a straight
 * line over a quiet week as though work happened during it.
 */
async function trendSeries({ userId, days, unit }) {
  const to = new Date()
  to.setUTCHours(23, 59, 59, 999)

  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - (days - 1))
  from.setUTCHours(0, 0, 0, 0)

  const trend = await analytics.userTrend({ userId, from, to, unit })

  const buckets = []
  const cursor = new Date(from)

  while (cursor <= to) {
    buckets.push(new Date(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  const series = (map) =>
    buckets.map((date) => ({
      periodStart: date.toISOString(),
      label: date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      value: map.get(date.getTime()) ?? 0,
    }))

  return {
    period: { from: from.toISOString(), to: to.toISOString(), unit, days },
    emails: series(trend.emails),
    replies: series(trend.replies),
    leads: series(trend.leads),
    campaigns: series(trend.campaigns),
  }
}

/**
 * Side-by-side comparison of two or more people.
 *
 * Deliberately not a winner: the response carries each person's figures and the
 * best value per metric, and leaves the console to mark it. Declaring a winner
 * server-side would bake in a view about which metric matters most, which is
 * exactly the judgement a comparison exists to let a human make.
 *
 * @param {{ userIds: string[], from?: Date, to?: Date }} params
 */
export async function buildPerformanceComparison({ userIds, from, to }) {
  const window = { from, to }
  const days = windowDays(window)

  const rows = await performanceRows(window, { includeInactive: true })
  const ranks = rankRows(rows)
  const wanted = userIds.map(String)

  const selected = wanted
    .map((id) => rows.find((row) => row.id === id))
    .filter(Boolean)
    .map((row) => ({
      id: row.id,
      displayName: row.displayName,
      email: row.email,
      avatarUrl: row.avatarUrl,
      roleLabel: row.roleLabel,
      department: row.department,
      score: row.performance.score,
      level: row.performance.level,
      efficiency: row.efficiency,
      rank: ranks.get(row.id) ?? null,
      metrics: row.metrics,
    }))

  /**
   * The metrics a comparison actually turns on.
   *
   * `higherIsBetter` is false for exactly one of them: a faster response is a
   * smaller number, and a table that highlights the largest value would silently
   * award the prize to the slowest person.
   */
  const fields = [
    { key: 'emailsSent', label: 'Emails sent', higherIsBetter: true },
    { key: 'replies', label: 'Replies received', higherIsBetter: true },
    { key: 'replyRate', label: 'Replies per 100 sends', unit: '%', higherIsBetter: true },
    { key: 'responseMinutes', label: 'Median response', unit: 'min', higherIsBetter: false },
    { key: 'campaigns', label: 'Campaigns created', higherIsBetter: true },
    { key: 'leadsCreated', label: 'Enquiries created', higherIsBetter: true },
    { key: 'leadsConverted', label: 'Enquiries converted', higherIsBetter: true },
    { key: 'leadConversionRate', label: 'Conversion rate', unit: '%', higherIsBetter: true },
    { key: 'workingMinutes', label: 'Recorded activity span', unit: 'min', higherIsBetter: true },
    { key: 'loginDays', label: 'Days signed in', higherIsBetter: true },
    { key: 'profileCompletion', label: 'Profile completion', unit: '%', higherIsBetter: true },
  ]

  const comparison = fields.map((field) => {
    const values = selected
      .map((person) => person.metrics[field.key])
      .filter((value) => value !== null && value !== undefined)

    const best = values.length
      ? field.higherIsBetter
        ? Math.max(...values)
        : Math.min(...values)
      : null

    return {
      ...field,
      best,
      // No winner when everybody is level: highlighting three identical zeroes
      // as "best" is noise dressed as insight.
      isDecisive: values.length > 1 && new Set(values).size > 1,
    }
  })

  return {
    people: selected,
    fields: comparison,
    missing: wanted.filter((id) => !selected.some((person) => person.id === id)),
    scoring: scoreDefinition(days),
    notMeasured: NOT_MEASURED,
    meta: { source: 'live-aggregation', windowDays: days, generatedAt: new Date().toISOString() },
  }
}

/**
 * The badges the leaderboard shows, and the widgets the dashboard shows.
 *
 * ## Every award has a floor
 *
 * A badge handed to whoever is least inactive is worse than no badge: it tells
 * the reader something happened when nothing did. So each award requires a
 * minimum of real activity, and returns `null` when nobody clears it.
 *
 * ## "Most improved" compares two windows
 *
 * It is the only figure here that needs a second aggregation pass — the same
 * length of window immediately before this one. Without that it would be
 * "highest score", which is already the first badge.
 *
 * @param {{ from?: Date, to?: Date, rows?: object[] }} params
 */
export async function buildPerformanceHighlights({ from, to, rows: provided } = {}) {
  const window = { from, to }
  const days = windowDays(window)

  const rows = provided ?? (await performanceRows(window))

  /** The previous window of equal length, for the improvement comparison. */
  const previous = await (async () => {
    if (!from || !to) return new Map()

    const previousTo = new Date(from.getTime() - 1)
    const previousFrom = new Date(previousTo.getTime() - (to.getTime() - from.getTime()))
    const earlier = await performanceRows({ from: previousFrom, to: previousTo })

    return new Map(earlier.map((row) => [row.id, row.performance.score]))
  })()

  const active = rows.filter((row) => row.performance.score > 0)

  /** Picks the best row by a measure, subject to a qualifying threshold. */
  const best = (candidates, measure, { qualifies = () => true } = {}) => {
    const eligible = candidates.filter(
      (row) => qualifies(row) && measure(row) !== null && measure(row) !== undefined,
    )
    if (eligible.length === 0) return null

    return eligible.reduce((leader, row) => (measure(row) > measure(leader) ? row : leader))
  }

  const summarise = (row, extra = {}) =>
    row
      ? {
          id: row.id,
          displayName: row.displayName,
          email: row.email,
          avatarUrl: row.avatarUrl,
          roleLabel: row.roleLabel,
          score: row.performance.score,
          level: row.performance.level,
          ...extra,
        }
      : null

  const topPerformer = best(active, (row) => row.performance.score)

  const lowestPerformer = (() => {
    // Only meaningful once there is somebody to be lowest *than*. A single
    // active person is not a bottom of anything.
    if (active.length < 2) return null
    return active.reduce((low, row) => (row.performance.score < low.performance.score ? row : low))
  })()

  const mostImproved = (() => {
    if (previous.size === 0) return null

    const deltas = rows
      .map((row) => ({ row, delta: Number((row.performance.score - (previous.get(row.id) ?? 0)).toFixed(1)) }))
      .filter((entry) => entry.delta > 0)

    if (deltas.length === 0) return null

    const leader = deltas.reduce((top, entry) => (entry.delta > top.delta ? entry : top))

    return summarise(leader.row, { delta: leader.delta, previousScore: previous.get(leader.row.id) ?? 0 })
  })()

  /** At least ten sends, so a single lucky reply cannot win a rate award. */
  const bestReplyRate = best(rows, (row) => row.metrics.replyRate, {
    qualifies: (row) => row.metrics.emailsSent >= 10,
  })

  const mostActive = best(rows, (row) => row.metrics.recordedActions, {
    qualifies: (row) => row.metrics.recordedActions > 0,
  })

  /** Fastest is the *smallest* median, over at least three measured responses. */
  const fastestResponder = (() => {
    const eligible = rows.filter(
      (row) => row.metrics.responseMinutes !== null && row.metrics.responsesMeasured >= 3,
    )
    if (eligible.length === 0) return null

    return eligible.reduce((fast, row) =>
      row.metrics.responseMinutes < fast.metrics.responseMinutes ? row : fast,
    )
  })()

  const mostEmails = best(rows, (row) => row.metrics.emailsSent, {
    qualifies: (row) => row.metrics.emailsSent > 0,
  })

  /**
   * Who a manager should look at, and the specific reason.
   *
   * Not "low score" — a low score can mean a support role, a part-timer or a
   * quiet fortnight, and a list of people whose only crime is a small number is
   * a list that gets ignored. Each entry names something concrete and
   * addressable.
   */
  const needsAttention = rows
    .map((row) => {
      const reasons = []

      if (row.metrics.emailsFailed > 0) {
        reasons.push(`${row.metrics.emailsFailed} failed send${row.metrics.emailsFailed === 1 ? '' : 's'}`)
      }
      if (row.metrics.profileCompletion < 60) {
        reasons.push(`profile ${row.metrics.profileCompletion}% complete`)
      }
      if (row.metrics.documents > 0 && row.metrics.documentVerifiedPercent === 0) {
        reasons.push('no documents verified')
      }
      if (row.metrics.loginDays === 0 && row.status === 'active') {
        reasons.push('no sign-in recorded in this period')
      }
      if (row.metrics.mailboxes === 0 && row.metrics.emailsSent === 0 && row.status === 'active') {
        reasons.push('no mailbox assigned')
      }

      return reasons.length ? summarise(row, { reasons }) : null
    })
    .filter(Boolean)
    // Most reasons first: somebody with four problems is a better use of the
    // next five minutes than somebody with one.
    .sort((a, b) => b.reasons.length - a.reasons.length)
    .slice(0, 8)

  return {
    badges: {
      topPerformer: summarise(topPerformer),
      mostImproved,
      bestReplyRate: summarise(bestReplyRate, { replyRate: bestReplyRate?.metrics.replyRate ?? null }),
      mostActive: summarise(mostActive, { recordedActions: mostActive?.metrics.recordedActions ?? 0 }),
      fastestResponder: summarise(fastestResponder, {
        responseMinutes: fastestResponder?.metrics.responseMinutes ?? null,
        responsesMeasured: fastestResponder?.metrics.responsesMeasured ?? 0,
      }),
    },
    widgets: {
      topPerformer: summarise(topPerformer),
      lowestPerformer: summarise(lowestPerformer),
      mostActive: summarise(mostActive, { recordedActions: mostActive?.metrics.recordedActions ?? 0 }),
      highestReplyRate: summarise(bestReplyRate, {
        replyRate: bestReplyRate?.metrics.replyRate ?? null,
      }),
      mostEmails: summarise(mostEmails, { emailsSent: mostEmails?.metrics.emailsSent ?? 0 }),
      needsAttention,
    },
    qualifications: {
      bestReplyRate: 'At least 10 sends in the period.',
      fastestResponder: 'At least 3 measured responses in the period.',
      lowestPerformer: 'Only shown when at least two people scored above zero.',
      mostImproved: 'Compared with the preceding window of the same length.',
    },
    teamAverageScore: rows.length
      ? Number((rows.reduce((sum, row) => sum + row.performance.score, 0) / rows.length).toFixed(1))
      : null,
    people: rows.length,
    notMeasured: NOT_MEASURED,
    meta: { source: 'live-aggregation', windowDays: days, generatedAt: new Date().toISOString() },
  }
}

export default {
  buildEmployeePerformance,
  buildPerformanceComparison,
  buildPerformanceHighlights,
  performanceRows,
  rankRows,
}
