/**
 * Performance aggregations (Phase 17.3).
 *
 * ## Why a second analytics repository
 *
 * `adminAnalytics.repository.js` answers "how much did each person do" — six
 * counts that feed the leaderboard. This one answers the questions the
 * performance dashboard adds: how mail actually *fared*, how quickly somebody
 * replies, what state their campaigns and enquiries are in, and whether they
 * turned up. Those are different shapes over different collections, and folding
 * them into the existing file would have made one module that nobody could hold
 * in their head.
 *
 * Nothing here recomputes anything that file already computes. Where both need
 * the same figure — emails sent, replies, leads created — the caller uses the
 * existing one. See `employeePerformance.service.js`, which joins them.
 *
 * ## Everything is live, and what is not recorded stays null
 *
 * Same rule as everywhere else in this console: no snapshot table, no cached
 * metric, and no estimate standing in for a measurement. Three figures the brief
 * asks for are **not derivable from what this CRM stores**, and they are
 * returned as `null` with a reason rather than as a plausible number:
 *
 *   - **Emails delivered.** Graph answers 202 Accepted. That is the provider
 *     agreeing to try, not the message arriving, and nothing later tells us
 *     whether it did. `Mail.status = 'sent'` means accepted.
 *   - **Opens and clicks.** No tracking pixel and no link rewriting. The
 *     campaign schema has the fields; nothing ever writes them.
 *   - **Average session duration.** Sessions are swept by a TTL index the moment
 *     they expire, so a finished session leaves no row to measure. Live sessions
 *     can be counted; historical ones cannot be averaged.
 *
 * ## Cost
 *
 * Every pipeline starts with a `$match` on an indexed field and is bounded by
 * the window. The response-time pipeline is the one to watch: it sorts messages
 * within each conversation, so it is bounded by *messages in the window* rather
 * than by people. It is called once per request and shared by every consumer.
 */

import { AuditLog } from '../../../models/auditLog.model.js'
import { Campaign } from '../../../models/campaign.model.js'
import { ConversationMessage } from '../../../models/conversationMessage.model.js'
import { Lead } from '../../../models/lead.model.js'
import { Mail } from '../../../models/mail.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { Session } from '../../../models/session.model.js'
import { User } from '../../../models/user.model.js'
import { UserDocument } from '../../../models/userDocument.model.js'
import { DOCUMENT_STATUS } from '../../../constants/employeeProfile.js'
import { MAIL_STATUS } from '../../../constants/mailStatus.js'
import { FUNNEL_BANDS } from './adminAnalytics.repository.js'

/** Turns `[{_id, ...}]` into a Map keyed by the id as a string. */
const toMap = (rows) => new Map(rows.map((row) => [String(row._id), row]))

/** A closed window on a field, or `{}` when unbounded. */
function within(field, { from, to } = {}) {
  if (!from && !to) return {}

  const range = {}
  if (from) range.$gte = from
  if (to) range.$lte = to

  return { [field]: range }
}

/** The audit actions that mean somebody signed in. */
export const LOGIN_ACTIONS = Object.freeze(['auth.google_login', 'auth.microsoft_login'])

/** Which funnel band each stage belongs to, inverted once at module load. */
const BAND_OF_STAGE = new Map(
  FUNNEL_BANDS.flatMap((band) => band.stages.map((stage) => [stage, band.key])),
)

// ---------------------------------------------------------------------------
// Communication
// ---------------------------------------------------------------------------

/**
 * Outbound mail per user: what was accepted, what failed, what is still queued.
 *
 * Counted from `Mail`, which records one row per message the CRM submitted —
 * including the ones it failed to submit, which is the point. A dashboard that
 * counts only successes reports a broken mailbox as a quiet day.
 */
