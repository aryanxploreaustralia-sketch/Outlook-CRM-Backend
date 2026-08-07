/**
 * The admin dashboard payload.
 *
 * One endpoint rather than nine parallel requests, for the reason the CRM's own
 * dashboard service gives: it removes the render pass where some cards have data
 * and others do not, and it guarantees every figure on the screen describes the
 * same instant.
 *
 * ## Degradation
 *
 * Each block is resolved independently and falls back to `null` on failure,
 * mirroring `services/dashboard.service.js`. `null` rather than zeroes, so the
 * console can distinguish "there are no campaigns" from "the campaign counts
 * could not be read" — two very different things to show an operator, and a
 * zero that means the second is actively misleading.
 *
 * A single unreadable collection therefore costs one card, not the page.
 */

import { SchedulerSetting } from '../../../models/schedulerSetting.model.js'
import { isWorkerBusy } from '../../../jobs/workbookQueue.service.js'
import { isSchedulerBusy } from '../../scheduler/services/scheduler.service.js'
import { isReplySyncBusy } from '../../scheduler/services/replySyncScheduler.service.js'
import { createContextLogger } from '../../../utils/logger.js'
import * as analytics from '../repositories/adminAnalytics.repository.js'
import * as stats from '../repositories/adminStats.repository.js'

const log = createContextLogger('admin-dashboard')

/**
 * Resolves a block, or logs and yields null.
 *
 * Swallowing the error silently would make a persistently broken block look like
 * an empty one forever, so the failure is logged once with its block name.
 */
async function block(name, loader) {
  try {
    return await loader()
  } catch (error) {
    log.warn(`Admin dashboard block "${name}" could not be read`, { message: error.message })
    return null
  }
}

/**
 * The scheduler card.
 *
 * Reads the **primary** workspace's settings — the one `electPrimaryWorkspace()`
 * chose at boot. That is deliberate and is the only correct answer: exactly one
 * scheduler owns the morning run for the whole deployment, and reporting the
 * caller's own settings would show a member a scheduler that never fires.
 *
 * Deliberately a read and never a create. `ensureSettings()` exists and would
 * seed a document, and calling it here would create scheduler settings as a side
 * effect of somebody opening a dashboard.
 */
async function schedulerBlock() {
  const setting = await SchedulerSetting.findOne({ isPrimary: true })

  if (!setting) {
    return {
      configured: false,
      enabled: false,
      message: 'No scheduling workspace has been elected yet.',
    }
  }

  const view = setting.toPublicJSON()

  return {
    configured: true,
    enabled: view.enabled,
    runTime: view.runTime,
    timezone: view.timezone,
    sendMail: view.sendMail,
    nextRunAt: view.nextRunAt,
    lastRunAt: view.lastRun?.at ?? null,
    lastStatus: view.lastRun?.status ?? null,
    lastStatusLabel: view.lastRun?.statusLabel ?? null,
    lastMessage: view.lastRun?.message ?? null,
    replySync: {
      enabled: view.replySync?.enabled ?? false,
      intervalMinutes: view.replySync?.intervalMinutes ?? null,
      lastRunAt: view.replySync?.lastRunAt ?? null,
      status: view.replySync?.status ?? null,
    },
  }
}

/**
 * Builds the dashboard.
 *
 * @param {object} auth `req.auth` — carried for the identity block only. Every
 *   count below is deployment-wide; see the note in `adminStats.repository.js`.
 * @param {{ from?: Date, to?: Date, preset?: string }} [range] The reporting
 *   period. Only the `period` block below respects it — the rest are standing
 *   totals ("how many mailboxes are connected"), which a date filter would make
 *   meaningless rather than more precise.
 * @returns {Promise<object>}
 */
export async function buildAdminDashboard(auth, range = {}) {
  const [
    users,
    mailboxes,
    leads,
    directory,
    campaigns,
    mail,
    conversations,
    imports,
    notifications,
    scheduler,
    lastImport,
  ] = await Promise.all([
    block('users', stats.userCounts),
    block('mailboxes', stats.mailboxCounts),
    block('leads', stats.leadCounts),
    block('directory', stats.directoryCounts),
    block('campaigns', stats.campaignCounts),
    block('mail', stats.mailCounts),
    block('conversations', stats.conversationCounts),
    block('imports', stats.importCounts),
    block('notifications', stats.notificationCounts),
    block('scheduler', schedulerBlock),
    block('lastImport', stats.latestImportJob),
  ])

  /**
   * The period-scoped block, and presence.
   *
   * Separate from the totals above because these two answer different
   * questions. "5 mailboxes" is true regardless of the date filter; "80 emails
   * sent" is only true of a stated period, and a card showing one next to the
   * other without saying which is which is how an executive dashboard starts
   * lying quietly.
   *
   * `online` is a real count of sessions used in the last 15 minutes, not an
   * estimate: the CRM already writes `lastUsedAt` on every authenticated
   * request, so the figure is observed rather than inferred.
   */
  const [period, online, mailboxHealth] = await Promise.all([
    block('period', () => analytics.windowCounters({ from: range.from, to: range.to })),
    block('online', () => analytics.onlineUserCount(15)),
    block('mailboxHealth', analytics.mailboxSplit),
  ])

  return {
    users,
    mailboxes,
    leads,
    companies: directory ? directory.companies : null,
    contacts: directory ? directory.contacts : null,
    campaigns,
    mail,
    conversations,
    imports,
    notifications,
    scheduler,

    /** Counts confined to the requested period. Null if unreadable. */
    period: period
      ? {
          ...period,
          from: range.from?.toISOString() ?? null,
          to: range.to?.toISOString() ?? null,
          preset: range.preset ?? null,
        }
      : null,

    /** Distinct users with a session touched in the last 15 minutes. */
    online,

    /** Connected against disconnected, for the health card. */
    mailboxHealth,

    lastImport: lastImport
      ? {
          filename: lastImport.filename,
          status: lastImport.status,
          at: lastImport.createdAt,
          durationMs: lastImport.durationMs ?? null,
          summary: lastImport.syncSummary ?? null,
        }
      : null,

    /**
     * Live worker state.
     *
     * Read from the same busy flags the graceful-shutdown drain reads, so this
     * is the actual state of the workers in this process — not a database row
     * describing what they were doing last time they wrote one.
     *
     * Worth knowing when reading it: these flags are **per process**. The API
     * runs as a single instance today, so they describe the whole deployment.
     * The moment it runs as more than one, they describe whichever instance
     * answered the request — which is one of several reasons the Phase 14.0
     * scalability analysis puts worker extraction ahead of horizontal scaling.
     */
    workers: {
      workbook: { busy: isWorkerBusy() },
      scheduler: { busy: isSchedulerBusy() },
      replySync: { busy: isReplySyncBusy() },
    },

    meta: {
      /** Named so the console can state where these figures come from. */
      source: 'live',
      scope: 'deployment',
      generatedAt: new Date().toISOString(),
      viewer: auth?.user ? { id: String(auth.user._id), role: auth.user.role ?? null } : null,
    },
  }
}

export default { buildAdminDashboard }
