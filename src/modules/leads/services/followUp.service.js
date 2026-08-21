/**
 * The follow-up queue, and sending from it.
 *
 * ## Reply detection is not implemented here
 *
 * `Lead.replyReceived` and `Lead.lastReplyAt` are maintained by
 * `conversations/services/leadWorkflow.service.js`, fed by the reply sync
 * worker and `replyMatching.service.js`. That matcher ranks `In-Reply-To`,
 * `References` and the provider thread key above any inference from the
 * sender's address, and refuses to guess between a contact's several open
 * enquiries. This module reads its conclusion and adds nothing to it.
 *
 * So a reply arriving through the existing sync removes a lead from this queue
 * with no code here running at all — the "automatic list update" the brief asks
 * for, which comes free from not duplicating the detector.
 *
 * ## The list is a suggestion; the send is the decision
 *
 * `listFollowUpCandidates` reports what looked eligible when it ran.
 * `sendFollowUps` re-checks every lead individually, against the document as it
 * stands at that instant, and skips any that no longer qualify. A customer who
 * replies while the composer is open is not chased.
 */

import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { Lead } from '../../../models/lead.model.js'
import { Mail } from '../../../models/mail.model.js'
import { User } from '../../../models/user.model.js'
import { AUTO_MAIL_STATUS } from '../constants/syncConstants.js'
import { MAIL_STATUS } from '../../../constants/mailStatus.js'
import {
  LEAD_STAGE_LABELS,
  MARKET_LABELS,
  MARKET_VALUES,
  TERMINAL_STAGES,
} from '../constants/leadConstants.js'
import {
  DEFAULT_FOLLOW_UP,
  FOLLOW_UP_MAX_SEQUENCE,
  FOLLOW_UP_STATUS,
  FOLLOW_UP_WAIT_DAYS,
  REPLY_STATUS,
  SKIP_REASON,
} from '../constants/followUpConstants.js'

const log = createContextLogger('lead-follow-up')

const DAY_MS = 86_400_000

/**
 * Whole days since the enquiry was quoted. The follow-up clock.
 *
 * ## Why `quoteDate` and not the introduction's send date
 *
 * The question this page answers is "how long has this customer been waiting
 * since we quoted them?" — a fact about the enquiry. The introduction's send
 * date is a fact about our automation, and the two diverge whenever a workbook
 * is imported late: a lead quoted three weeks ago and emailed this morning read
 * as one day old, so the enquiries most at risk of going cold sat at the bottom
 * of the queue.
 *
 * ## Why plain arithmetic is exact here
 *
 * `quoteDate` is a calendar date: the importer stores it at midnight UTC, and
 * every one of the 5,959 quoted enquiries on this deployment is stored that way.
 * With the left edge pinned to midnight, the floor of the raw difference *is*
 * the UTC calendar-day difference — 20 Aug → 23 Aug is 3 whether it is read at
 * 00:05 or 23:55 — so there is no off-by-one to correct and no need for a date
 * library the project does not have.
 *
 * @returns {?number} null when the enquiry carries no quote date, which is the
 *   only honest answer: nothing here invents one.
 */
export function daysSinceQuote(lead, now = new Date()) {
  if (!lead?.quoteDate) return null
  return Math.floor((now.getTime() - new Date(lead.quoteDate).getTime()) / DAY_MS)
}

/** The instant a quote must predate to have waited `days`. */
function quoteCutoff(days, now = new Date()) {
  return new Date(now.getTime() - days * DAY_MS)
}

