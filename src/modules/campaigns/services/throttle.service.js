/**
 * Rate limiting and mailbox rotation.
 *
 * Both exist for one reason: **protecting the sending mailboxes**. Exchange
 * Online throttles a mailbox that sends too fast, and a domain that trips
 * throttling repeatedly acquires a reputation problem that outlives the
 * campaign. The cost of sending slowly is a few hours; the cost of getting a
 * sending domain flagged is measured in weeks.
 *
 * ## Rate limiting is measured, not scheduled
 *
 * Counts come from `CampaignEvent` rather than an in-memory counter. That
 * survives a restart, works if a second worker is ever added, and cannot drift
 * from what was actually sent — an in-memory tally would reset on deploy and
 * allow a burst at exactly the wrong moment.
 *
 * ## Rotation is round-robin with health
 *
 * Mailboxes are used in turn so no single one carries the whole campaign. A
 * mailbox that fails repeatedly is taken out of rotation for a cooldown rather
 * than being retried into the ground.
 */

import { CampaignEvent } from '../../../models/campaignEvent.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import {
  CAMPAIGN_EVENT,
  MAILBOX_COOLDOWN_MS,
  MAILBOX_FAILURE_THRESHOLD,
  MAX_RATE_LIMITS,
} from '../constants/campaignConstants.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('campaign-throttle')

/**
 * Clamps user-supplied limits to what the provider will actually tolerate.
 *
 * A user typing 500 per minute is not expressing a preference the system should
 * honour — it is asking to be throttled. The ceiling is applied silently rather
 * than rejected, because the intent ("send fast") is fine.
 */
export function clampThrottle(throttle = {}) {
  return {
    perMinute: Math.min(Math.max(1, throttle.perMinute ?? 20), MAX_RATE_LIMITS.perMinute),
    perHour: Math.min(Math.max(1, throttle.perHour ?? 500), MAX_RATE_LIMITS.perHour),
    perDay: Math.min(Math.max(1, throttle.perDay ?? 5000), MAX_RATE_LIMITS.perDay),
    batchSize: Math.min(Math.max(1, throttle.batchSize ?? 25), 100),
  }
}

/**
 * How many messages may be sent right now.
 *
 * Returns the *smallest* allowance across the three windows: a campaign under
 * its per-minute limit but at its daily cap must stop, and taking the minimum
 * is what enforces that without three separate checks at the call site.
 *
 * @param {object} params
 * @returns {Promise<{ allowed: number, limitedBy: ?string, retryAfterMs: number, counts: object }>}
 */
export async function availableAllowance({ owner, campaignId = null, throttle }) {
  const limits = clampThrottle(throttle)
  const now = Date.now()

  const windows = [
    { name: 'perMinute', since: new Date(now - 60_000), limit: limits.perMinute, resetMs: 60_000 },
    { name: 'perHour', since: new Date(now - 3_600_000), limit: limits.perHour, resetMs: 3_600_000 },
    { name: 'perDay', since: new Date(now - 86_400_000), limit: limits.perDay, resetMs: 86_400_000 },
  ]

  const filter = { owner, type: CAMPAIGN_EVENT.SENT }
  if (campaignId) filter.campaign = campaignId

  // Counted in parallel — three independent queries with no ordering between them.
  const counts = await Promise.all(
    windows.map((window) =>
      CampaignEvent.countDocuments({ ...filter, occurredAt: { $gte: window.since } }),
    ),
  )

  let allowed = Number.POSITIVE_INFINITY
  let limitedBy = null
  let retryAfterMs = 0

  windows.forEach((window, index) => {
    const remaining = window.limit - counts[index]

    if (remaining < allowed) {
      allowed = remaining
      limitedBy = remaining <= 0 ? window.name : limitedBy
      // How long until the oldest send in this window ages out.
      if (remaining <= 0) retryAfterMs = Math.max(retryAfterMs, Math.min(window.resetMs, 60_000))
    }
  })

  return {
    allowed: Math.max(0, allowed),
    limitedBy,
    retryAfterMs,
    counts: Object.fromEntries(windows.map((window, index) => [window.name, counts[index]])),
  }
}

// ---------------------------------------------------------------------------
// Mailbox rotation
// ---------------------------------------------------------------------------

/**
 * In-process health tracking.
 *
 * Held in memory rather than persisted, deliberately. Mailbox health is a
 * transient, seconds-to-minutes property — a mailbox busy now is fine in ten
 * minutes — and persisting it would mean a stale "unhealthy" flag surviving a
 * restart and needlessly excluding a working mailbox. The cost of forgetting on
 * restart is one wasted send attempt.
 *
 * @type {Map<string, { failures: number, unhealthyUntil: number, sent: number }>}
 */
