/**
 * The sending queue.
 *
 * Drains a campaign's recipients in batches, respecting the rate limits and
 * rotating mailboxes, with retry and backoff for transient failures.
 *
 * ## Sending goes through the provider abstraction
 *
 * This module calls `EmailProvider.send()` and never touches Microsoft Graph.
 * That is Phase 5's governing rule, and it is what will let a campaign run over
 * SMTP or SendGrid without this file changing.
 *
 * ## Claiming is atomic
 *
 * A recipient is claimed with a single `findOneAndUpdate` that moves it from
 * `queued` to `sending`. Two workers cannot claim the same one, because only
 * one update can match a document whose status is still `queued`. A read
 * followed by a write would let both pass.
 *
 * ## Failures are classified before they are retried
 *
 * Retrying an invalid address never succeeds, and doing so repeatedly is what
 * gets a sending domain flagged. Every failure is sorted into temporary or
 * permanent first; only the former is scheduled for another attempt.
 */

import { Campaign, CAMPAIGN_LOCK_TTL_MS } from '../../../models/campaign.model.js'
import { CampaignEvent } from '../../../models/campaignEvent.model.js'
import { CampaignRecipient } from '../../../models/campaignRecipient.model.js'
import { Contact } from '../../../models/contact.model.js'
import { Mail } from '../../../models/mail.model.js'
import { MAIL_STATUS } from '../../../constants/mailStatus.js'
import { PROVIDER_ERROR_CODES } from '../../provider/constants/providerErrors.js'
import {
  CAMPAIGN_EVENT,
  CAMPAIGN_STATUS,
  FAILURE_KIND,
  MAILBOX_FAULTS,
  MAX_SEND_ATTEMPTS,
  RECIPIENT_STATUS,
  RETRYABLE_FAILURES,
  RETRY_DELAYS_MS,
} from '../constants/campaignConstants.js'
import { renderMessage } from './personalisation.service.js'
import {
  availableAllowance,
  recordMailboxFailure,
  recordMailboxSuccess,
  selectMailbox,
} from './throttle.service.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('campaign-queue')

/**
 * Sorts a provider failure into a retry decision.
 *
 * The mapping is the whole reason failures are worth classifying: a rate limit
 * clears on its own, a malformed address never will, and treating them alike
 * either wastes quota or drops a deliverable message.
 *
 * @param {unknown} error
 * @returns {{ kind: string, message: string, retryable: boolean, mailboxFault: boolean }}
 */
export function classifyFailure(error) {
  const code = error?.code ?? null
  const message = error?.message ?? String(error)

  const kind =
    {
      [PROVIDER_ERROR_CODES.RATE_LIMITED]: FAILURE_KIND.RATE_LIMITED,
      [PROVIDER_ERROR_CODES.NETWORK_FAILURE]: FAILURE_KIND.TEMPORARY,
      [PROVIDER_ERROR_CODES.TIMEOUT]: FAILURE_KIND.TEMPORARY,
      [PROVIDER_ERROR_CODES.UNAVAILABLE]: FAILURE_KIND.TEMPORARY,
      [PROVIDER_ERROR_CODES.MAILBOX_UNAVAILABLE]: FAILURE_KIND.MAILBOX_NOT_FOUND,
      [PROVIDER_ERROR_CODES.TOKEN_EXPIRED]: FAILURE_KIND.MAILBOX_NOT_FOUND,
      [PROVIDER_ERROR_CODES.CONSENT_REQUIRED]: FAILURE_KIND.MAILBOX_NOT_FOUND,
      [PROVIDER_ERROR_CODES.INSUFFICIENT_PERMISSIONS]: FAILURE_KIND.MAILBOX_NOT_FOUND,
      [PROVIDER_ERROR_CODES.INVALID_REQUEST]: FAILURE_KIND.INVALID_EMAIL,
    }[code] ??
    // Graph reports a bad recipient as a 400 with a recognisable message rather
    // than a distinct code, so the text is the only signal available.
    (/recipient|address|invalid.*mail/i.test(message)
      ? FAILURE_KIND.INVALID_EMAIL
      : FAILURE_KIND.UNKNOWN)

  return {
    kind,
    message,
    retryable: RETRYABLE_FAILURES.has(kind),
    mailboxFault: MAILBOX_FAULTS.has(kind),
  }
}

