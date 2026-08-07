/**
 * Team performance, mailbox analytics, the lead funnel and the organisation
 * timeline — the four reads Phase 14.6 adds.
 *
 * Every figure is aggregated live. There is no snapshot table, no background
 * job and no cached metric, which is what makes these numbers incapable of
 * disagreeing with the CRM screens they are derived from.
 *
 * Where a fact is not recorded anywhere, the field is `null` and the response
 * says so. Nothing here estimates.
 */

import { Mailbox } from '../../../models/mailbox.model.js'
import { User } from '../../../models/user.model.js'
import { scoreDefinition } from '../constants/performanceScore.js'
import { mailboxHealth } from '../dto/adminMailbox.dto.js'
import * as analytics from '../repositories/adminAnalytics.repository.js'
import {
  buildPerformanceHighlights,
  performanceRows,
  rankRows,
  windowDays,
} from './employeePerformance.service.js'

/**
 * The leaderboard.
 *
 * ## Scored, then sorted, then paged — in that order
 *
 * The score cannot be a database sort: it combines aggregations from nine
 * collections and Mongo never sees the combined number. The set being ordered is
 * one row per account, which is small by construction — a directory is people,
 * not records — so ranking in memory is correct rather than a compromise.
 *
 * ## Phase 17.3: the rows come from the performance engine
 *
 * This function used to assemble and score its own rows. It now asks
 * `performanceRows()` for them, which is the same computation the User 360
 * dashboard, the comparison view and the console's widgets use. That is the
 * whole reason for the change: a "top performer" card that scored independently
 * would eventually disagree with the board directly beneath it, and nobody
 * looking at two plausible numbers can tell which one is wrong.
 *
 * The response shape is unchanged. Search and pagination still happen here,
 * because they are presentation concerns of this endpoint rather than part of
 * the engine.
 *
 * @param {{ from?: Date, to?: Date, search?: string, role?: string,
 *           page?: number, limit?: number, sort?: string }} query
 */
export async function buildTeamPerformance(query = {}) {
  const { from, to, search, role, page = 1, limit = 25, sort = 'score' } = query
  const window = { from, to }
  const days = windowDays(window)

  const scored = await performanceRows(window, { role })

  /**
   * Ranks are assigned before the search filter.
   *
   * Somebody searching for one person should see that person's standing in the
   * organisation, not "1st" because they are the only row matching the query.
   */
  const ranks = rankRows(scored)

  const rows = search
    ? (() => {
        const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = new RegExp(safe, 'i')

        return scored.filter(
          (row) => pattern.test(row.displayName ?? '') || pattern.test(row.email ?? ''),
        )
      })()
    : scored

  const sorters = {
    score: (a, b) => b.performance.score - a.performance.score,
    emails: (a, b) => b.metrics.emailsSent - a.metrics.emailsSent,
    replies: (a, b) => b.metrics.replies - a.metrics.replies,
    leads: (a, b) => b.metrics.leadsCreated - a.metrics.leadsCreated,
    name: (a, b) => (a.displayName ?? a.email ?? '').localeCompare(b.displayName ?? b.email ?? ''),
    activity: (a, b) => new Date(b.lastActivityAt ?? 0) - new Date(a.lastActivityAt ?? 0),
  }

  rows.sort(sorters[sort] ?? sorters.score)

  const total = rows.length
  const start = (page - 1) * limit

  /**
   * The badges (Phase 17.3), computed from the same rows that were just scored.
   *
   * Passed in rather than recomputed: the highlights builder would otherwise run
   * the whole nine-aggregation pass a second time for numbers this function is
   * already holding.
   */
  const highlights = await buildPerformanceHighlights({ from, to, rows: scored })

  return {
    items: rows
      .slice(start, start + limit)
      .map((row) => ({ ...row, rank: ranks.get(row.id) ?? null })),
    /** Totals across everybody matched, not just this page. */
    totals: rows.reduce(
      (sum, row) => ({
        emailsSent: sum.emailsSent + row.metrics.emailsSent,
        replies: sum.replies + row.metrics.replies,
        leadsCreated: sum.leadsCreated + row.metrics.leadsCreated,
        campaigns: sum.campaigns + row.metrics.campaigns,
        companiesAdded: sum.companiesAdded + row.metrics.companiesAdded,
        contactsAdded: sum.contactsAdded + row.metrics.contactsAdded,
      }),
      { emailsSent: 0, replies: 0, leadsCreated: 0, campaigns: 0, companiesAdded: 0, contactsAdded: 0 },
    ),
    badges: highlights.badges,
    badgeQualifications: highlights.qualifications,
    teamAverageScore: highlights.teamAverageScore,
    scoring: scoreDefinition(days),
    notMeasured: highlights.notMeasured,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    meta: { source: 'live-aggregation', windowDays: days, generatedAt: new Date().toISOString() },
  }
}

