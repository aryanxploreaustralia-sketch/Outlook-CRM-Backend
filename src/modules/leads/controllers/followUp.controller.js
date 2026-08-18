/**
 * Follow-up controllers.
 *
 * Thin, like the rest of this codebase: parse, resolve the sending context,
 * call the service, record what happened. Every eligibility rule lives in
 * `followUp.service.js` and none of it is repeated here.
 */

import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import { resolveContext } from '../../provider/services/provider.service.js'
import { listFollowUpCandidates, sendFollowUps } from '../services/followUp.service.js'
import { SKIP_REASON_LABELS } from '../constants/followUpConstants.js'
import { followUpQuerySchema, followUpSendSchema } from '../validators/followUp.validator.js'

/** The register is per-user, exactly as everywhere else in this module. */
const ownerOf = (req) => req.auth.user._id

/**
 * GET /api/v1/leads/follow-up
 *
 * The queue of enquiries that were introduced and never answered.
 */
export const list = asyncHandler(async (req, res) => {
  const query = followUpQuerySchema.parse(req.query)

  return sendSuccess(res, {
    message: 'Follow-up candidates loaded.',
    data: await listFollowUpCandidates({ ...query, owner: ownerOf(req) }),
  })
})

/**
 * POST /api/v1/leads/follow-up/send
 *
 * Sends the follow-up to the named enquiries. Always explicit: there is no
 * scheduler behind this and nothing sends without a person pressing the button.
 *
 * Each lead is revalidated inside the service against its current state, so a
 * customer who replied while the composer was open is skipped rather than
 * chased — the check the brief asks for, made server-side because that is the
 * only place it can be trusted.
 */
export const send = asyncHandler(async (req, res) => {
  const { leadIds, subject, body } = followUpSendSchema.parse(req.body)

  // The same mailbox resolution the morning run and the manual resend use.
  const { provider, mailbox } = await resolveContext({ auth: req.auth, createIfMissing: true })

  const result = await sendFollowUps({
    owner: ownerOf(req),
    leadIds,
    subject,
    body,
    provider,
    mailbox,
    actor: req.auth.user,
    senderName: req.auth.user?.displayName ?? null,
  })

  /*
   * One audit entry per lead actually emailed, not one for the batch.
   *
   * A single "sent 8 follow-ups" line cannot answer the question an audit log
   * is opened with, which is always about one customer: was this person
   * emailed, when, by whom. Skips and failures are counted in the summary but
   * not logged individually — nothing happened to those leads.
   */
  for (const entry of result.results) {
    if (entry.outcome !== 'sent') continue

    await recordAudit({
      req,
      event: 'LEAD_FOLLOW_UP_SENT',
      summary: `Sent a follow-up to ${entry.email} for ${entry.reference}`,
      target: { id: entry.leadId, name: entry.reference },
      metadata: { reference: entry.reference, recipient: entry.email, subject },
    })
  }

  /*
   * The message names every outcome, and deliberately does not read as success
   * when part of the batch did not go out. "8 sent" beside a silent 2 skipped
   * is how an operator concludes everybody was emailed.
   */
  const parts = [`${result.sent} sent`]
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`)
  if (result.failed > 0) parts.push(`${result.failed} failed`)

  return sendSuccess(res, {
    message: parts.join(', ') + '.',
    data: {
      ...result,
      // Wording for each refusal, resolved here so the console does not keep a
      // second copy of the reason vocabulary.
      results: result.results.map((entry) =>
        entry.reason ? { ...entry, reasonLabel: SKIP_REASON_LABELS[entry.reason] ?? entry.reason } : entry,
      ),
    },
  })
})

export default { list, send }