export async function mailOutcomeMetrics(window = {}) {
  const rows = await Mail.aggregate([
    { $match: { direction: 'outbound', ...within('createdAt', window) } },
    {
      $group: {
        _id: '$userId',
        // `replied` is terminal *after* sent, so it counts as having left.
        sent: {
          $sum: {
            $cond: [{ $in: ['$status', [MAIL_STATUS.SENT, MAIL_STATUS.REPLIED]] }, 1, 0],
          },
        },
        replied: { $sum: { $cond: [{ $eq: ['$status', MAIL_STATUS.REPLIED] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', MAIL_STATUS.FAILED] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ['$status', MAIL_STATUS.PENDING] }, 1, 0] } },
        drafts: { $sum: { $cond: [{ $eq: ['$status', MAIL_STATUS.DRAFT] }, 1, 0] } },
        lastSentAt: { $max: '$createdAt' },
      },
    },
  ])

  return toMap(rows)
}

/**
 * How long each person takes to answer, in minutes.
 *
 * ## What is being measured, exactly
 *
 * For every message in the window, `$shift` looks at the next message in the
 * same conversation. Where an **incoming** message is followed by an
 * **outgoing** one, the gap between them is one response. Nothing else counts.
 *
 * So this is "how long after the customer's last message did the reply go out",
 * which is the question somebody actually means by response time. A customer who
 * sends three messages before anyone answers contributes one measurement, not
 * three, because they were answered once.
 *
 * ## Why the median as well as the mean
 *
 * One thread answered after a fortnight drags a mean into uselessness. Both are
 * returned and the console shows the median, with the mean available — a single
 * average of a long-tailed distribution is how dashboards mislead people.
 */
export async function responseTimeMetrics(window = {}) {
  const rows = await ConversationMessage.aggregate([
    { $match: { ...within('occurredAt', window) } },
    { $sort: { conversation: 1, occurredAt: 1 } },
    {
      $setWindowFields: {
        partitionBy: '$conversation',
        sortBy: { occurredAt: 1 },
        output: {
          nextDirection: { $shift: { output: '$direction', by: 1 } },
          nextAt: { $shift: { output: '$occurredAt', by: 1 } },
          nextOwner: { $shift: { output: '$owner', by: 1 } },
        },
      },
    },
    {
      $match: {
        direction: 'incoming',
        nextDirection: 'outgoing',
        nextAt: { $ne: null },
      },
    },
    {
      $project: {
        owner: '$nextOwner',
        minutes: { $divide: [{ $subtract: ['$nextAt', '$occurredAt'] }, 60_000] },
      },
    },
    // A negative gap would mean the reply predates the message it answers, which
    // only happens when a provider timestamp is wrong. Dropped rather than
    // averaged in as a negative response time.
    { $match: { minutes: { $gte: 0 } } },
    {
      $group: {
        _id: '$owner',
        responses: { $sum: 1 },
        averageMinutes: { $avg: '$minutes' },
        medianMinutes: { $percentile: { input: '$minutes', p: [0.5], method: 'approximate' } },
        fastestMinutes: { $min: '$minutes' },
        slowestMinutes: { $max: '$minutes' },
      },
    },
  ])

  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        responses: row.responses,
        averageMinutes: Math.round(row.averageMinutes),
        medianMinutes: Math.round(row.medianMinutes?.[0] ?? row.averageMinutes),
        fastestMinutes: Math.round(row.fastestMinutes),
        slowestMinutes: Math.round(row.slowestMinutes),
      },
    ]),
  )
}