/**
 * One person's activity over time, for the 360 dashboard's charts.
 *
 * Returns gap-filled series: an aggregation only emits buckets that matched
 * something, and plotting that draws a line straight over a quiet week.
 */
export async function buildUserPerformance({ userId, from, to, unit }) {
  const [trend, metrics] = await Promise.all([
    analytics.userTrend({ userId, from, to, unit }),
    analytics.userActivityMetrics({ from, to }),
  ])

  const buckets = []
  const cursor = new Date(from)
  cursor.setUTCHours(0, 0, 0, 0)

  if (unit === 'month') cursor.setUTCDate(1)
  if (unit === 'year') {
    cursor.setUTCMonth(0)
    cursor.setUTCDate(1)
  }
  if (unit === 'week') {
    const day = cursor.getUTCDay()
    cursor.setUTCDate(cursor.getUTCDate() - (day === 0 ? 6 : day - 1))
  }

  while (cursor <= to) {
    buckets.push(new Date(cursor))

    if (unit === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    else if (unit === 'year') cursor.setUTCFullYear(cursor.getUTCFullYear() + 1)
    else if (unit === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7)
    else cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  const label = (date) =>
    unit === 'year'
      ? String(date.getUTCFullYear())
      : unit === 'month'
        ? date.toLocaleDateString('en-AU', { month: 'short', year: '2-digit', timeZone: 'UTC' })
        : date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' })

  const series = (map) =>
    buckets.map((date) => ({
      periodStart: date.toISOString(),
      label: label(date),
      value: map.get(date.getTime()) ?? 0,
    }))

  const key = String(userId)

  return {
    period: { from: from.toISOString(), to: to.toISOString(), unit, buckets: buckets.length },
    series: {
      emails: series(trend.emails),
      replies: series(trend.replies),
      leads: series(trend.leads),
      campaigns: series(trend.campaigns),
      companies: series(trend.companies),
      contacts: series(trend.contacts),
    },
    totals: {
      emailsSent: metrics.mail.get(key)?.emailsSent ?? 0,
      replies: metrics.replies.get(key)?.replies ?? 0,
      leadsCreated: metrics.leads.get(key)?.leadsCreated ?? 0,
      campaigns: metrics.campaigns.get(key)?.campaigns ?? 0,
      companiesAdded: metrics.companies.get(key)?.companiesAdded ?? 0,
      contactsAdded: metrics.contacts.get(key)?.contactsAdded ?? 0,
    },
    meta: { source: 'live-aggregation', generatedAt: new Date().toISOString() },
  }
}

/** Send volume, replies and the busiest sender, per mailbox. */
export async function buildMailboxAnalytics(window = {}) {
  const [mailboxes, metrics] = await Promise.all([
    Mailbox.find({})
      .select('user assignedUsers defaultUsers provider emailAddress displayName status statusReason syncEnabled connectedAt disconnectedAt stats')
      .lean(),
    analytics.mailboxActivityMetrics(window),
  ])

  const topUserIds = [...metrics.topUser.values()].map((entry) => entry.userId)
  const owners = await User.find({ _id: { $in: [...new Set(topUserIds)] } })
    .select('displayName email')
    .lean()

  const byId = new Map(owners.map((user) => [String(user._id), user]))

  const items = mailboxes.map((mailbox) => {
    const key = String(mailbox._id)
    const top = metrics.topUser.get(key)

    return {
      id: key,
      emailAddress: mailbox.emailAddress ?? null,
      displayName: mailbox.displayName ?? null,
      provider: mailbox.provider ?? null,
      status: mailbox.status ?? null,
      health: mailboxHealth(mailbox),
      assignedUserCount: (mailbox.assignedUsers ?? []).length,
      defaultUserCount: (mailbox.defaultUsers ?? []).length,
      connectedAt: mailbox.connectedAt ?? null,
      lastSyncAt: mailbox.stats?.lastSuccessfulSyncAt ?? null,

      emailsSent: metrics.sent.get(key)?.emailsSent ?? 0,
      lastSentAt: metrics.sent.get(key)?.lastSentAt ?? null,
      campaigns: metrics.campaigns.get(key)?.campaigns ?? 0,

      /**
       * Replies are not attributable to a mailbox.
       *
       * `Conversation` records the owner, not the mailbox the thread arrived
       * through, so a per-mailbox reply count cannot be derived from what is
       * stored. Reported as null rather than as the owner's total, which would
       * be a different number wearing this one's label.
       */
      replies: null,

      topUser: top
        ? {
            id: top.userId,
            name: byId.get(top.userId)?.displayName ?? byId.get(top.userId)?.email ?? 'Unknown user',
            emailsSent: top.count,
          }
        : null,
    }
  })

  return {
    items: items.sort((a, b) => b.emailsSent - a.emailsSent),
    summary: {
      total: items.length,
      emailsSent: items.reduce((sum, item) => sum + item.emailsSent, 0),
      unused: items.filter((item) => item.emailsSent === 0).length,
    },
    notes: {
      replies: 'Replies are recorded against the thread owner, not the receiving mailbox.',
    },
    meta: { source: 'live-aggregation', generatedAt: new Date().toISOString() },
  }
}

/** The lead funnel, its bands and the stages each band contains. */
export async function buildLeadAnalytics(window = {}) {
  const funnel = await analytics.leadFunnel(window)

  const total = funnel.bands.reduce((sum, band) => sum + band.value, 0)
  const converted = funnel.bands.find((band) => band.key === 'converted')?.value ?? 0

  return {
    ...funnel,
    total,
    conversionRate: total === 0 ? null : Number(((converted / total) * 100).toFixed(1)),
    meta: { source: 'live-aggregation', generatedAt: new Date().toISOString() },
  }
}

/**
 * The organisation timeline.
 *
 * Merged from four collections and sorted newest first. **Not an audit log** —
 * these are business events the CRM already records, not a trail of privileged
 * actions. Audit is a later phase and nothing here anticipates it beyond leaving
 * the shape compatible.
 */
export async function buildOrganisationActivity({ from, to, limit = 40 }) {
  const raw = await analytics.organisationActivity({ from, to, limit })

  const ownerIds = [
    ...raw.leads.map((row) => row.owner),
    ...raw.campaigns.map((row) => row.owner),
    ...raw.imports.map((row) => row.owner),
    ...raw.replies.map((row) => row.owner),
  ].filter(Boolean)

  const users = await User.find({ _id: { $in: [...new Set(ownerIds.map(String))] } })
    .select('displayName email')
    .lean()

  const nameOf = (id) => {
    const user = users.find((entry) => String(entry._id) === String(id))
    return user?.displayName ?? user?.email ?? 'Unknown user'
  }

  const events = [
    ...raw.leads.map((row) => ({
      id: `lead-${row._id}`,
      type: 'LEAD_CREATED',
      label: 'Lead created',
      summary: `${row.reference} — ${row.contactPerson}`,
      actor: nameOf(row.owner),
      at: row.createdAt,
    })),
    ...raw.campaigns.map((row) => ({
      id: `campaign-${row._id}`,
      type: row.completedAt ? 'CAMPAIGN_COMPLETED' : 'CAMPAIGN_STARTED',
      label: row.completedAt ? 'Campaign finished' : 'Campaign started',
      summary: `${row.name} — ${row.stats?.sent ?? 0} sent`,
      actor: nameOf(row.owner),
      at: row.completedAt ?? row.startedAt,
    })),
    ...raw.imports.map((row) => ({
      id: `import-${row._id}`,
      type: 'WORKBOOK_IMPORTED',
      label: 'Workbook imported',
      summary: `${row.filename} — ${row.syncSummary?.new ?? 0} new`,
      actor: nameOf(row.owner),
      at: row.createdAt,
    })),
    ...raw.replies.map((row) => ({
      id: `reply-${row._id}`,
      type: 'REPLY_RECEIVED',
      label: 'Reply received',
      summary: `${row.counterpartyName ?? 'A customer'} — ${row.subject || 'no subject'}`,
      actor: nameOf(row.owner),
      at: row.lastIncomingMessage?.at,
    })),
  ]
    .filter((event) => event.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit)

  return {
    items: events,
    meta: {
      source: 'live-collections',
      note: 'Business events recorded by the CRM. This is not an audit trail.',
      generatedAt: new Date().toISOString(),
    },
  }
}

export default {
  buildLeadAnalytics,
  buildMailboxAnalytics,
  buildOrganisationActivity,
  buildTeamPerformance,
  buildUserPerformance,
}