const health = new Map()

const healthFor = (mailboxId) => {
  const key = String(mailboxId)
  if (!health.has(key)) health.set(key, { failures: 0, unhealthyUntil: 0, sent: 0 })
  return health.get(key)
}

/** True when a mailbox is inside its cooldown. */
export function isMailboxHealthy(mailboxId) {
  return healthFor(mailboxId).unhealthyUntil <= Date.now()
}

/** Records a successful send, clearing accumulated failures. */
export function recordMailboxSuccess(mailboxId) {
  const entry = healthFor(mailboxId)
  entry.failures = 0
  entry.sent += 1
}

/**
 * Records a failure attributable to the mailbox.
 *
 * Only mailbox-level faults should reach here — an invalid recipient address
 * says nothing about the sender, and counting it would take a healthy mailbox
 * out of rotation because of one bad row in a spreadsheet.
 *
 * @returns {{ unhealthy: boolean, failures: number }}
 */
export function recordMailboxFailure(mailboxId) {
  const entry = healthFor(mailboxId)
  entry.failures += 1

  if (entry.failures >= MAILBOX_FAILURE_THRESHOLD) {
    entry.unhealthyUntil = Date.now() + MAILBOX_COOLDOWN_MS

    log.warn('Mailbox taken out of rotation', {
      mailboxId: String(mailboxId),
      failures: entry.failures,
      cooldownMinutes: MAILBOX_COOLDOWN_MS / 60_000,
    })

    return { unhealthy: true, failures: entry.failures }
  }

  return { unhealthy: false, failures: entry.failures }
}

/** Clears health state. Exposed for tests and for an operator override. */
export function resetMailboxHealth(mailboxId = null) {
  if (mailboxId) health.delete(String(mailboxId))
  else health.clear()
}

/**
 * Chooses the mailbox to send the next message from.
 *
 * Round-robin over the healthy mailboxes, ordered by how many each has sent in
 * this process. That is self-correcting: a mailbox returning from cooldown is
 * behind on count and naturally receives the next several messages, rather than
 * needing an explicit catch-up rule.
 *
 * Falls back to the least-recently-failed mailbox when all are unhealthy —
 * refusing to send at all would stall a campaign because of a transient blip,
 * and the send will simply fail again and be retried if the problem is real.
 *
 * @param {object} params
 * @returns {Promise<{ mailbox: ?object, allUnhealthy: boolean }>}
 */
export async function selectMailbox({ owner, mailboxIds = [] }) {
  /**
   * `Mailbox` keys its owner as `user`, not `owner` — the field predates this
   * module. Querying the wrong name matched nothing and returned no mailbox at
   * all, which surfaces as a campaign that silently refuses to send.
   */
  const candidates =
    mailboxIds.length > 0
      ? await Mailbox.find({ _id: { $in: mailboxIds }, user: owner })
      : await Mailbox.find({ user: owner, status: 'connected' })

  const usable = candidates.filter((mailbox) => mailbox.status !== 'disconnected')

  if (usable.length === 0) return { mailbox: null, allUnhealthy: false }

  const healthy = usable.filter((mailbox) => isMailboxHealthy(mailbox._id))

  if (healthy.length === 0) {
    // Everything is cooling down. Use whichever recovers soonest rather than
    // stalling the campaign entirely.
    const soonest = usable.sort(
      (a, b) => healthFor(a._id).unhealthyUntil - healthFor(b._id).unhealthyUntil,
    )[0]

    return { mailbox: soonest, allUnhealthy: true }
  }

  const next = healthy.sort((a, b) => healthFor(a._id).sent - healthFor(b._id).sent)[0]

  return { mailbox: next, allUnhealthy: false }
}

/** Per-mailbox counters for the analytics view. */
export function mailboxHealthSnapshot(mailboxIds = []) {
  return mailboxIds.map((id) => {
    const entry = healthFor(id)
    return {
      mailbox: String(id),
      sentThisProcess: entry.sent,
      consecutiveFailures: entry.failures,
      healthy: entry.unhealthyUntil <= Date.now(),
      unhealthyUntil: entry.unhealthyUntil > Date.now() ? new Date(entry.unhealthyUntil) : null,
    }
  })
}

export default {
  clampThrottle,
  availableAllowance,
  selectMailbox,
  isMailboxHealthy,
  recordMailboxSuccess,
  recordMailboxFailure,
  resetMailboxHealth,
  mailboxHealthSnapshot,
}
