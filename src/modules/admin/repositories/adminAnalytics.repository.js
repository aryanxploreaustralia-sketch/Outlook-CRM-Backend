/**
 * Analytics aggregations.
 *
 * **Every figure here is computed from live CRM collections.** No snapshot
 * table, no background job, no cached metric, and nothing invented — where a
 * fact is not recorded anywhere, the caller returns `null` and the console says
 * "Not available" rather than rendering a zero somebody would act on.
 *
 * ## Why per-user metrics are possible at all
 *
 * Every business collection already carries the owner: `Mail.userId`,
 * `Lead.owner`, `Campaign.owner`, `Company.owner`, `Contact.owner`,
 * `Conversation.owner`. That was true before this phase — nothing was added to
 * make it so. These functions group by those fields.
 *
 * ## The shape of every function here
 *
 * One `$match` on an indexed date field, one `$group`, and out. They return
 * `Map`s keyed by id rather than arrays, because every caller joins them
 * together by user or mailbox and a linear scan per row is how a leaderboard
 * becomes quadratic.
 *
 * ## Cost
 *
 * Bounded by the window, not the collection: the `$match` comes first and every
 * date field it uses is indexed. There is no `$lookup` in the hot paths — names
 * are resolved once, afterwards, in a single `User.find`.
 */

import { Campaign } from '../../../models/campaign.model.js'
import { Company } from '../../../models/company.model.js'
import { Contact } from '../../../models/contact.model.js'
import { Conversation } from '../../../models/conversation.model.js'
import { ImportJob } from '../../../models/importJob.model.js'
import { Lead } from '../../../models/lead.model.js'
import { Mail } from '../../../models/mail.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { Session } from '../../../models/session.model.js'
import { MAIL_STATUS } from '../../../constants/mailStatus.js'

/** Mail that actually left. `replied` is terminal *after* sent, so it counts. */
const SENT_STATUSES = [MAIL_STATUS.SENT, MAIL_STATUS.REPLIED]

/** Outbound only — the inbox sync also writes to `Mail`, and that is not a send. */
const OUTBOUND_SENT = Object.freeze({ direction: 'outbound', status: { $in: SENT_STATUSES } })

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

// ---------------------------------------------------------------------------
// Per-user
// ---------------------------------------------------------------------------

/**
 * Everything the leaderboard needs, per user, for one window.
 *
 * Six aggregations rather than one: they run over six collections, and
 * `Promise.all` makes them concurrent. A single pipeline would need `$unionWith`
 * or `$lookup` across all six and would be both slower and unreadable.
 */
export async function userActivityMetrics(window = {}) {
  const [mail, replies, leads, campaigns, companies, contacts, lastSeen] = await Promise.all([
    Mail.aggregate([
      { $match: { ...OUTBOUND_SENT, ...within('createdAt', window) } },
      { $group: { _id: '$userId', emailsSent: { $sum: 1 } } },
    ]),

    /**
     * Replies, counted from the conversation's own counter.
     *
     * Summing `replyCount` over threads whose *last* incoming message falls in
     * the window is an approximation and worth naming: a thread answered twice,
     * once inside the window and once before it, contributes both. The exact
     * figure needs `ConversationMessage` grouped by owner, which is a far larger
     * scan. For a leaderboard the counter is the right trade, and the endpoint
     * labels the metric "reply threads" rather than "replies received".
     */
    Conversation.aggregate([
      {
        $match: {
          isDeleted: false,
          ...within('lastIncomingMessage.at', window),
        },
      },
      { $group: { _id: '$owner', replies: { $sum: '$replyCount' }, threads: { $sum: 1 } } },
    ]),

    Lead.aggregate([
      { $match: { isDeleted: false, ...within('createdAt', window) } },
      {
        $group: {
          _id: '$owner',
          leadsCreated: { $sum: 1 },
          won: { $sum: { $cond: [{ $in: ['$stage', ['booked', 'completed']] }, 1, 0] } },
        },
      },
    ]),

    Campaign.aggregate([
      { $match: within('createdAt', window) },
      { $group: { _id: '$owner', campaigns: { $sum: 1 } } },
    ]),

    Company.aggregate([
      { $match: { isDeleted: false, ...within('createdAt', window) } },
      { $group: { _id: '$owner', companiesAdded: { $sum: 1 } } },
    ]),

    Contact.aggregate([
      { $match: { isDeleted: false, ...within('createdAt', window) } },
      { $group: { _id: '$owner', contactsAdded: { $sum: 1 } } },
    ]),

    // Not windowed: "when were they last here" is a fact about now, and
    // restricting it to the window would report somebody as inactive purely
    // because the reader chose a short range.
    Session.aggregate([{ $group: { _id: '$user', lastActivityAt: { $max: '$lastUsedAt' } } }]),
  ])

  return {
    mail: toMap(mail),
    replies: toMap(replies),
    leads: toMap(leads),
    campaigns: toMap(campaigns),
    companies: toMap(companies),
    contacts: toMap(contacts),
    lastSeen: toMap(lastSeen),
  }
}

