/**
 * Time-bucketed aggregation for `/admin/analytics`.
 *
 * ## No snapshot table, by instruction and by consequence
 *
 * The Phase 14.0 design proposed a `MetricSnapshot` collection. This phase
 * deliberately does not build it: the brief forbids duplicated metrics, and a
 * snapshot table is a second copy of numbers that already exist. Everything
 * below is computed from the live collections on each request.
 *
 * That has a real cost and it is bounded on purpose rather than hoped about:
 *
 *  - **Buckets are capped** (`ANALYTICS_MAX_BUCKETS`), so a caller cannot ask
 *    for ten years of days.
 *  - **Every pipeline starts with a `$match` on an indexed date field**, so the
 *    scan is bounded by the window rather than by the collection.
 *  - **The `$group` emits one document per bucket**, not per row, so the memory
 *    the pipeline holds is the size of the answer.
 *
 * At this deployment's volume that is comfortably fast. It will stop being
 * comfortable somewhere past the 100-user mark in the Phase 14.0 scalability
 * analysis, and the snapshot table is the answer then — not now.
 *
 * ## Why `$dateTrunc`
 *
 * `$dateTrunc` (MongoDB 5.0+, and this deploys against 7) buckets by a real
 * calendar unit with a timezone, so a "week" is a week where the business is
 * rather than a 168-hour window from an arbitrary epoch. The `$dateToString`
 * alternative returns strings, which sort lexicographically rather than
 * chronologically once the format changes, and cannot express weeks at all.
 */

import { Campaign } from '../../../models/campaign.model.js'
import { Conversation } from '../../../models/conversation.model.js'
import { Lead } from '../../../models/lead.model.js'
import { Mail } from '../../../models/mail.model.js'
import { MAIL_STATUS } from '../../../constants/mailStatus.js'
import { TERMINAL_STAGES, WON_STAGES } from '../../leads/constants/leadConstants.js'
import { ANALYTICS_GRANULARITY } from '../constants/adminConstants.js'

/** Milliseconds per bucket unit, for building the empty scaffold. */
const UNIT_MS = Object.freeze({
  [ANALYTICS_GRANULARITY.DAY]: 86_400_000,
  [ANALYTICS_GRANULARITY.WEEK]: 604_800_000,
  // Months vary in length, so month buckets are stepped by calendar arithmetic
  // rather than by this constant. Present so the map is total.
  [ANALYTICS_GRANULARITY.MONTH]: null,
})

/**
 * Truncates a date to the start of its bucket, in UTC.
 *
 * Mirrors what `$dateTrunc` does server-side. The scaffold and the aggregation
 * must agree on bucket boundaries exactly, or a bucket with data lands beside an
 * empty scaffold bucket and the chart shows two points where there is one.
 */
function truncate(date, granularity) {
  const value = new Date(date)
  value.setUTCHours(0, 0, 0, 0)

  if (granularity === ANALYTICS_GRANULARITY.MONTH) {
    value.setUTCDate(1)
    return value
  }

  if (granularity === ANALYTICS_GRANULARITY.WEEK) {
    // Monday-start, matching `$dateTrunc`'s default `startOfWeek`. `getUTCDay()`
    // returns 0 for Sunday, which is six days into a Monday-start week.
    const day = value.getUTCDay()
    const offset = day === 0 ? 6 : day - 1
    value.setUTCDate(value.getUTCDate() - offset)
    return value
  }

  return value
}

/** The next bucket boundary after `date`. */
function step(date, granularity) {
  const value = new Date(date)

  if (granularity === ANALYTICS_GRANULARITY.MONTH) {
    value.setUTCMonth(value.getUTCMonth() + 1)
    return value
  }

  return new Date(value.getTime() + UNIT_MS[granularity])
}

/**
 * Every bucket boundary in `[from, to]`, including the empty ones.
 *
 * The scaffold is what stops a quiet Sunday from disappearing off the chart.
 * An aggregation returns only buckets that matched something, so plotting its
 * output directly draws a line straight from Saturday to Monday and silently
 * misstates the shape of the week.
 */
function scaffold(from, to, granularity) {
  const buckets = []
  let cursor = truncate(from, granularity)
  const end = truncate(to, granularity)

  while (cursor <= end) {
    buckets.push(new Date(cursor))
    cursor = step(cursor, granularity)
  }

  return buckets
}

/**
 * Runs one bucketed count and returns a gap-filled series.
 *
 * @param {object}  options
 * @param {import('mongoose').Model} options.model
 * @param {string}  options.dateField  Must be indexed — it carries the `$match`.
 * @param {Date}    options.from
 * @param {Date}    options.to
 * @param {string}  options.granularity
 * @param {object}  [options.match]    Extra filter, ANDed with the date window.
 * @returns {Promise<Array<{ periodStart: string, label: string, value: number }>>}
 */