/** Escapes a caller-supplied search term before it reaches a regex. */
function safePattern(term) {
  return new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

/**
 * The base query: introduced, unanswered, never chased, still contactable.
 *
 * Expressed once and reused by the list, the counts and the send path, so those
 * three cannot disagree about what "eligible" means — the failure that would
 * show a lead in the queue and then refuse to send to it with no explanation.
 */
export function eligibilityFilter({ owner, now = new Date() }) {
  return {
    owner,
    isDeleted: false,

    // The introduction actually went out. `failed`, `skipped` and `pending` are
    // all excluded: there is nothing to follow up on.
    'autoMail.status': AUTO_MAIL_STATUS.SENT,

    // Nobody answered. Maintained by the reply pipeline, not by this module.
    replyReceived: { $ne: true },

    /*
     * Quoted long enough ago to be a follow-up rather than a nudge.
     *
     * An enquiry with no `quoteDate` is never eligible, and needs no clause of
     * its own to say so: MongoDB brackets range operators by BSON type, so
     * `$lte: <Date>` does not match null or a missing field. Measured on this
     * deployment — 6,029 leads, 70 without a quote date, and the guarded and
     * unguarded counts agree exactly.
     */
    quoteDate: { $lte: quoteCutoff(FOLLOW_UP_WAIT_DAYS, now) },

    // At most one follow-up, ever. See `FOLLOW_UP_MAX_SEQUENCE`.
    'followUp.count': { $lt: FOLLOW_UP_MAX_SEQUENCE },

    doNotContact: { $ne: true },
    email: { $nin: [null, ''] },

    // A closed enquiry is a decision, not a silence.
    stage: { $nin: TERMINAL_STAGES },
  }
}

/** What the console shows for a lead's reply state. Derived, never stored. */
function replyStatusOf(lead) {
  if (lead.replyReceived) return REPLY_STATUS.REPLIED
  if (lead.autoMail?.status === AUTO_MAIL_STATUS.FAILED) return REPLY_STATUS.FAILED
  if (lead.autoMail?.status === AUTO_MAIL_STATUS.SKIPPED) return REPLY_STATUS.SKIPPED
  if (lead.autoMail?.status !== AUTO_MAIL_STATUS.SENT) return REPLY_STATUS.NOT_SENT
  return REPLY_STATUS.NO_REPLY
}

/** What the console shows for a lead's follow-up state. Derived. */
export function followUpStatusOf(lead, now = new Date()) {
  if ((lead.followUp?.count ?? 0) >= FOLLOW_UP_MAX_SEQUENCE) return FOLLOW_UP_STATUS.SENT
  if (replyStatusOf(lead) !== REPLY_STATUS.NO_REPLY) return FOLLOW_UP_STATUS.NOT_ELIGIBLE
  if (lead.doNotContact || !lead.email) return FOLLOW_UP_STATUS.NOT_ELIGIBLE
  if (TERMINAL_STAGES.includes(lead.stage)) return FOLLOW_UP_STATUS.NOT_ELIGIBLE

  // A follow-up follows something: without an introduction there is nothing to
  // follow up on, and `sendFollowUps` would refuse with `NO_INITIAL_EMAIL`.
  if (!lead.autoMail?.sentAt) return FOLLOW_UP_STATUS.NOT_ELIGIBLE

  // The clock, however, runs from the quote — see `daysSinceQuote`.
  const waited = daysSinceQuote(lead, now)
  if (waited === null) return FOLLOW_UP_STATUS.NOT_ELIGIBLE

  return waited >= FOLLOW_UP_WAIT_DAYS ? FOLLOW_UP_STATUS.ELIGIBLE : FOLLOW_UP_STATUS.WAITING
}

/** One row, shaped for the console. */
function toRow(lead, now, ownerName) {
  const sentAt = lead.autoMail?.sentAt ?? null

  return {
    leadId: String(lead._id),
    reference: lead.reference,
    customerName: lead.contactPerson,
    company: lead.companyName ?? null,
    email: lead.email ?? null,
    owner: ownerName ?? null,
    market: lead.market ?? null,
    /** The workbook's `Remark` column, for deciding whether to chase. */
    remarks: lead.internalNotes ?? null,
    marketLabel: MARKET_LABELS[lead.market] ?? lead.market ?? null,
    stage: lead.stage,
    stageLabel: LEAD_STAGE_LABELS[lead.stage] ?? lead.stage,
    /** Still reported, and still what the "Emailed from/to" filter narrows. */
    initialEmailSentAt: sentAt,
    initialEmailSubject: lead.autoMail?.subject ?? null,
    /** The reference date the follow-up clock runs from. */
    quoteDate: lead.quoteDate ?? null,
    /** Whole days since the quote. What the "Waiting" column shows. */
    waitingDays: daysSinceQuote(lead, now),
    lastEmailStatus: lead.autoMail?.status ?? null,
    replyStatus: replyStatusOf(lead),
    lastReplyAt: lead.lastReplyAt ?? null,
    followUpStatus: followUpStatusOf(lead, now),
    followUpCount: lead.followUp?.count ?? 0,
    lastFollowUpAt: lead.followUp?.lastSentAt ?? null,
  }
}

/**
 * One page of the follow-up queue, plus the standing counts.
 *
 * `replyStatus` widens the query beyond eligibility on purpose: an operator
 * checking "did that one ever answer?" should see the replied and failed rows
 * too, without a second screen. The default is the eligible set, because that
 * is what the page is for.
 */
export async function listFollowUpCandidates(query = {}) {
  const {
    owner,
    search,
    replyStatus,
    followUpStatus,
    market,
    minWaitingDays,
    from,
    to,
    page = 1,
    limit = 50,
  } = query

  const now = new Date()

  /*
   * Two shapes of query, and the distinction matters.
   *
   * The default is the eligibility filter — indexed, and the thing the page
   * exists to show. Asking for any other reply or follow-up state deliberately
   * drops out of it, because those rows are by definition *not* eligible and an
   * eligibility filter would return nothing at all.
   */
  const wantsOthers =
    (replyStatus && replyStatus !== REPLY_STATUS.NO_REPLY) ||
    (followUpStatus && followUpStatus !== FOLLOW_UP_STATUS.ELIGIBLE)

  const filter = wantsOthers
    ? { owner, isDeleted: false, 'autoMail.sentAt': { $ne: null } }
    : eligibilityFilter({ owner, now })

  if (wantsOthers) {
    if (replyStatus === REPLY_STATUS.REPLIED) filter.replyReceived = true
    if (replyStatus === REPLY_STATUS.FAILED) filter['autoMail.status'] = AUTO_MAIL_STATUS.FAILED
    if (replyStatus === REPLY_STATUS.SKIPPED) filter['autoMail.status'] = AUTO_MAIL_STATUS.SKIPPED
    if (followUpStatus === FOLLOW_UP_STATUS.SENT) filter['followUp.count'] = { $gte: 1 }
  }

  if (market?.length) filter.market = { $in: market }

  /*
   * The date window applies to the *introduction*, not to `createdAt`.
   *
   * "Leads I emailed last week that never answered" is the question this page
   * is opened with. Filtering on when the enquiry was created answers a
   * different one, and would quietly exclude an old lead emailed yesterday.
   */
  if (from || to) {
    const bounds = { ...(filter['autoMail.sentAt'] ?? {}) }
    if (from) bounds.$gte = new Date(`${from}T00:00:00.000Z`)
    if (to) bounds.$lte = new Date(`${to}T23:59:59.999Z`)
    filter['autoMail.sentAt'] = bounds
  }

  /*
   * "Waiting 5+ days" is a bound on the quote date, so it merges into that
   * clause rather than being computed per row afterwards — which would filter
   * the page instead of the register, and disagree with the counts.
   *
   * The narrower of the two bounds wins, so choosing 5+ on a queue whose floor
   * is already 3 tightens it rather than loosening it.
   */
  if (minWaitingDays) {
    const cutoff = quoteCutoff(Number(minWaitingDays), now)
    const bounds = { ...(filter.quoteDate ?? {}) }
    bounds.$lte = bounds.$lte && bounds.$lte < cutoff ? bounds.$lte : cutoff
    filter.quoteDate = bounds
  }

  if (search) {
    const pattern = safePattern(search)
    filter.$or = [
      { reference: pattern },
      { contactPerson: pattern },
      { companyName: pattern },
      { email: pattern },
    ]
  }

  const base = { owner, isDeleted: false, 'autoMail.status': AUTO_MAIL_STATUS.SENT }

  const [rows, total, eligible, replied, followedUp] = await Promise.all([
    Lead.find(filter)
      .select(
        'reference contactPerson companyName email market stage owner internalNotes quoteDate replyReceived lastReplyAt autoMail followUp',
      )
      // Longest wait first, measured from the quote: the enquiry closest to
      // going cold is the one that most needs a decision, and it is why the
      // page was opened.
      .sort({ quoteDate: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Lead.countDocuments(filter),
    Lead.countDocuments(eligibilityFilter({ owner, now })),
    Lead.countDocuments({ ...base, replyReceived: true }),
    Lead.countDocuments({ ...base, 'followUp.count': { $gte: 1 } }),
  ])

  // One lookup for the page's owners, not one per row.
  const ownerIds = [...new Set(rows.map((row) => String(row.owner)).filter(Boolean))]
  const owners = await User.find({ _id: { $in: ownerIds } }).select('displayName email').lean()
  const nameById = new Map(
    owners.map((user) => [String(user._id), user.displayName ?? user.email ?? 'Unknown user']),
  )

  return {
    items: rows.map((row) => toRow(row, now, nameById.get(String(row.owner)))),
    summary: { eligible, replied, followedUp, inView: total },
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrevious: page > 1,
    },
    meta: {
      waitDays: FOLLOW_UP_WAIT_DAYS,
      maxSequence: FOLLOW_UP_MAX_SEQUENCE,
      markets: MARKET_VALUES.map((value) => ({ value, label: MARKET_LABELS[value] ?? value })),
      defaultTemplate: DEFAULT_FOLLOW_UP,
    },
  }
}

/**
 * Re-checks one lead at send time.
 *
 * Deliberately a fresh read per lead rather than one bulk query taken before
 * the loop: a bulk read is a snapshot, and the entire point of this check is
 * that it happens as late as possible.
 *
 * @returns {{ ok: true, lead: object } | { ok: false, reason: string }}
 */
async function revalidate({ leadId, owner, now }) {
  const lead = await Lead.findOne({ _id: leadId, owner, isDeleted: false })

  if (!lead) return { ok: false, reason: SKIP_REASON.NOT_FOUND }
  if (lead.replyReceived) return { ok: false, reason: SKIP_REASON.REPLIED }
  if ((lead.followUp?.count ?? 0) >= FOLLOW_UP_MAX_SEQUENCE) {
    return { ok: false, reason: SKIP_REASON.ALREADY_SENT }
  }
  if (lead.autoMail?.status !== AUTO_MAIL_STATUS.SENT || !lead.autoMail?.sentAt) {
    return { ok: false, reason: SKIP_REASON.NO_INITIAL_EMAIL }
  }
  // Same clock as the queue. If these two disagreed, a row would offer itself
  // and then be refused with no explanation the reader could act on.
  const waited = daysSinceQuote(lead, now)
  if (waited === null || waited < FOLLOW_UP_WAIT_DAYS) {
    return { ok: false, reason: SKIP_REASON.TOO_SOON }
  }
  if (lead.doNotContact) return { ok: false, reason: SKIP_REASON.DO_NOT_CONTACT }
  if (!lead.email) return { ok: false, reason: SKIP_REASON.NO_EMAIL_ADDRESS }
  if (TERMINAL_STAGES.includes(lead.stage)) return { ok: false, reason: SKIP_REASON.CLOSED }

  return { ok: true, lead }
}

/**
 * Renders the follow-up for one lead.
 *
 * The same `{{...}}` vocabulary the introduction uses, resolved here rather
 * than through `renderForLead` because that helper renders a stored `Template`
 * document and this body is free text the operator typed into the composer.
 */
function render({ text, lead, senderName }) {
  const values = {
    customerName: lead.contactPerson ?? 'there',
    companyName: lead.companyName ?? '',
    reference: lead.reference ?? '',
    ownerName: senderName ?? '',
    senderName: senderName ?? '',
  }

  return String(text ?? '').replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    Object.hasOwn(values, key) ? values[key] : match,
  )
}

/** Plain text to minimal HTML, preserving the operator's paragraph breaks. */
function toHtml(text) {
  const escaped = String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll('\n', '<br />')}</p>`)
    .join('')

  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.6;color:#0f172a">${paragraphs}</div>`
}

