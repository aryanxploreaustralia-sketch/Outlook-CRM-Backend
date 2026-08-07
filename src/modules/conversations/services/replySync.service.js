/**
 * One run of the reply sync.
 *
 * ## Why this file exists at all
 *
 * Everything it calls already existed. `syncInbox` has fetched mail since Phase
 * 5, `matchInboundMessage` has tied replies to enquiries since Phase 9, and
 * `ingestBatch` has threaded and stored them just as long. What was missing was
 * anybody *calling* them without a human pressing a button.
 *
 * The obvious way to add a background worker would have been to give it its own
 * copy of the four steps `POST /conversations/sync` performs. That is how two
 * code paths that are supposed to be identical start drifting: a fix to the
 * manual one, six months later, that nobody thinks to make to the automatic
 * one. So the controller was changed to call this, and the worker calls this,
 * and there is exactly one description of what a sync is.
 *
 * ## What it does not do
 *
 * Match, classify, thread, advance a lead, or decide anything about a message.
 * It fetches, hands the batch to `ingestBatch`, drains the attachment queue and
 * reports. Every business decision belongs to the Phase 9 services it calls,
 * unchanged.
 */

import { User } from '../../../models/user.model.js'
import { createContextLogger } from '../../../utils/logger.js'
import { listSyncableMailboxes } from '../../provider/services/provider.service.js'
import { MESSAGE_DIRECTION, SYNC_BATCH_SIZE } from '../constants/conversationConstants.js'
import { processDownloadQueue } from './attachment.service.js'
import { ingestBatch } from './conversationSync.service.js'

const log = createContextLogger('reply-sync')

/**
 * Runs a reply sync for one workspace.
 *
 * @param {object}  params
 * @param {any}     params.owner              Workspace user id.
 * @param {object} [params.auth]              `req.auth` when a request drives this.
 * @param {boolean}[params.full]              Ignore the incremental cursor.
 * @param {boolean}[params.downloadAttachments]
 * @returns {Promise<{ ok, mockMode, total, created, duplicates, matched, unmatched, failed, downloads, errors }>}
 */
export async function runReplySync({
  owner,
  auth = null,
  full = false,
  downloadAttachments = true,
} = {}) {
  /**
   * The worker has no request, so it builds the same shape from the user.
   *
   * `resolveContext` reads `auth.user` and finds the mailbox itself — the same
   * trick the H2 workbook worker uses. Nothing about the provider layer had to
   * change to be reachable from a timer.
   */
  const context = auth ?? { user: await User.findById(owner) }

  if (!context.user) {
    return {
      ok: false,
      reason: 'no_owner',
      message: 'The owner of this workspace no longer exists.',
      total: 0,
      created: 0,
      duplicates: 0,
      matched: 0,
      unmatched: 0,
      failed: 0,
      downloads: null,
      errors: [],
    }
  }

  /**
   * Every mailbox the workspace has connected, not just one.
   *
   * ## What changed, and what deliberately did not
   *
   * This used to resolve a single mailbox and read its inbox. With several
   * connected, a reply arriving in `sales@…` would simply never be seen —
   * silently, because the run reported success having read `enquiry@…`.
   *
   * What changed is the *selection*: the loop below runs the existing sync once
   * per mailbox, each with that mailbox's own authorisation, so a reply is
   * always fetched by the mailbox it actually arrived in.
   *
   * What did not change is everything after the fetch. `ingestBatch` still
   * receives one batch at a time and still owns matching, threading, lead
   * advancement and notification, exactly as it has since Phase 9. Its
   * idempotency on `providerMessageId` is workspace-wide rather than
   * per-mailbox, which is what keeps duplicate protection intact when the same
   * message is visible from two mailboxes — a reply to a message that was
   * CC'd, for instance.
   */
  const mailboxes = await listSyncableMailboxes({ auth: context })

  /**
   * No mailbox is not an error.
   *
   * A workspace that has not connected Outlook yet has nothing to sync, and a
   * five-minute timer reporting that as a failure would fill the log with
   * stack traces and burn the retry budget on a condition only a human can fix.
   */
  if (mailboxes.length === 0) {
    return {
      ok: false,
      reason: 'no_mailbox',
      message: 'No Outlook mailbox is connected, so there were no replies to read.',
      mockMode: false,
      total: 0,
      created: 0,
      duplicates: 0,
      matched: 0,
      unmatched: 0,
      failed: 0,
      downloads: null,
      errors: [],
    }
  }

  const totals = { total: 0, created: 0, duplicates: 0, matched: 0, unmatched: 0, failed: 0 }
  const errors = []
  let anyMock = false
  let anySucceeded = false

  for (const { provider, mailbox, isMock } of mailboxes) {
    anyMock = anyMock || Boolean(isMock)

    try {
      const inbox = await provider.syncInbox({
        mailbox,
        pageSize: SYNC_BATCH_SIZE,
        mode: full ? 'full' : 'incremental',
      })

      /**
       * The ingestion. Idempotent on `providerMessageId`.
       *
       * This is what makes a replayed delta, an overlapping window, a restart
       * mid-run and a manual sync racing the timer all converge on the same
       * state rather than duplicating a customer's reply. It was built that way
       * in Phase 9; this phase relies on it and adds nothing to it.
       */
      const result = await ingestBatch({
        owner,
        messages: inbox?.messages ?? [],
        provider: provider.type,
        direction: MESSAGE_DIRECTION.INCOMING,
      })

      for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0
      anySucceeded = true
    } catch (error) {
      /**
       * One broken mailbox must not stop the others.
       *
       * A revoked grant on `enquiry@…` would otherwise abort the run before
       * `sales@…` was read, so a single mailbox nobody has got round to
       * reconnecting would silently stop the whole workspace's reply sync.
       */
      log.warn('A mailbox could not be synchronised', {
        mailboxId: mailbox._id.toString(),
        address: mailbox.emailAddress,
        error: error?.message,
      })

      errors.push({
        mailboxId: mailbox._id.toString(),
        address: mailbox.emailAddress ?? null,
        message: error?.message ?? 'The mailbox could not be read.',
      })
    }
  }

  /**
   * Attachments are fetched after the messages are safely stored.
   *
   * Deliberately second: a customer's reply must be on the lead even if the
   * 8 MB itinerary they attached times out. The queue retries the bytes; the
   * business fact is already recorded.
   *
   * Drained once for the workspace rather than once per mailbox, because the
   * queue is keyed on the owner and draining it repeatedly would have each pass
   * competing for the same rows.
   */
  let downloads = null
  if (downloadAttachments && anySucceeded) {
    try {
      downloads = await processDownloadQueue({ owner, provider: mailboxes[0].provider })
    } catch (error) {
      log.warn('The attachment queue could not be drained', { error: error?.message })
      downloads = { failed: true, error: error?.message }
    }
  }

  return {
    // A run in which every mailbox failed is a failure, so the scheduler's
    // backoff still engages. One failure among several is not.
    ok: anySucceeded,
    reason: anySucceeded ? null : 'all_mailboxes_failed',
    message:
      `${totals.created} message(s) ingested — ${totals.matched} matched to an enquiry, ` +
      `${totals.unmatched} awaiting triage` +
      (errors.length > 0 ? `, ${errors.length} mailbox(es) unavailable.` : '.'),
    mockMode: anyMock,
    ...totals,
    downloads,
    errors,
  }
}

export default { runReplySync }
