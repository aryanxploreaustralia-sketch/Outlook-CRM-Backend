/**
 * Deep health probes.
 *
 * ## Why this is not `/api/v1/health`
 *
 * The public health endpoint stays exactly as it is: a database check, no
 * authentication, no network calls, answered in under ten milliseconds. A load
 * balancer polls it every few seconds, and adding a Microsoft Graph round trip
 * to it would make an outage *at Microsoft* look like an outage in this
 * application and pull a healthy service out of rotation.
 *
 * These probes are the expensive ones. They sit behind `requireAuth`, on their
 * own endpoint, and nothing polls them but an operator with the screen open.
 *
 * ## Configuration checks, not liveness calls
 *
 * The Microsoft and Google entries report whether the integration is *configured
 * and being used successfully*, inferred from recorded sync outcomes and recent
 * sign-ins. They do not call Microsoft or Google.
 *
 * That is a deliberate limit of this phase and it is labelled as such in the
 * response. An outbound probe to Graph is a write to nothing but is still a call
 * into the mailbox engine's client, with its own retry and throttle behaviour,
 * and the brief for this phase is read-only and hands-off. Inference from
 * `SyncHistory` is weaker, honest, and free — and it is the same evidence an
 * engineer would look at first anyway.
 */

import { readdir, statfs } from 'node:fs/promises'

import { getDatabaseStatus } from '../../../config/database.js'
import { config } from '../../../config/index.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { SchedulerSetting } from '../../../models/schedulerSetting.model.js'
import { SyncHistory } from '../../../models/syncHistory.model.js'
import { User } from '../../../models/user.model.js'
import { ImportJob } from '../../../models/importJob.model.js'
import { isWorkerBusy } from '../../../jobs/workbookQueue.service.js'
import { isSchedulerBusy } from '../../scheduler/services/scheduler.service.js'
import { isReplySyncBusy } from '../../scheduler/services/replySyncScheduler.service.js'
import { AUTH_PROVIDERS } from '../../../models/user.model.js'
import { IMPORT_STATUS } from '../../import/constants/importConstants.js'
import { SYNC_STATUS } from '../../provider/constants/syncStatus.js'
import { HEALTH_SEVERITY, HEALTH_STATE, HEALTH_STATE_LABELS } from '../constants/adminConstants.js'
import { healthComponentDTO } from '../dto/admin.dto.js'

