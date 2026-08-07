/**
 * Analytics, aggregated live from the existing collections.
 *
 * No snapshot table, no cache, no duplicated metric. Every number returned here
 * is computed from the same documents the CRM screens read, which is what makes
 * the two surfaces incapable of disagreeing.
 *
 * The cost of that choice, and how it is bounded, is documented in
 * `adminTimeseries.repository.js`.
 */

import { LEAD_STAGE_LABELS, LEAD_STAGE_VALUES } from '../../leads/constants/leadConstants.js'
import {
  ANALYTICS_DEFAULT_BUCKETS,
  ANALYTICS_GRANULARITY,
} from '../constants/adminConstants.js'
import * as series from '../repositories/adminTimeseries.repository.js'
import * as stats from '../repositories/adminStats.repository.js'
import { ROLE_LABELS } from '../../../constants/roles.js'

/**
 * Resolves the requested window into a concrete `[from, to]`.
 *
 * A caller may supply either explicit dates or nothing at all. Nothing is the
 * common case — the console asks for "the last 30 days" — so the default is
 * derived from the granularity rather than being a fixed number of days that
 * would give one month bucket and eleven empty ones.
 */
function resolveWindow({ from, to, granularity }) {
  const end = to ? new Date(to) : new Date()
  end.setUTCHours(23, 59, 59, 999)

  if (from) {
    const start = new Date(from)
    start.setUTCHours(0, 0, 0, 0)
    return { from: start, to: end }
  }

  const buckets = ANALYTICS_DEFAULT_BUCKETS[granularity] ?? 30
  const start = new Date(end)

  if (granularity === ANALYTICS_GRANULARITY.MONTH) {
    start.setUTCMonth(start.getUTCMonth() - (buckets - 1))
    start.setUTCDate(1)
  } else if (granularity === ANALYTICS_GRANULARITY.WEEK) {
    start.setUTCDate(start.getUTCDate() - (buckets - 1) * 7)
  } else {
    start.setUTCDate(start.getUTCDate() - (buckets - 1))
  }

  start.setUTCHours(0, 0, 0, 0)
  return { from: start, to: end }
}

/** Total of a series, for the headline figure above its chart. */
const sum = (points) => points.reduce((total, point) => total + point.value, 0)

/**
 * Change against the immediately preceding window of equal length.
 *
 * Returns null rather than a number when the previous window is empty. A jump
 * from zero is arithmetically infinite and rendering it as "+100%" or "+∞%"
 * says something false about a period in which nothing happened.
 */
function trend(points) {
  if (points.length < 2) return null

  const half = Math.floor(points.length / 2)
  const previous = sum(points.slice(0, half))
  const current = sum(points.slice(half))

  if (previous === 0) return null

  return Number((((current - previous) / previous) * 100).toFixed(1))
}

/**
 * Builds the analytics payload.
 *
 * @param {{ from?: string, to?: string, granularity?: string }} [query]
 */
export async function buildAdminAnalytics(query = {}) {
  const granularity = query.granularity ?? ANALYTICS_GRANULARITY.DAY
  const window = resolveWindow({ ...query, granularity })

  const [growth, pipelineMap, ownerRows, conversations, mail] = await Promise.all([
    series.growthSeries({ ...window, granularity }),
    series.pipelineBreakdown(),
    series.leadsByOwner({ limit: 20 }),
    stats.conversationCounts(),
    stats.mailCounts(),
  ])

  /**
   * The pipeline in the register's own stage order, including empty stages.
   *
   * Ordered by `LEAD_STAGE_VALUES` rather than by count: a funnel sorted by size
   * is not a funnel, and a stage with nothing in it is exactly the stage an
   * operator needs to see.
   */
  const pipeline = LEAD_STAGE_VALUES.map((stage) => ({
    stage,
    label: LEAD_STAGE_LABELS[stage] ?? stage,
    value: pipelineMap.get(stage) ?? 0,
  }))

  const replyRate =
    mail.sent === 0 ? null : Number(((conversations.replies / mail.sent) * 100).toFixed(1))

  return {
    period: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      granularity,
      buckets: growth.leads.length,
    },

    summary: {
      leads: { total: sum(growth.leads), trend: trend(growth.leads) },
      mail: { total: sum(growth.mail), trend: trend(growth.mail) },
      campaigns: { total: sum(growth.campaigns), trend: trend(growth.campaigns) },
      replies: { total: sum(growth.replies), trend: trend(growth.replies) },
      replyRate,
      averageFirstResponseMs: conversations.averageFirstResponseMs,
      mailSuccessRate: mail.successRate,
    },

    /** Four independent single-measure series. None shares an axis with another. */
    growth,

    pipeline,

    userPerformance: ownerRows.map((row) => ({
      id: String(row._id),
      name: row.user?.displayName ?? row.user?.email ?? 'Unknown user',
      email: row.user?.email ?? null,
      role: row.user?.role ?? null,
      roleLabel: ROLE_LABELS[row.user?.role] ?? row.user?.role ?? null,
      leads: row.leads,
      won: row.won,
      lost: row.lost,
      emailed: row.emailed,
    })),

    meta: { source: 'live-aggregation', scope: 'deployment', generatedAt: new Date().toISOString() },
  }
}

export default { buildAdminAnalytics }
