/**
 * Counting primitives for the admin console.
 *
 * ## Scope: the deployment, not one workspace
 *
 * Every count here is **deployment-wide**. That is a deliberate decision and it
 * needs stating, because the rest of this codebase is scoped by `owner`.
 *
 * The CRM has no organization entity. `owner` on `Lead`, `Campaign`,
 * `Conversation` and the rest is a `User` id, so "the workspace" is literally
 * one person — which is exactly the gap the Phase 14.0 architecture freeze
 * identified, and which Phase 14.3 closes by introducing `Organization` and a
 * `resolveWorkspace` middleware.
 *
 * Until then an admin dashboard has two options, and only one of them is
 * coherent:
 *
 *  - Scope every count to the caller. "Total users: 13" beside "total leads:
 *    412" would then be answering two different questions on one screen, and the
 *    second number would be wrong for its own label.
 *  - Count the whole deployment. Since this deployment serves exactly one
 *    business, "everything in this database" *is* "everything in the
 *    organization", and the numbers agree with their labels.
 *
 * This module takes the second. The consequence is honest and worth writing
 * down: **any authenticated user can read aggregate counts across the whole
 * business.** That is acceptable only because these endpoints are read-only,
 * return counts rather than records, and the brief for this phase explicitly
 * defers role enforcement to Phase 14.4. When `resolveWorkspace` lands, every
 * function here takes a scope filter and the decision reverses cleanly — which
 * is why they all already build their filters through one helper.
 *
 * ## Nothing here writes
 *
 * Every export is a read. No `create`, no `update`, no `delete`, no index
 * change, no schema touched. The models are imported for their compiled
 * schemas only.
 */

import { Campaign } from '../../../models/campaign.model.js'
import { Company } from '../../../models/company.model.js'
import { Contact } from '../../../models/contact.model.js'
import { Conversation } from '../../../models/conversation.model.js'
import { ImportJob } from '../../../models/importJob.model.js'
import { Lead } from '../../../models/lead.model.js'
import { Mail } from '../../../models/mail.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { Notification } from '../../../models/notification.model.js'
import { User } from '../../../models/user.model.js'
import { MAIL_STATUS } from '../../../constants/mailStatus.js'
import { CAMPAIGN_STATUS } from '../../campaigns/constants/campaignConstants.js'
import { IMPORT_STATUS } from '../../import/constants/importConstants.js'
import { CONNECTION_STATUS } from '../../provider/constants/providerTypes.js'
import { ACTIVE_USER_WINDOW_DAYS } from '../constants/adminConstants.js'

/**
 * Soft-delete filter.
 *
 * Applied to every business collection that has the field. Counting deleted
 * rows would make the admin dashboard disagree with the CRM screens the same
 * user was looking at a moment ago, which reads as a bug in whichever they
 * checked second.
 */
const LIVE = Object.freeze({ isDeleted: false })

/** Midnight today, UTC — the boundary the CRM dashboard already uses for "today". */
export function startOfToday() {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  return date
}

/** `days` before now. */
export function daysAgo(days) {
  return new Date(Date.now() - days * 86_400_000)
}

/**
 * Groups a collection by one field and returns a plain count map.
 *
 * Used wherever a screen needs several counts off the same field — campaign
 * statuses, lead stages, import outcomes. One aggregation returns all of them,
 * where one `countDocuments` per value would be one round trip per value.
 *
 * @param {import('mongoose').Model} model
 * @param {string} field
 * @param {object} [match]
 * @returns {Promise<Record<string, number>>}
 */