/** Formats a duration as the coarse phrase an operator actually reads. */
function ago(date) {
  if (!date) return 'never'

  const seconds = Math.round((Date.now() - new Date(date).getTime()) / 1000)

  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`

  return `${Math.floor(seconds / 86_400)}d ago`
}

/** A probe that threw is reported as unknown, never as healthy. */
async function probe(id, name, group, runner) {
  try {
    return await runner()
  } catch (error) {
    return healthComponentDTO({
      id,
      name,
      group,
      state: HEALTH_STATE.UNKNOWN,
      detail: `This probe could not run: ${error.message}`,
      metrics: [],
    })
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

function probeDatabase() {
  const database = getDatabaseStatus()

  return healthComponentDTO({
    id: 'mongodb',
    name: 'MongoDB',
    group: 'Data',
    state: database.healthy ? HEALTH_STATE.HEALTHY : HEALTH_STATE.OFFLINE,
    detail: database.healthy
      ? `Connected to "${database.name}" on ${database.host}.`
      : `The database is ${database.status}. Dependent routes will fail until it reconnects.`,
    metrics: [
      { label: 'State', value: database.status },
      { label: 'Database', value: database.name ?? '—' },
      { label: 'Host', value: database.host ?? '—' },
    ],
  })
}

function probeApi() {
  const memory = process.memoryUsage()
  const uptimeHours = process.uptime() / 3600

  return healthComponentDTO({
    id: 'api',
    name: 'API process',
    group: 'Runtime',
    state: HEALTH_STATE.HEALTHY,
    detail: `Serving for ${uptimeHours < 1 ? `${Math.round(process.uptime() / 60)} min` : `${uptimeHours.toFixed(1)}h`} on Node ${process.version}.`,
    metrics: [
      { label: 'Uptime', value: `${uptimeHours.toFixed(1)}h` },
      { label: 'Heap', value: `${Math.round(memory.heapUsed / 1024 / 1024)} MB` },
      { label: 'RSS', value: `${Math.round(memory.rss / 1024 / 1024)} MB` },
    ],
  })
}

/**
 * The morning scheduler.
 *
 * Two independent signals, and both matter: whether the in-process clock is
 * ticking, and whether the elected primary workspace is enabled. A ticking
 * clock with a disabled workspace sends nothing, and a disabled clock with an
 * enabled workspace sends nothing either — reporting only one of them would
 * call half the failure modes healthy.
 */
async function probeScheduler() {
  const setting = await SchedulerSetting.findOne({ isPrimary: true })

  if (!setting) {
    return healthComponentDTO({
      id: 'scheduler',
      name: 'Morning scheduler',
      group: 'Background',
      state: HEALTH_STATE.WARNING,
      detail: 'No primary scheduling workspace has been elected. The morning run will not fire.',
      metrics: [{ label: 'Primary', value: 'None' }],
    })
  }

  const view = setting.toPublicJSON()
  const lastRunAt = view.lastRun?.at ?? null
  const lastStatus = view.lastRun?.status ?? null

  /*
   * Whether the run is actually *happening*, not merely configured to.
   *
   * The three checks below all read stored intent — elected, enabled, and how
   * the last run ended. None of them notices a process that has stopped: the
   * clock never ticks, `lastRun.at` simply ages, and the probe went on
   * reporting HEALTHY because `enabled` was still true. A scheduler that has
   * not fired for a week looked exactly like one that fired this morning.
   *
   * `probeReplySync` already guards against this with a multiple of its own
   * interval; this is the same rule for a run whose interval is a day. The
   * threshold is generous — 36 hours, not 24 — so a run that slips past
   * midnight, or a timezone an hour either side of the server's, does not
   * raise a warning on its own.
   */
  const STALE_AFTER_MS = 36 * 60 * 60 * 1000
  const stale = lastRunAt && Date.now() - new Date(lastRunAt).getTime() > STALE_AFTER_MS

  let state = HEALTH_STATE.HEALTHY
  let detail = `Enabled. Next run ${view.nextRunAt ? new Date(view.nextRunAt).toISOString() : 'not scheduled'} (${view.timezone}).`

  if (!view.enabled) {
    state = HEALTH_STATE.WARNING
    detail = 'The morning run is switched off. No workbook will be imported automatically.'
  } else if (lastStatus === 'failed') {
    state = HEALTH_STATE.WARNING
    detail = `The last run failed: ${view.lastRun?.message ?? 'no reason recorded'}.`
  } else if (stale) {
    /*
     * Deliberately not OFFLINE. This cannot distinguish a stopped process from
     * a deployment that simply has not reached its first run, and claiming the
     * scheduler is down when it may be minutes from firing would be its own
     * kind of wrong answer.
     */
    state = HEALTH_STATE.WARNING
    detail =
      `Enabled, but the last run was ${ago(lastRunAt)} — longer than a day. ` +
      'Check that the API process is running.'
  } else if (!lastRunAt) {
    state = HEALTH_STATE.UNKNOWN
    detail = 'Enabled, but no run has been recorded yet.'
  }

  return healthComponentDTO({
    id: 'scheduler',
    name: 'Morning scheduler',
    group: 'Background',
    state,
    detail,
    metrics: [
      { label: 'Run time', value: `${view.runTime} ${view.timezone}` },
      { label: 'Last run', value: ago(lastRunAt) },
      { label: 'Busy now', value: isSchedulerBusy() ? 'Yes' : 'No' },
    ],
  })
}

/**
 * The workbook queue.
 *
 * A job whose lock is older than the ten-minute TTL is stuck — its worker died
 * mid-run and nothing has reclaimed it yet. That is the condition worth waking
 * somebody for; a deep queue is merely busy.
 */
async function probeWorkbookQueue() {
  const lockCutoff = new Date(Date.now() - 10 * 60 * 1000)

  const [queued, running, stuck, failedToday] = await Promise.all([
    ImportJob.countDocuments({ status: IMPORT_STATUS.QUEUED }),
    ImportJob.countDocuments({ status: IMPORT_STATUS.RUNNING }),
    ImportJob.countDocuments({ status: IMPORT_STATUS.RUNNING, lockedAt: { $lt: lockCutoff } }),
    ImportJob.countDocuments({
      status: IMPORT_STATUS.FAILED,
      updatedAt: { $gte: new Date(Date.now() - 86_400_000) },
    }),
  ])

  let state = HEALTH_STATE.HEALTHY
  let detail = running > 0 ? `${running} import running.` : 'Idle — nothing queued.'

  if (stuck > 0) {
    state = HEALTH_STATE.WARNING
    detail = `${stuck} import has held its lock past the ten-minute TTL and will be requeued.`
  } else if (queued > 5) {
    state = HEALTH_STATE.WARNING
    detail = `${queued} imports are waiting. The worker polls every two seconds.`
  }

  return healthComponentDTO({
    id: 'workbook',
    name: 'Workbook queue',
    group: 'Background',
    state,
    detail,
    metrics: [
      { label: 'Queued', value: String(queued) },
      { label: 'Running', value: String(running) },
      { label: 'Failed 24h', value: String(failedToday) },
    ],
  })
}

/** Reply sync, judged by how recently it last succeeded against its own interval. */
async function probeReplySync() {
  const setting = await SchedulerSetting.findOne({ isPrimary: true })
  const view = setting?.replySyncJSON?.() ?? setting?.toPublicJSON?.()?.replySync ?? null

  if (!view) {
    return healthComponentDTO({
      id: 'replysync',
      name: 'Reply sync',
      group: 'Background',
      state: HEALTH_STATE.UNKNOWN,
      detail: 'No reply-sync settings have been created yet.',
      metrics: [{ label: 'Busy now', value: isReplySyncBusy() ? 'Yes' : 'No' }],
    })
  }

  const intervalMs = (view.intervalMinutes ?? 5) * 60 * 1000
  const lastRunAt = view.lastRunAt ?? null
  const overdue = lastRunAt && Date.now() - new Date(lastRunAt).getTime() > intervalMs * 3

  let state = HEALTH_STATE.HEALTHY
  let detail = `Last successful pass ${ago(lastRunAt)}.`

  if (!view.enabled) {
    state = HEALTH_STATE.WARNING
    detail = 'Reply sync is switched off. Customer replies will not be ingested.'
  } else if (!lastRunAt) {
    state = HEALTH_STATE.UNKNOWN
    detail = 'Enabled, but no pass has completed since this process started.'
  } else if (overdue) {
    state = HEALTH_STATE.WARNING
    detail = `Enabled, but the last pass was ${ago(lastRunAt)} — more than three intervals ago.`
  }

  return healthComponentDTO({
    id: 'replysync',
    name: 'Reply sync',
    group: 'Background',
    state,
    detail,
    metrics: [
      { label: 'Interval', value: `${view.intervalMinutes ?? '—'} min` },
      { label: 'Last pass', value: ago(lastRunAt) },
      { label: 'Busy now', value: isReplySyncBusy() ? 'Yes' : 'No' },
    ],
  })
}

/**
 * Microsoft Graph, inferred from recorded sync outcomes.
 *
 * See the module note: this does not call Graph. It reads what the provider
 * module has already recorded about its own calls, which is evidence of the
 * same thing without being another request into somebody's rate limit.
 */
async function probeGraph() {
  if (!config.microsoft.enabled) {
    return healthComponentDTO({
      id: 'graph',
      name: 'Microsoft Graph',
      group: 'External',
      state: HEALTH_STATE.UNKNOWN,
      detail: 'Microsoft integration is not configured in this environment.',
      metrics: [{ label: 'Configured', value: 'No' }],
    })
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [lastSuccess, failures24h, total24h] = await Promise.all([
    SyncHistory.findOne({ status: SYNC_STATUS.SUCCESS })
      .sort({ finishedAt: -1 })
      .select('finishedAt')
      .lean(),
    // `partial` counts as a failure here: some folders did not sync, and the
    // question this probe answers is "is Graph working", not "did anything
    // arrive". The detail line below distinguishes total from partial loss.
    SyncHistory.countDocuments({
      status: { $in: [SYNC_STATUS.FAILED, SYNC_STATUS.PARTIAL] },
      startedAt: { $gte: since },
    }),
    SyncHistory.countDocuments({ startedAt: { $gte: since } }),
  ])

  let state = HEALTH_STATE.HEALTHY
  let detail = `Last successful synchronisation ${ago(lastSuccess?.finishedAt)}.`

  if (total24h === 0) {
    state = HEALTH_STATE.UNKNOWN
    detail = 'Configured, but no synchronisation has been attempted in the last 24 hours.'
  } else if (failures24h > 0 && failures24h === total24h) {
    state = HEALTH_STATE.OFFLINE
    detail = `Every one of the last ${total24h} synchronisation attempts failed.`
  } else if (failures24h > 0) {
    state = HEALTH_STATE.WARNING
    detail = `${failures24h} of ${total24h} synchronisations failed in the last 24 hours.`
  }

  return healthComponentDTO({
    id: 'graph',
    name: 'Microsoft Graph',
    group: 'External',
    state,
    detail,
    metrics: [
      { label: 'Last success', value: ago(lastSuccess?.finishedAt) },
      { label: 'Runs 24h', value: String(total24h) },
      { label: 'Failures 24h', value: String(failures24h) },
    ],
  })
}

/** Google sign-in, judged by configuration plus recent successful sign-ins. */
async function probeGoogleAuth() {
  const configured = Boolean(config.google?.enabled ?? config.google?.clientId)

  if (!configured) {
    return healthComponentDTO({
      id: 'google',
      name: 'Google sign-in',
      group: 'External',
      state: HEALTH_STATE.OFFLINE,
      detail: 'Google is not configured. Nobody can sign in to the CRM.',
      metrics: [{ label: 'Configured', value: 'No' }],
    })
  }

  const [recentSignIns, googleUsers] = await Promise.all([
    User.countDocuments({ lastLoginAt: { $gte: new Date(Date.now() - 7 * 86_400_000) } }),
    User.countDocuments({ provider: AUTH_PROVIDERS.GOOGLE, isDeleted: { $ne: true } }),
  ])

  return healthComponentDTO({
    id: 'google',
    name: 'Google sign-in',
    group: 'External',
    state: HEALTH_STATE.HEALTHY,
    detail:
      recentSignIns > 0
        ? `Configured. ${recentSignIns} sign-in${recentSignIns === 1 ? '' : 's'} in the last seven days.`
        : 'Configured, but nobody has signed in for seven days.',
    metrics: [
      { label: 'Configured', value: 'Yes' },
      { label: 'Google accounts', value: String(googleUsers) },
      { label: 'Sign-ins 7d', value: String(recentSignIns) },
    ],
  })
}

/** Mailbox estate, rolled up from the registry rather than probed per mailbox. */
async function probeMailboxes() {
  const [total, connected, errored] = await Promise.all([
    Mailbox.countDocuments({}),
    Mailbox.countDocuments({ status: 'connected' }),
    Mailbox.countDocuments({ status: { $in: ['error', 'expired'] } }),
  ])

  let state = HEALTH_STATE.HEALTHY
  let detail = `${connected} of ${total} mailboxes are connected.`

  if (total === 0) {
    state = HEALTH_STATE.WARNING
    detail = 'No mailbox is connected. The CRM cannot send or read mail.'
  } else if (connected === 0) {
    state = HEALTH_STATE.OFFLINE
    detail = 'No mailbox is currently connected. Sending and reply sync are both stopped.'
  } else if (errored > 0) {
    state = HEALTH_STATE.WARNING
    detail = `${errored} mailbox${errored === 1 ? '' : 'es'} need reconnecting.`
  }

  return healthComponentDTO({
    id: 'mailboxes',
    name: 'Mailbox estate',
    group: 'External',
    state,
    detail,
    metrics: [
      { label: 'Connected', value: `${connected} / ${total}` },
      { label: 'Errored', value: String(errored) },
    ],
  })
}

/**
 * Workbook storage.
 *
 * `statfs` is Node 18.15+ and is not implemented on every filesystem, so a
 * failure falls back to reporting the file count alone rather than the probe
 * disappearing. Knowing how many files are there is still useful.
 */
async function probeStorage() {
  const root = config.storage.workbooks

  let fileCount = 0
  try {
    fileCount = (await readdir(root)).length
  } catch {
    return healthComponentDTO({
      id: 'storage',
      name: 'Workbook storage',
      group: 'Data',
      state: HEALTH_STATE.WARNING,
      detail: `The workbook storage directory could not be read: ${root}`,
      metrics: [{ label: 'Path', value: root }],
    })
  }

  let usedPercent = null
  let freeGb = null

  try {
    const fs = await statfs(root)
    const totalBytes = fs.blocks * fs.bsize
    const freeBytes = fs.bavail * fs.bsize
    usedPercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 100)
    freeGb = (freeBytes / 1024 ** 3).toFixed(1)
  } catch {
    // Not fatal — the file count below is still worth reporting.
  }

  let state = HEALTH_STATE.HEALTHY
  let detail = `${fileCount} stored workbook${fileCount === 1 ? '' : 's'}.`

  if (usedPercent !== null && usedPercent >= 95) {
    state = HEALTH_STATE.OFFLINE
    detail = `The volume is ${usedPercent}% full. New uploads will fail.`
  } else if (usedPercent !== null && usedPercent >= 80) {
    state = HEALTH_STATE.WARNING
    detail = `The volume is ${usedPercent}% full.`
  }

  return healthComponentDTO({
    id: 'storage',
    name: 'Workbook storage',
    group: 'Data',
    state,
    detail,
    metrics: [
      { label: 'Files', value: String(fileCount) },
      { label: 'Used', value: usedPercent === null ? 'unknown' : `${usedPercent}%` },
      { label: 'Free', value: freeGb === null ? 'unknown' : `${freeGb} GB` },
    ],
  })
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Runs every probe and rolls the results up.
 *
 * The overall state is the **worst** component's, never an average. A platform
 * reporting "healthy" with one dependency offline is a summary nobody can trust,
 * and the second time an operator catches it doing that they stop reading it.
 */
export async function buildAdminHealth() {
  const components = await Promise.all([
    probe('mongodb', 'MongoDB', 'Data', probeDatabase),
    probe('api', 'API process', 'Runtime', probeApi),
    probe('scheduler', 'Morning scheduler', 'Background', probeScheduler),
    probe('workbook', 'Workbook queue', 'Background', probeWorkbookQueue),
    probe('replysync', 'Reply sync', 'Background', probeReplySync),
    probe('graph', 'Microsoft Graph', 'External', probeGraph),
    probe('google', 'Google sign-in', 'External', probeGoogleAuth),
    probe('mailboxes', 'Mailbox estate', 'External', probeMailboxes),
    probe('storage', 'Workbook storage', 'Data', probeStorage),
  ])

  const worst = components.reduce(
    (accumulator, component) =>
      HEALTH_SEVERITY[component.state] > HEALTH_SEVERITY[accumulator] ? component.state : accumulator,
    HEALTH_STATE.HEALTHY,
  )

  return {
    status: worst,
    statusLabel: HEALTH_STATE_LABELS[worst],
    checkedAt: new Date().toISOString(),
    components,
    summary: {
      total: components.length,
      healthy: components.filter((component) => component.state === HEALTH_STATE.HEALTHY).length,
      warning: components.filter((component) => component.state === HEALTH_STATE.WARNING).length,
      offline: components.filter((component) => component.state === HEALTH_STATE.OFFLINE).length,
      unknown: components.filter((component) => component.state === HEALTH_STATE.UNKNOWN).length,
    },
    workers: {
      workbook: isWorkerBusy(),
      scheduler: isSchedulerBusy(),
      replySync: isReplySyncBusy(),
    },
    /** Stated in the response so the console does not overclaim what was checked. */
    note: 'External services are inferred from recorded outcomes rather than probed live.',
  }
}

export default { buildAdminHealth }