async function bucketedCount({ model, dateField, from, to, granularity, match = {} }) {
  const rows = await model.aggregate([
    {
      $match: {
        ...match,
        [dateField]: { $gte: from, $lte: to },
      },
    },
    {
      $group: {
        _id: { $dateTrunc: { date: `$${dateField}`, unit: granularity, startOfWeek: 'monday' } },
        value: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ])

  // Keyed by epoch millis rather than by ISO string: two dates that are the same
  // instant always share a number, where their string forms can differ by
  // millisecond precision and silently fail to join.
  const byBucket = new Map(rows.map((row) => [new Date(row._id).getTime(), row.value]))

  return scaffold(from, to, granularity).map((periodStart) => ({
    periodStart: periodStart.toISOString(),
    label: formatLabel(periodStart, granularity),
    value: byBucket.get(periodStart.getTime()) ?? 0,
  }))
}

/** Short axis label. Kept server-side so every client renders the same words. */
function formatLabel(date, granularity) {
  if (granularity === ANALYTICS_GRANULARITY.MONTH) {
    return date.toLocaleDateString('en-AU', { month: 'short', year: '2-digit', timeZone: 'UTC' })
  }

  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/**
 * The four growth series the analytics screen plots.
 *
 * Each is a **single measure**. None of them shares an axis with another: two
 * measures of different scale on one plot align two scales arbitrarily and
 * invent a correlation that is not in the data.
 *
 * `Promise.all` rather than sequential awaits — four independent aggregations
 * against four collections have no reason to queue behind each other.
 */
export async function growthSeries({ from, to, granularity }) {
  const [leads, mail, campaigns, replies] = await Promise.all([
    bucketedCount({
      model: Lead,
      dateField: 'createdAt',
      from,
      to,
      granularity,
      match: { isDeleted: false },
    }),
    bucketedCount({
      model: Mail,
      dateField: 'createdAt',
      from,
      to,
      granularity,
      // Outbound only, and only what actually left: a failed send is not
      // "mail growth", and an inbound synced message was never ours to send.
      match: { direction: 'outbound', status: { $in: [MAIL_STATUS.SENT, MAIL_STATUS.REPLIED] } },
    }),
    bucketedCount({
      model: Campaign,
      dateField: 'createdAt',
      from,
      to,
      granularity,
    }),
    bucketedCount({
      model: Conversation,
      // The moment a customer last answered, not when the thread was opened.
      // Bucketing a reply by its thread's creation date would credit today's
      // replies to whenever the conversation started.
      dateField: 'lastIncomingMessage.at',
      from,
      to,
      granularity,
      match: { isDeleted: false },
    }),
  ])

  return { leads, mail, campaigns, replies }
}

/**
 * Lead counts per pipeline stage, in the register's own stage order.
 *
 * Ordered categories, so the client renders them with one colour. A ramp across
 * the bars would double-encode length as hue.
 */
export async function pipelineBreakdown() {
  const rows = await Lead.aggregate([
    { $match: { isDeleted: false } },
    { $group: { _id: '$stage', value: { $sum: 1 } } },
  ])

  return new Map(rows.map((row) => [row._id, row.value]))
}

/**
 * Per-owner totals, for the consultant table.
 *
 * `$lookup` into `users` rather than a second round trip per owner: the owner
 * set is small (one document per CRM account) and joining server-side keeps the
 * response to one request.
 */
export async function leadsByOwner({ limit = 20 } = {}) {
  return Lead.aggregate([
    { $match: { isDeleted: false } },
    {
      $group: {
        _id: '$owner',
        leads: { $sum: 1 },
        /**
         * Read from the shared constants rather than hardcoded stage strings,
         * which counted zero the moment the vocabulary changed.
         *
         * `lost` now means "concluded without a confirmed booking". The four
         * stages cannot express won-versus-lost among closed enquiries — see
         * WON_STAGES — so this is the closest honest reading, and the two sets
         * no longer overlap.
         */
        won: { $sum: { $cond: [{ $in: ['$stage', [...WON_STAGES]] }, 1, 0] } },
        lost: { $sum: { $cond: [{ $in: ['$stage', [...TERMINAL_STAGES]] }, 1, 0] } },
        emailed: { $sum: { $cond: [{ $eq: ['$autoMail.status', 'sent'] }, 1, 0] } },
      },
    },
    { $sort: { leads: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
        pipeline: [{ $project: { displayName: 1, email: 1, role: 1 } }],
      },
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
  ])
}

export default { growthSeries, leadsByOwner, pipelineBreakdown }