/**
 * One user's activity bucketed over time.
 *
 * Powers the daily/weekly/monthly/yearly charts on the 360 dashboard. Five
 * series, each a single-measure count — none of them shares an axis with
 * another, because two measures of different scale on one plot invent a
 * correlation the data does not contain.
 */
export async function userTrend({ userId, from, to, unit }) {
  const bucket = (dateField) => ({
    $dateTrunc: { date: `$${dateField}`, unit, startOfWeek: 'monday' },
  })

  const series = async (model, dateField, match) => {
    const rows = await model.aggregate([
      { $match: { ...match, [dateField]: { $gte: from, $lte: to } } },
      { $group: { _id: bucket(dateField), value: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])

    return new Map(rows.map((row) => [new Date(row._id).getTime(), row.value]))
  }

  const [emails, replies, leads, campaigns, companies, contacts] = await Promise.all([
    series(Mail, 'createdAt', { ...OUTBOUND_SENT, userId }),
    series(Conversation, 'lastIncomingMessage.at', { owner: userId, isDeleted: false }),
    series(Lead, 'createdAt', { owner: userId, isDeleted: false }),
    series(Campaign, 'createdAt', { owner: userId }),
    series(Company, 'createdAt', { owner: userId, isDeleted: false }),
    series(Contact, 'createdAt', { owner: userId, isDeleted: false }),
  ])

  return { emails, replies, leads, campaigns, companies, contacts }
}

// ---------------------------------------------------------------------------
// Per-mailbox
// ---------------------------------------------------------------------------

/**
 * Send volume, replies and the busiest user, per mailbox.
 *
 * `Mail.mailbox` is null for locally-composed messages that predate multi-
 * mailbox, so those rows group under `null` and are dropped by the caller
 * rather than attributed to an arbitrary mailbox.
 */
export async function mailboxActivityMetrics(window = {}) {
  const [sent, byUser, campaigns] = await Promise.all([
    Mail.aggregate([
      { $match: { ...OUTBOUND_SENT, mailbox: { $ne: null }, ...within('createdAt', window) } },
      {
        $group: {
          _id: '$mailbox',
          emailsSent: { $sum: 1 },
          lastSentAt: { $max: '$createdAt' },
        },
      },
    ]),

    // Who sends the most through each mailbox. Grouped by the pair, then reduced
    // to a single top user per mailbox in memory — the pair count is small.
    Mail.aggregate([
      { $match: { ...OUTBOUND_SENT, mailbox: { $ne: null }, ...within('createdAt', window) } },
      { $group: { _id: { mailbox: '$mailbox', user: '$userId' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    Campaign.aggregate([
      { $match: within('createdAt', window) },
      { $unwind: '$senderMailboxes' },
      { $group: { _id: '$senderMailboxes', campaigns: { $sum: 1 } } },
    ]),
  ])

  const topUser = new Map()
  for (const row of byUser) {
    const key = String(row._id.mailbox)
    // Rows arrive sorted by count descending, so the first per mailbox wins.
    if (!topUser.has(key) && row._id.user) {
      topUser.set(key, { userId: String(row._id.user), count: row.count })
    }
  }

  return { sent: toMap(sent), campaigns: toMap(campaigns), topUser }
}

/** Daily send volume for one mailbox, for its usage sparkline. */
export async function mailboxTrend({ mailboxId, from, to }) {
  const rows = await Mail.aggregate([
    { $match: { ...OUTBOUND_SENT, mailbox: mailboxId, createdAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { $dateTrunc: { date: '$createdAt', unit: 'day' } },
        value: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ])

  return new Map(rows.map((row) => [new Date(row._id).getTime(), row.value]))
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/**
 * The lead funnel and its movement.
 *
 * ## Stages are mapped, not invented
 *
 * The brief asks for New / Contacted / Qualified / Converted / Closed. The
 * register's own stages are different and are the truth, so each requested band
 * is a documented grouping of real stages rather than a new field. The response
 * carries the mapping so the console can show what a band contains.
 */
export const FUNNEL_BANDS = Object.freeze([
  { key: 'new', label: 'New', stages: ['new'] },
  { key: 'contacted', label: 'Contacted', stages: ['quoted', 'follow_up'] },
  { key: 'qualified', label: 'Qualified', stages: ['interested', 'negotiation', 'visa_process'] },
  { key: 'converted', label: 'Converted', stages: ['booked', 'completed'] },
  { key: 'closed', label: 'Closed', stages: ['cancelled', 'lost'] },
])

export async function leadFunnel(window = {}) {
  const [byStage, createdInWindow] = await Promise.all([
    Lead.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: '$stage', count: { $sum: 1 } } },
    ]),
    Lead.countDocuments({ isDeleted: false, ...within('createdAt', window) }),
  ])

  const counts = Object.fromEntries(byStage.map((row) => [row._id, row.count]))

  return {
    createdInWindow,
    bands: FUNNEL_BANDS.map((band) => ({
      key: band.key,
      label: band.label,
      stages: band.stages,
      value: band.stages.reduce((total, stage) => total + (counts[stage] ?? 0), 0),
    })),
    byStage: counts,
  }
}

// ---------------------------------------------------------------------------
// Organisation activity
// ---------------------------------------------------------------------------

/**
 * A timeline of things that actually happened.
 *
 * **Not an audit log** — audit is Phase 14.7 and is not implemented here. This
 * reads the business collections and reports the events they already record:
 * a lead was created, a campaign started, a workbook was imported, a customer
 * replied. Every entry is a real document with a real timestamp.
 *
 * Each source is limited before merging, so the cost is bounded by the limit
 * rather than by the collections.
 */
export async function organisationActivity({ from, to, limit = 40 }) {
  const range = from || to ? within('createdAt', { from, to }) : {}

  const [leads, campaigns, imports, replies] = await Promise.all([
    Lead.find({ isDeleted: false, ...range })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('reference contactPerson owner createdAt')
      .lean(),

    Campaign.find({ ...(from || to ? within('startedAt', { from, to }) : {}), startedAt: { $ne: null } })
      .sort({ startedAt: -1 })
      .limit(limit)
      .select('name owner startedAt completedAt status stats')
      .lean(),

    ImportJob.find(range)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('filename owner status createdAt syncSummary')
      .lean(),

    Conversation.find({
      isDeleted: false,
      'lastIncomingMessage.at': { $ne: null },
      ...(from || to ? within('lastIncomingMessage.at', { from, to }) : {}),
    })
      .sort({ 'lastIncomingMessage.at': -1 })
      .limit(limit)
      .select('subject counterpartyName owner lastIncomingMessage')
      .lean(),
  ])

  return { leads, campaigns, imports, replies }
}

// ---------------------------------------------------------------------------
// Executive counters
// ---------------------------------------------------------------------------

/**
 * People with a session touched recently.
 *
 * The closest honest answer to "who is online". `Session.lastUsedAt` is written
 * on every authenticated request, so somebody idle in a tab counts until their
 * session lapses — this is "recently active", not a websocket presence signal,
 * and the endpoint names it that way.
 */
export async function onlineUserCount(withinMinutes = 15) {
  const cutoff = new Date(Date.now() - withinMinutes * 60_000)

  const rows = await Session.aggregate([
    { $match: { lastUsedAt: { $gte: cutoff } } },
    { $group: { _id: '$user' } },
    { $count: 'total' },
  ])

  return { count: rows[0]?.total ?? 0, withinMinutes }
}

/** Counts confined to one window, for the executive cards. */
export async function windowCounters(window) {
  const [leads, emails, replies, imports] = await Promise.all([
    Lead.countDocuments({ isDeleted: false, ...within('createdAt', window) }),
    Mail.countDocuments({ ...OUTBOUND_SENT, ...within('createdAt', window) }),
    Conversation.countDocuments({
      isDeleted: false,
      ...within('lastIncomingMessage.at', window),
    }),
    ImportJob.countDocuments(within('createdAt', window)),
  ])

  return { leads, emails, replies, imports }
}

/** Mailbox connection split, for the executive cards. */
export async function mailboxSplit() {
  const rows = await Mailbox.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
  const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]))

  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    connected: byStatus.connected ?? 0,
    disconnected: (byStatus.disconnected ?? 0) + (byStatus.expired ?? 0) + (byStatus.error ?? 0),
    byStatus,
  }
}

export default {
  leadFunnel,
  mailboxActivityMetrics,
  mailboxSplit,
  mailboxTrend,
  onlineUserCount,
  organisationActivity,
  userActivityMetrics,
  userTrend,
  windowCounters,
}