/**
 * Sends the follow-up to each named lead, one at a time.
 *
 * Sequential rather than parallel, and that is not laziness. Every provider
 * meters sending, and a burst of thirty concurrent sends is how a mailbox gets
 * throttled — at which point the failures are indistinguishable from bad
 * addresses. It also keeps the per-lead revalidation genuinely late for every
 * lead rather than only for the first.
 *
 * @returns {{ requested: number, sent: number, skipped: number, failed: number, results: Array }}
 */
export async function sendFollowUps({
  owner,
  leadIds,
  subject,
  body,
  provider,
  mailbox,
  actor,
  senderName = null,
}) {
  if (!provider || !mailbox) {
    throw ApiError.forbidden(
      'No Microsoft mailbox is connected. Connect a mailbox from Account before sending.',
      { details: { reason: 'no_mailbox_connected' } },
    )
  }

  const now = new Date()
  const results = []
  let sent = 0
  let skipped = 0
  let failed = 0

  for (const leadId of leadIds) {
    const check = await revalidate({ leadId, owner, now })

    if (!check.ok) {
      skipped += 1
      results.push({ leadId: String(leadId), outcome: 'skipped', reason: check.reason })
      continue
    }

    const { lead } = check
    const renderedSubject = render({ text: subject, lead, senderName })
    const renderedBody = render({ text: body, lead, senderName })
    // Rendered once: the message that goes out and the message that is recorded
    // must be the same bytes, or the history is a description of something else.
    const bodyHtml = toHtml(renderedBody)

    try {
      const result = await provider.send(
        {
          to: [{ address: lead.email, name: lead.contactPerson ?? null }],
          subject: renderedSubject,
          bodyHtml,
        },
        { mailbox },
      )

      /*
       * The mail row is written in its own try/catch, for the reason
       * `sendIntroduction` documents at length: once the provider has accepted
       * the message the customer has been emailed, and no bookkeeping failure
       * afterwards can undo that. Reporting it as unsent would invite a second
       * send to the same person.
       */
      try {
        /*
         * The same shape `sendIntroduction` writes, field for field.
         *
         * `internetMessageId` and `conversationId` are the load-bearing ones,
         * and the reason this is not a looser record: `replyMatching` resolves
         * an inbound `In-Reply-To` against `Mail.internetMessageId` and the
         * thread key against `conversationId`. Omit them and a customer
         * answering *this* message falls through to a weaker matching strategy
         * or lands unmatched — so the follow-up would go out and its reply
         * would never take the lead back out of the queue.
         */
        await Mail.create({
          userId: owner,
          mailbox: mailbox?._id ?? null,
          provider: provider.type,
          from: mailbox?.emailAddress ?? null,
          to: [{ address: lead.email, name: lead.contactPerson ?? null }],
          subject: renderedSubject,
          html: bodyHtml,
          text: renderedBody,
          status: MAIL_STATUS.SENT,
          sentAt: now,
          graphRequestId: result?.correlationId ?? null,
          providerMessageId: result?.providerMessageId ?? null,
          internetMessageId: result?.internetMessageId ?? null,
          conversationId: result?.conversationId ?? null,
        })
      } catch (error) {
        log.warn(`Follow-up sent but the mail row failed for ${lead.reference}: ${error.message}`)
      }

      lead.followUp = lead.followUp ?? {}
      lead.followUp.count = (lead.followUp.count ?? 0) + 1
      lead.followUp.lastSentAt = now
      lead.followUp.lastSubject = renderedSubject
      lead.followUp.lastSentBy = actor?._id ?? null
      lead.lastContactedAt = now
      await lead.save()

      sent += 1
      results.push({
        leadId: String(lead._id),
        reference: lead.reference,
        email: lead.email,
        outcome: 'sent',
      })
    } catch (error) {
      failed += 1
      log.error(`Follow-up failed for ${lead.reference}: ${error.message}`)
      results.push({
        leadId: String(lead._id),
        reference: lead.reference,
        email: lead.email,
        outcome: 'failed',
        error: error.message,
      })
    }
  }

  return { requested: leadIds.length, sent, skipped, failed, results }
}

export default { listFollowUpCandidates, sendFollowUps }