/** How many mailboxes each person may send from. */
export async function mailboxAssignmentCounts() {
  const rows = await Mailbox.aggregate([
    { $unwind: '$assignedUsers' },
    { $group: { _id: '$assignedUsers', mailboxes: { $sum: 1 } } },
  ])

  return toMap(rows)
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

/**
 * Campaign counts and send outcomes per owner.
 *
 * `stats` is summed rather than recounted from `CampaignRecipient`: the campaign
 * document maintains those totals as sends complete, and the model documents
 * them as reconcilable against the recipients. Aggregating ten thousand
 * recipient rows per person to reach the same numbers would be the wrong trade.
 */
export async function campaignMetrics(window = {}) {
  const rows = await Campaign.aggregate([
    { $match: within('createdAt', window) },
    {
      $group: {
        _id: '$owner',
        created: { $sum: 1 },
        running: { $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] } },
        scheduled: { $sum: { $cond: [{ $eq: ['$status', 'scheduled'] }, 1, 0] } },
        paused: { $sum: { $cond: [{ $eq: ['$status', 'paused'] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        draft: { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        recipients: { $sum: '$stats.recipients' },
        sent: { $sum: '$stats.sent' },
        failed: { $sum: '$stats.failed' },
        bounced: { $sum: '$stats.bounced' },
        replied: { $sum: '$stats.replied' },
      },
    },
  ])

  return toMap(rows)
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/**
 * Enquiries per owner, bucketed by the funnel bands the console already uses.
 *
 * The bands are imported rather than restated: "converted" means `booked` or
 * `completed` in exactly one place, and the lead analytics screen and this
 * dashboard cannot disagree about it.
 *
 * Counted by **creation date within the window**, like every other figure on the
 * report. A lead created last year and won today is not this month's work, and
 * counting it as such would let an old pipeline flatter a quiet month.
 */
export async function leadMetrics(window = {}) {
  const rows = await Lead.aggregate([
    { $match: { isDeleted: false, ...within('createdAt', window) } },
    { $group: { _id: { owner: '$owner', stage: '$stage' }, count: { $sum: 1 } } },
  ])

  const byOwner = new Map()

  for (const row of rows) {
    const key = String(row._id.owner)
    const entry = byOwner.get(key) ?? { total: 0, byStage: {}, bands: {} }
    const band = BAND_OF_STAGE.get(row._id.stage)

    entry.total += row.count
    entry.byStage[row._id.stage] = (entry.byStage[row._id.stage] ?? 0) + row.count
    if (band) entry.bands[band] = (entry.bands[band] ?? 0) + row.count

    byOwner.set(key, entry)
  }

  return byOwner
}

// ---------------------------------------------------------------------------
// Attendance and activity
// ---------------------------------------------------------------------------

/**
 * Sign-ins, recorded action volume and the daily span of activity, per actor.
 *
 * ## Source
 *
 * The audit log, because it is the only collection that records *when somebody
 * did something* across every module. Sessions cannot answer it — they are
 * TTL-swept — and a business collection only knows about its own kind of work.
 *
 * ## Working hours are a span, not a timesheet
 *
 * For each day, the earliest and latest recorded action bound a span, and the
 * spans are summed. Somebody who acts at 09:00 and again at 17:00 shows eight
 * hours; if they went to the dentist in between, this cannot tell. It is
 * "recorded activity span", the response labels it as derived, and it is not
 * offered as an attendance record.
 *
 * A day with a single action has a zero-length span. That is correct and
 * deliberately not rounded up to some minimum — inventing a half-hour would make
 * the total a guess.
 *
 * ## Retention
 *
 * Audit entries expire on the retention TTL, so a window reaching further back
 * than retention reports fewer days than really happened. The caller states the
 * retention horizon alongside the figure.
 */
export async function auditActivityMetrics(window = {}) {
  const [byDay, logins] = await Promise.all([
    AuditLog.aggregate([
      { $match: within('occurredAt', window) },
      {
        $group: {
          _id: {
            actor: '$actor',
            day: { $dateTrunc: { date: '$occurredAt', unit: 'day' } },
          },
          events: { $sum: 1 },
          first: { $min: '$occurredAt' },
          last: { $max: '$occurredAt' },
        },
      },
      {
        $group: {
          _id: '$_id.actor',
          activeDays: { $sum: 1 },
          events: { $sum: '$events' },
          spanMinutes: {
            $sum: { $divide: [{ $subtract: ['$last', '$first'] }, 60_000] },
          },
          lastActionAt: { $max: '$last' },
        },
      },
    ]),

    AuditLog.aggregate([
      { $match: { action: { $in: LOGIN_ACTIONS }, ...within('occurredAt', window) } },
      {
        $group: {
          _id: {
            actor: '$actor',
            day: { $dateTrunc: { date: '$occurredAt', unit: 'day' } },
          },
          logins: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: '$_id.actor',
          loginDays: { $sum: 1 },
          logins: { $sum: '$logins' },
        },
      },
    ]),
  ])

  const activity = toMap(byDay)
  const signIns = toMap(logins)

  const keys = new Set([...activity.keys(), ...signIns.keys()])

  return new Map(
    [...keys].map((key) => {
      const row = activity.get(key)

      return [
        key,
        {
          activeDays: row?.activeDays ?? 0,
          events: row?.events ?? 0,
          workingMinutes: Math.round(row?.spanMinutes ?? 0),
          lastActionAt: row?.lastActionAt ?? null,
          loginDays: signIns.get(key)?.loginDays ?? 0,
          logins: signIns.get(key)?.logins ?? 0,
        },
      ]
    }),
  )
}

/**
 * One person's recent recorded actions, newest first.
 *
 * The **summary** is returned exactly as it was written, because a description
 * composed at the time is the only version of an event that can be trusted
 * afterwards. The human **label** is not stored at all — `AuditLog` keeps the
 * action string and the model resolves the wording from the registry on read,
 * so an entry written before a label was reworded still renders with today's.
 * The caller does the same resolution rather than selecting a field that does
 * not exist.
 */
export async function actorTimeline({ actorId, from, to, limit = 25 }) {
  return AuditLog.find({ actor: actorId, ...within('occurredAt', { from, to }) })
    .select('action category summary occurredAt severity result entityName entityType')
    .sort({ occurredAt: -1, _id: -1 })
    .limit(limit)
    .lean()
}

/**
 * Live sessions, per user.
 *
 * A count of sessions that exist **right now**. Expired ones are gone, so this
 * cannot be turned into a history and is never presented as one.
 */
export async function liveSessionMetrics() {
  const rows = await Session.aggregate([
    { $match: { expiresAt: { $gt: new Date() } } },
    {
      $group: {
        _id: '$user',
        sessions: { $sum: 1 },
        lastUsedAt: { $max: '$lastUsedAt' },
        oldestStartedAt: { $min: '$createdAt' },
      },
    },
  ])

  return toMap(rows)
}

// ---------------------------------------------------------------------------
// Profile and documents
// ---------------------------------------------------------------------------

/**
 * Document verification progress, per user.
 *
 * `verifiedPercent` is null when somebody has uploaded nothing: zero percent
 * verified reads as a failure to get documents approved, when in fact there is
 * nothing to approve.
 */
export async function documentVerificationMetrics() {
  const rows = await UserDocument.aggregate([
    { $match: { isDeleted: { $ne: true } } },
    {
      $group: {
        _id: '$user',
        documents: { $sum: 1 },
        verified: { $sum: { $cond: [{ $eq: ['$status', DOCUMENT_STATUS.VERIFIED] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ['$status', DOCUMENT_STATUS.PENDING] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ['$status', DOCUMENT_STATUS.REJECTED] }, 1, 0] } },
      },
    },
  ])

  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        documents: row.documents,
        verified: row.verified,
        pending: row.pending,
        rejected: row.rejected,
        verifiedPercent:
          row.documents === 0 ? null : Math.round((row.verified / row.documents) * 100),
      },
    ]),
  )
}

/**
 * The profile fields the completion percentage is computed from.
 *
 * Selected here rather than calling the profile service per user: the dashboard
 * needs this for everybody at once, and `getProfile()` is one round trip per
 * person plus work the score does not need.
 */
export async function profileFieldsFor(userIds = null) {
  const filter = userIds ? { _id: { $in: userIds } } : {}

  return User.find(filter)
    .select(
      'phone employeeId department designation dateOfBirth gender address emergencyContact profilePhoto joiningDate',
    )
    .lean()
}

export default {
  actorTimeline,
  auditActivityMetrics,
  campaignMetrics,
  documentVerificationMetrics,
  leadMetrics,
  liveSessionMetrics,
  mailOutcomeMetrics,
  mailboxAssignmentCounts,
  profileFieldsFor,
  responseTimeMetrics,
}
