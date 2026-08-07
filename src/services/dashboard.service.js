/**
 * Dashboard service.
 *
 * Composes the single payload the dashboard needs on load. Deliberately one
 * endpoint rather than three parallel requests: it removes a render pass where
 * some cards have data and others do not, and it guarantees every card describes
 * the same instant in time.
 */

import { config } from '../config/index.js'
import { buildAccountProfile } from './account.service.js'
import { getMailStatistics } from './mail.service.js'
import {
  getAuthenticationStatus,
  getBackendStatus,
  getConnectionStatus,
  getDatabaseHealth,
} from './status.service.js'

/** The shape used when mail statistics cannot be read — see `buildDashboard`. */
const EMPTY_MAIL_STATS = Object.freeze({
  totalSent: 0,
  totalFailed: 0,
  totalPending: 0,
  totalDrafts: 0,
  totalMessages: 0,
  successRate: null,
  recent: [],
  unavailable: true,
})

/**
 * Builds the dashboard payload.
 *
 * The Graph probe is **not** performed here. It costs a network round trip, and
 * the dashboard should paint immediately; `/account/status` owns the live probe
 * and the UI fills that card in a moment later.
 *
 * @param {object} auth `req.auth`
 * @returns {object}
 */
export async function buildDashboard(auth) {
  const profile = await buildAccountProfile(auth)
  const connection = getConnectionStatus(auth.outlookAccount)

  // Unlike the Graph probe, this is a local aggregation — one indexed query, so
  // it is fast enough to block first paint on and the counters are correct
  // immediately rather than popping in afterwards.
  //
  // A failure here degrades to zeroes instead of failing the whole dashboard:
  // the connection and system cards are still worth rendering if the mail
  // collection is briefly unreadable.
  let mail = EMPTY_MAIL_STATS
  if (auth.user) {
    try {
      mail = await getMailStatistics(auth.user._id)
    } catch {
      mail = EMPTY_MAIL_STATS
    }
  }

  /**
   * The travel sales widgets.
   *
   * Degrades to nulls rather than failing the dashboard, for the same reason as
   * the mail counters above: the connection and system cards are still worth
   * rendering when one collection is briefly unreadable. `null` rather than
   * zeroes, so the UI can distinguish "no leads" from "could not be read".
   */
  let sales = null
  if (auth.user) {
    try {
      const { leadStatistics } = await import('../modules/leads/services/lead.service.js')
      sales = await leadStatistics({ owner: auth.user._id })
    } catch {
      sales = null
    }
  }

  /**
   * Reply-CRM widgets.
   *
   * Degrades to null for the same reason as the others: one unreadable
   * collection should not blank a dashboard whose other cards are fine.
   */
  let conversations = null
  if (auth.user) {
    try {
      const { conversationStatistics } = await import(
        '../modules/conversations/services/conversation.service.js'
      )
      conversations = await conversationStatistics({ owner: auth.user._id, userId: auth.user._id })
    } catch {
      conversations = null
    }
  }

  /**
   * The morning workbook widgets.
   *
   * Degrades to null like the others: an unreadable collection should not blank
   * a dashboard whose remaining cards are fine.
   */
  let workbook = null
  if (auth.user) {
    try {
      const { ImportJob } = await import('../models/importJob.model.js')
      const { Lead } = await import('../models/lead.model.js')
      const { pendingIntroductions } = await import(
        '../modules/leads/services/workbookSync.service.js'
      )

      const startOfToday = new Date()
      startOfToday.setUTCHours(0, 0, 0, 0)

      const [lastJob, todaysJobs, pending, emailedToday] = await Promise.all([
        ImportJob.findOne({ owner: auth.user._id }).sort({ createdAt: -1 }),
        ImportJob.find({ owner: auth.user._id, createdAt: { $gte: startOfToday } }),
        pendingIntroductions({ owner: auth.user._id }),
        Lead.countDocuments({
          owner: auth.user._id,
          isDeleted: false,
          'autoMail.sentAt': { $gte: startOfToday },
        }),
      ])

      workbook = {
        todaysWorkbook: todaysJobs[0]?.filename ?? null,
        lastUpload: lastJob
          ? { filename: lastJob.filename, at: lastJob.createdAt, status: lastJob.status }
          : null,
        newLeadsToday: todaysJobs.reduce((sum, job) => sum + (job.syncSummary?.new ?? 0), 0),
        updatedLeadsToday: todaysJobs.reduce((sum, job) => sum + (job.syncSummary?.updated ?? 0), 0),
        emailsSentToday: emailedToday,
        pendingEmails: pending,
        lastImportDurationMs: lastJob?.durationMs ?? null,
      }
    } catch {
      workbook = null
    }
  }

  /**
   * The morning scheduler card.
   *
   * Read here rather than fetched separately because it is three values — last
   * run, next run, last status — and a second request for three values would
   * cost more than it saves. Degrades to null like every block above it.
   *
   * Deliberately a read, never a create: `buildDashboard` runs on every page
   * load for every user, and creating a settings document as a side effect of
   * looking at a dashboard would seed one for members who can never use it.
   * `GET /scheduler` and the boot-time seed own creation.
   */
  let scheduler = null
  if (auth.user) {
    try {
      const { SchedulerSetting } = await import('../models/schedulerSetting.model.js')
      const setting = await SchedulerSetting.findOne({ owner: auth.user._id })

      if (setting) {
        const view = setting.toPublicJSON()

        scheduler = {
          enabled: view.enabled,
          runTime: view.runTime,
          timezone: view.timezone,
          sendMail: view.sendMail,
          nextRunAt: view.nextRunAt,
          lastRunAt: view.lastRun.at,
          lastStatus: view.lastRun.status,
          lastStatusLabel: view.lastRun.statusLabel,
          lastReason: view.lastRun.reason,
          lastMessage: view.lastRun.message,
          lastWorkbook: view.lastRun.workbook,
          lastImportJob: view.lastRun.importJob,
        }
      }
    } catch {
      scheduler = null
    }
  }

  return {
    user: profile.user,

    /** Send counters and the five most recent messages. */
    mail,

    /** Companies, contacts, pipeline counts and campaign-ready leads. */
    sales,

    /** Today's workbook, new leads, emails sent, emails still owed. */
    workbook,

    /** Last scheduled run, next scheduled run, and how the last one ended. */
    scheduler,

    /** Unread replies, response times, follow-ups due, open threads. */
    conversations,

    connection,

    /** The Outlook mailbox card. */
    outlookAccount: profile.microsoftAccount,

    authentication: getAuthenticationStatus(auth.session),

    server: {
      backend: getBackendStatus(),
      database: getDatabaseHealth(),
      // Reported without probing so the dashboard is not blocked on Microsoft.
      // The client refines this from /account/status.
      graph: {
        status: 'unknown',
        checkedAt: null,
        latencyMs: null,
        detail: 'Awaiting live check.',
      },
      microsoftAuthConfigured: config.microsoft.enabled,
    },

    meta: {
      /** Permissions this deployment requests, shown for transparency. */
      scopesRequested: config.microsoft.scopes,
      generatedAt: new Date().toISOString(),
    },
  }
}

export default { buildDashboard }