async function countByField(model, field, match = {}) {
  const rows = await model.aggregate([
    { $match: match },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ])

  return Object.fromEntries(rows.map((row) => [row._id ?? 'unknown', row.count]))
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * User counts.
 *
 * "Active" means *signed in recently*, not `isActive: true`. The two are easily
 * confused and mean different things: `isActive` is an administrative flag
 * nobody has ever set in this deployment — it defaults true and no code path
 * writes it — so counting it would report every account as active and tell an
 * operator nothing. Recency is the question a dashboard is actually asked.
 */
export async function userCounts() {
  const [total, activeRecently, suspended, deleted] = await Promise.all([
    User.countDocuments({ isDeleted: { $ne: true } }),
    User.countDocuments({
      isDeleted: { $ne: true },
      lastLoginAt: { $gte: daysAgo(ACTIVE_USER_WINDOW_DAYS) },
    }),
    User.countDocuments({ isDeleted: { $ne: true }, isActive: false }),
    User.countDocuments({ isDeleted: true }),
  ])

  return { total, active: activeRecently, suspended, deleted, activeWindowDays: ACTIVE_USER_WINDOW_DAYS }
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

/** Mailbox counts by connection state, plus how many the reply sync reads. */
export async function mailboxCounts() {
  const [byStatus, total, syncEnabled] = await Promise.all([
    countByField(Mailbox, 'status'),
    Mailbox.countDocuments({}),
    Mailbox.countDocuments({ syncEnabled: { $ne: false } }),
  ])

  return {
    total,
    connected: byStatus[CONNECTION_STATUS.CONNECTED] ?? 0,
    disconnected: byStatus[CONNECTION_STATUS.DISCONNECTED] ?? 0,
    error: byStatus[CONNECTION_STATUS.ERROR] ?? 0,
    syncEnabled,
    byStatus,
  }
}

// ---------------------------------------------------------------------------
// Sales register
// ---------------------------------------------------------------------------

/** Lead totals, today's intake, stage breakdown and the two attention counts. */
export async function leadCounts() {
  const [total, today, byStage, unassignedCompany, stale] = await Promise.all([
    Lead.countDocuments(LIVE),
    Lead.countDocuments({ ...LIVE, createdAt: { $gte: startOfToday() } }),
    countByField(Lead, 'stage', LIVE),
    Lead.countDocuments({ ...LIVE, company: null }),
    Lead.countDocuments({ ...LIVE, updatedAt: { $lt: daysAgo(30) } }),
  ])

  return { total, today, byStage, unassignedCompany, stale }
}

/** Company and contact totals. */
export async function directoryCounts() {
  const [companies, contacts] = await Promise.all([
    Company.countDocuments(LIVE),
    Contact.countDocuments(LIVE),
  ])

  return { companies, contacts }
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

/** Campaign totals by lifecycle state. */
export async function campaignCounts() {
  const [byStatus, total] = await Promise.all([
    countByField(Campaign, 'status'),
    Campaign.countDocuments({}),
  ])

  return {
    total,
    draft: byStatus[CAMPAIGN_STATUS.DRAFT] ?? 0,
    scheduled: byStatus[CAMPAIGN_STATUS.SCHEDULED] ?? 0,
    running: byStatus[CAMPAIGN_STATUS.RUNNING] ?? 0,
    paused: byStatus[CAMPAIGN_STATUS.PAUSED] ?? 0,
    completed: byStatus[CAMPAIGN_STATUS.COMPLETED] ?? 0,
    cancelled: byStatus[CAMPAIGN_STATUS.CANCELLED] ?? 0,
    byStatus,
  }
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/**
 * Outbound mail counts.
 *
 * Restricted to `direction: 'outbound'` throughout. The `Mail` collection also
 * holds messages the provider sync pulled *in*, and counting those as "emails
 * sent" would inflate the figure by however much inbox history has been
 * synchronised — which has nothing to do with what this CRM despatched.
 *
 * `replied` is counted as sent as well as replied, because it is a terminal
 * state reached only by having been sent first. Excluding it would make the
 * total fall every time a customer answered.
 */
export async function mailCounts() {
  const outbound = { direction: 'outbound' }
  const sentStatuses = { $in: [MAIL_STATUS.SENT, MAIL_STATUS.REPLIED] }

  const [sent, sentToday, pending, failed, drafts, replied] = await Promise.all([
    Mail.countDocuments({ ...outbound, status: sentStatuses }),
    Mail.countDocuments({ ...outbound, status: sentStatuses, createdAt: { $gte: startOfToday() } }),
    Mail.countDocuments({ ...outbound, status: MAIL_STATUS.PENDING }),
    Mail.countDocuments({ ...outbound, status: MAIL_STATUS.FAILED }),
    Mail.countDocuments({ ...outbound, status: MAIL_STATUS.DRAFT }),
    Mail.countDocuments({ ...outbound, status: MAIL_STATUS.REPLIED }),
  ])

  const attempted = sent + failed
  const successRate = attempted === 0 ? null : Number(((sent / attempted) * 100).toFixed(1))

  return { sent, sentToday, pending, failed, drafts, replied, successRate }
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/**
 * Conversation totals.
 *
 * Reply and unread counts are summed from the counters the conversation module
 * already maintains on each thread, rather than recounted from
 * `ConversationMessage`. The counters are what the CRM's own screens display,
 * so summing them keeps the two surfaces in agreement; recounting could
 * disagree with the CRM and there would be no way to tell which was right.
 */
export async function conversationCounts() {
  const [totals] = await Conversation.aggregate([
    { $match: LIVE },
    {
      $group: {
        _id: null,
        threads: { $sum: 1 },
        replies: { $sum: '$replyCount' },
        unread: { $sum: '$unreadCount' },
        messages: { $sum: '$messageCount' },
        respondedThreads: {
          $sum: { $cond: [{ $ne: ['$firstResponseMs', null] }, 1, 0] },
        },
        totalFirstResponseMs: { $sum: { $ifNull: ['$firstResponseMs', 0] } },
      },
    },
  ])

  const [openThreads, repliedToday] = await Promise.all([
    Conversation.countDocuments({ ...LIVE, status: { $in: ['open', 'awaiting_us'] } }),
    Conversation.countDocuments({ ...LIVE, 'lastIncomingMessage.at': { $gte: startOfToday() } }),
  ])

  const averageFirstResponseMs =
    totals?.respondedThreads > 0
      ? Math.round(totals.totalFirstResponseMs / totals.respondedThreads)
      : null

  return {
    threads: totals?.threads ?? 0,
    replies: totals?.replies ?? 0,
    unread: totals?.unread ?? 0,
    messages: totals?.messages ?? 0,
    openThreads,
    repliedToday,
    averageFirstResponseMs,
  }
}

// ---------------------------------------------------------------------------
// Workbook imports
// ---------------------------------------------------------------------------

/**
 * Import job counts, and the queue depth the workbook worker is draining.
 *
 * `queued` and `running` come from the same collection the worker claims jobs
 * from, so this is the real queue rather than a separate view of it.
 */
export async function importCounts() {
  const [byStatus, total, today] = await Promise.all([
    countByField(ImportJob, 'status'),
    ImportJob.countDocuments({}),
    ImportJob.countDocuments({ createdAt: { $gte: startOfToday() } }),
  ])

  return {
    total,
    today,
    queued: byStatus[IMPORT_STATUS.QUEUED] ?? 0,
    running: byStatus[IMPORT_STATUS.RUNNING] ?? 0,
    completed: byStatus[IMPORT_STATUS.COMPLETED] ?? 0,
    partial: byStatus[IMPORT_STATUS.PARTIAL] ?? 0,
    failed: byStatus[IMPORT_STATUS.FAILED] ?? 0,
    cancelled: byStatus[IMPORT_STATUS.CANCELLED] ?? 0,
    byStatus,
  }
}

/** The most recent import, for the dashboard's "last run" line. */
export function latestImportJob() {
  return ImportJob.findOne({})
    .sort({ createdAt: -1 })
    .select('filename status createdAt durationMs syncSummary owner')
    .lean()
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Unread notification count across the deployment. */
export async function notificationCounts() {
  const [total, unread] = await Promise.all([
    Notification.countDocuments({}),
    Notification.countDocuments({ isRead: false }),
  ])

  return { total, unread }
}

export default {
  campaignCounts,
  conversationCounts,
  directoryCounts,
  importCounts,
  latestImportJob,
  leadCounts,
  mailCounts,
  mailboxCounts,
  notificationCounts,
  userCounts,
}