/** Records an event. Never throws — a failed audit write must not fail a send. */
async function recordEvent({ campaign, recipient, owner, type, email, mailbox, detail }) {
  try {
    await CampaignEvent.create({
      campaign: campaign?._id ?? campaign,
      recipient: recipient?._id ?? recipient ?? null,
      owner,
      type,
      email: email ?? null,
      mailbox: mailbox ?? null,
      detail: detail ?? null,
    })
  } catch (error) {
    log.warn('Could not record a campaign event', { type, message: error.message })
  }
}

/**
 * Claims the next batch of recipients.
 *
 * Each is claimed individually and atomically. A bulk `updateMany` would be one
 * round trip but could not return *which* documents it claimed, and the queue
 * needs the list.
 *
 * @returns {Promise<object[]>}
 */
async function claimBatch({ campaign, size }) {
  const claimed = []
  const now = new Date()

  for (let index = 0; index < size; index += 1) {
    const recipient = await CampaignRecipient.findOneAndUpdate(
      {
        campaign: campaign._id,
        status: RECIPIENT_STATUS.QUEUED,
        // Either never attempted, or the backoff has elapsed.
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      { $set: { status: RECIPIENT_STATUS.SENDING }, $inc: { attempts: 1 } },
      { new: true, sort: { queuedAt: 1 } },
    )

    if (!recipient) break
    claimed.push(recipient)
  }

  return claimed
}

/**
 * Sends to one claimed recipient.
 *
 * @returns {Promise<{ outcome: 'sent'|'retry'|'failed'|'skipped', kind: ?string }>}
 */
async function sendToRecipient({ recipient, campaign, provider, mailbox, owner }) {
  const contact = await Contact.findById(recipient.contact)

  /**
   * A contact marked do-not-contact is skipped even though the campaign was
   * built with them in it. The list may have been assembled days ago, and
   * honouring the opt-out matters more than the campaign's completeness.
   */
  if (contact?.leadStatus === 'do_not_contact') {
    recipient.status = RECIPIENT_STATUS.SKIPPED
    recipient.skipReason = 'Contact is marked do-not-contact.'
    await recipient.save()

    await recordEvent({
      campaign, recipient, owner, type: CAMPAIGN_EVENT.SKIPPED,
      email: recipient.email, detail: { reason: 'do_not_contact' },
    })

    return { outcome: 'skipped', kind: null }
  }

  const rendered = renderMessage({
    subject: campaign.subject,
    bodyHtml: campaign.bodyHtml,
    contact: contact ?? {},
    /**
     * Campaign values first, recipient values over the top.
     *
     * `{{Destination}}` is normally one value for the whole campaign, but an
     * imported sheet may carry a per-row destination. The row is the more
     * specific fact, so it wins.
     */
    campaignValues: {
      ...(campaign.variables ? Object.fromEntries(campaign.variables) : {}),
      ...(recipient.variables ? Object.fromEntries(recipient.variables) : {}),
    },
  })

  await recordEvent({
    campaign, recipient, owner, type: CAMPAIGN_EVENT.SEND_ATTEMPTED,
    email: recipient.email, mailbox: mailbox._id, detail: { attempt: recipient.attempts },
  })

  try {
    const result = await provider.send(
      {
        to: [{ address: recipient.email, name: contact?.displayName ?? null }],
        subject: rendered.subject,
        bodyHtml: rendered.html,
      },
      { mailbox },
    )

    // Recorded in the Phase 4 audit trail too, so a campaign send appears in
    // mail history alongside anything sent by hand.
    const mail = await Mail.create({
      userId: owner,
      mailbox: mailbox._id,
      provider: provider.type,
      from: mailbox.emailAddress,
      to: [{ address: recipient.email, name: contact?.displayName ?? null }],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      status: MAIL_STATUS.SENT,
      sentAt: new Date(),
      graphRequestId: result.correlationId ?? null,
      providerMessageId: result.providerMessageId ?? null,
    })

    recipient.status = RECIPIENT_STATUS.SENT
    recipient.sentAt = new Date()
    recipient.sentFromMailbox = mailbox._id
    recipient.mail = mail._id
    recipient.providerMessageId = result.providerMessageId ?? null
    recipient.nextAttemptAt = null
    recipient.lastError = { kind: null, message: null, occurredAt: null }
    await recipient.save()

    recordMailboxSuccess(mailbox._id)

    await recordEvent({
      campaign, recipient, owner, type: CAMPAIGN_EVENT.SENT,
      email: recipient.email, mailbox: mailbox._id,
      detail: { correlationId: result.correlationId ?? null },
    })

    return { outcome: 'sent', kind: null }
  } catch (error) {
    const failure = classifyFailure(error)

    if (failure.mailboxFault) recordMailboxFailure(mailbox._id)

    const canRetry = failure.retryable && recipient.attempts < MAX_SEND_ATTEMPTS

    if (canRetry) {
      // Backoff index is attempts-1 because the counter was incremented at claim.
      const delay = RETRY_DELAYS_MS[Math.min(recipient.attempts - 1, RETRY_DELAYS_MS.length - 1)]

      recipient.status = RECIPIENT_STATUS.QUEUED
      recipient.nextAttemptAt = new Date(Date.now() + delay)
      recipient.lastError = { kind: failure.kind, message: failure.message, occurredAt: new Date() }
      await recipient.save()

      await recordEvent({
        campaign, recipient, owner, type: CAMPAIGN_EVENT.RETRY_SCHEDULED,
        email: recipient.email, mailbox: mailbox._id,
        detail: { kind: failure.kind, attempt: recipient.attempts, retryInMs: delay },
      })

      return { outcome: 'retry', kind: failure.kind }
    }

    // A permanent recipient-side rejection is a bounce, not a system failure —
    // the distinction drives both the analytics and whether the address should
    // ever be mailed again.
    const isBounce =
      failure.kind === FAILURE_KIND.INVALID_EMAIL || failure.kind === FAILURE_KIND.PERMANENT

    recipient.status = isBounce ? RECIPIENT_STATUS.BOUNCED : RECIPIENT_STATUS.FAILED
    recipient.nextAttemptAt = null
    recipient.lastError = { kind: failure.kind, message: failure.message, occurredAt: new Date() }
    await recipient.save()

    await recordEvent({
      campaign, recipient, owner,
      type: isBounce ? CAMPAIGN_EVENT.BOUNCED : CAMPAIGN_EVENT.FAILED,
      email: recipient.email, mailbox: mailbox._id,
      detail: { kind: failure.kind, message: failure.message, attempts: recipient.attempts },
    })

    return { outcome: isBounce ? 'bounced' : 'failed', kind: failure.kind }
  }
}

/**
 * Drains one batch of a campaign.
 *
 * Returns without sending when the rate limit is exhausted, reporting how long
 * to wait — the caller decides whether to sleep or move to another campaign.
 *
 * @param {object} params
 * @returns {Promise<object>} What happened in this batch.
 */
export async function processBatch({ campaign, provider, owner }) {
  const result = {
    claimed: 0, sent: 0, retried: 0, failed: 0, bounced: 0, skipped: 0,
    throttled: false, retryAfterMs: 0, limitedBy: null,
  }

  /**
   * Rate limiting is measured across **every** campaign, not just this one.
   *
   * The limit exists to protect the sending mailboxes, and a mailbox does not
   * care which campaign a message belongs to: two campaigns each sending 20 a
   * minute is 40 a minute from the same mailbox, which is precisely what trips
   * Exchange throttling. Scoping the count per campaign would let the limit be
   * bypassed by splitting a send in two.
   */
  const allowance = await availableAllowance({ owner, throttle: campaign.throttle })

  if (allowance.allowed <= 0) {
    result.throttled = true
    result.retryAfterMs = allowance.retryAfterMs
    result.limitedBy = allowance.limitedBy
    return result
  }

  const batchSize = Math.min(campaign.throttle?.batchSize ?? 25, allowance.allowed)

  // --- Mailbox -------------------------------------------------------------
  const { mailbox, allUnhealthy } = await selectMailbox({
    owner,
    mailboxIds: campaign.senderMailboxes,
  })

  if (!mailbox) {
    throw new Error('No sending mailbox is available for this campaign.')
  }

  if (allUnhealthy) {
    log.warn('Every sending mailbox is in cooldown; using the one recovering soonest', {
      campaignId: campaign._id.toString(),
    })
  }

  // --- Claim and send ------------------------------------------------------
  const claimed = await claimBatch({ campaign, size: batchSize })
  result.claimed = claimed.length

  for (const recipient of claimed) {
    const outcome = await sendToRecipient({ recipient, campaign, provider, mailbox, owner })

    if (outcome.outcome === 'sent') result.sent += 1
    else if (outcome.outcome === 'retry') result.retried += 1
    else if (outcome.outcome === 'bounced') result.bounced += 1
    else if (outcome.outcome === 'skipped') result.skipped += 1
    else result.failed += 1
  }

  return result
}

/**
 * Runs a campaign to completion, or until it is paused, throttled or empty.
 *
 * @param {object} params
 * @param {number} [params.maxBatches] Bounds one invocation, so a very large
 *   campaign yields rather than monopolising the process.
 * @returns {Promise<object>} The campaign, with a summary of this run.
 */
export async function drainCampaign({ campaign, provider, owner, maxBatches = 40, onProgress = null }) {
  const staleBefore = new Date(Date.now() - CAMPAIGN_LOCK_TTL_MS)

  const locked = await Campaign.findOneAndUpdate(
    {
      _id: campaign._id,
      status: { $in: [CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.RUNNING] },
      $or: [{ lockedAt: null }, { lockedAt: { $lt: staleBefore } }],
    },
    {
      $set: {
        lockedAt: new Date(),
        status: CAMPAIGN_STATUS.RUNNING,
        startedAt: campaign.startedAt ?? new Date(),
      },
    },
    { new: true },
  )

  if (!locked) {
    return { campaign, ran: false, reason: 'Campaign is not runnable or is already draining.' }
  }

  const totals = { sent: 0, retried: 0, failed: 0, bounced: 0, skipped: 0, batches: 0 }
  let stopReason = 'drained'

  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // Re-read each batch so a pause or cancel takes effect promptly rather
      // than after the whole run — an operator hitting pause expects it to stop.
      const current = await Campaign.findById(locked._id)

      if (current.status === CAMPAIGN_STATUS.PAUSED) { stopReason = 'paused'; break }
      if (current.status === CAMPAIGN_STATUS.CANCELLED) { stopReason = 'cancelled'; break }

      const outcome = await processBatch({ campaign: current, provider, owner })

      if (outcome.throttled) {
        stopReason = `rate limited (${outcome.limitedBy})`
        break
      }

      if (outcome.claimed === 0) { stopReason = 'no recipients remaining'; break }

      totals.sent += outcome.sent
      totals.retried += outcome.retried
      totals.failed += outcome.failed
      totals.bounced += outcome.bounced
      totals.skipped += outcome.skipped
      totals.batches += 1

      // Kept current so the live dashboard reflects reality mid-run rather than
      // jumping at the end.
      await current.recomputeStats()

      onProgress?.({ ...totals, batch })

      // Refreshes the lock, so a long run is not mistaken for an abandoned one.
      await Campaign.updateOne({ _id: locked._id }, { $set: { lockedAt: new Date() } })
    }

    const finished = await Campaign.findById(locked._id)
    await finished.recomputeStats()

    const remaining = await CampaignRecipient.countDocuments({
      campaign: finished._id,
      status: RECIPIENT_STATUS.QUEUED,
    })

    // Completed only when nothing is left; a throttled campaign stays running so
    // the next drain picks it up.
    if (remaining === 0 && finished.status === CAMPAIGN_STATUS.RUNNING) {
      finished.status = CAMPAIGN_STATUS.COMPLETED
      finished.completedAt = new Date()
    }

    finished.lockedAt = null
    await finished.save()

    log.info('Campaign drain finished', {
      campaignId: finished._id.toString(),
      ...totals,
      remaining,
      stopReason,
      status: finished.status,
    })

    return { campaign: finished, ran: true, totals, remaining, stopReason }
  } catch (error) {
    await Campaign.updateOne(
      { _id: locked._id },
      {
        $set: {
          lockedAt: null,
          lastError: { message: error?.message ?? String(error), occurredAt: new Date() },
        },
      },
    )

    log.error('Campaign drain failed', {
      campaignId: locked._id.toString(),
      message: error?.message,
    })

    throw error
  }
}

export default { drainCampaign, processBatch, classifyFailure }
