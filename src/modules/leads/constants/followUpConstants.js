/**
 * Follow-up: the second email, sent only when the first went unanswered.
 *
 * ## What this module does not decide
 *
 * Whether a customer replied. That question is already answered, and answered
 * well, by `conversations/services/replyMatching.service.js` — it ranks
 * `In-Reply-To`, `References` and the provider thread key above any inference
 * from the sender's address, and refuses to guess when a known contact has
 * several open enquiries. `Lead.replyReceived` is what that pipeline writes.
 *
 * Nothing here re-derives it. A second reply detector would be a second answer
 * to a question the product already answers, and the two would disagree.
 */

/**
 * How long a lead must go unanswered before a follow-up is offered.
 *
 * Three days, and deliberately not fewer. The initial mail goes out on the
 * morning workbook run, so a one-day window would chase somebody who received
 * the message yesterday afternoon — which reads as pestering rather than
 * service, and is the fastest way to be marked as spam by the recipient's own
 * filter.
 *
 * Calendar days, not business days. Business-day arithmetic needs a holiday
 * calendar to be correct, and this deployment sells to two countries with
 * different ones; an approximation that quietly slips a day is worse than an
 * honest three.
 */
export const FOLLOW_UP_WAIT_DAYS = 3

/**
 * How long after a follow-up before the same lead may be chased again.
 *
 * Seven days, and it only matters if a later phase enables a second follow-up.
 * Today the eligibility query requires `followUp.count === 0`, so one lead
 * receives at most one follow-up — see `FOLLOW_UP_MAX_SEQUENCE`.
 */
export const FOLLOW_UP_COOLDOWN_DAYS = 7

/**
 * How many follow-ups one lead may ever receive.
 *
 * One. The brief is explicit that this must not become an automated sequence,
 * and the honest way to hold that line is a constant the query reads rather
 * than a convention somebody has to remember. `followUp.count` is stored as a
 * number precisely so raising this later needs no migration.
 */
export const FOLLOW_UP_MAX_SEQUENCE = 1

/** Reply state, as reported to the console. Derived, never stored. */
export const REPLY_STATUS = Object.freeze({
  REPLIED: 'replied',
  NO_REPLY: 'no_reply',
  /** The provider rejected the initial send. Not a bounce — see below. */
  FAILED: 'failed',
  /** Deliberately never sent: no address, do-not-contact, automation off. */
  SKIPPED: 'skipped',
  /** The initial introduction has not gone out yet. */
  NOT_SENT: 'not_sent',
})

/**
 * Follow-up state, as reported to the console. Derived from the lead.
 *
 * There is no `scheduled`. Nothing here schedules anything: a follow-up is sent
 * when a person selects a lead and confirms, which is the whole design.
 */
export const FOLLOW_UP_STATUS = Object.freeze({
  ELIGIBLE: 'eligible',
  /** Sent already, and at the sequence ceiling. */
  SENT: 'sent',
  /** Would be eligible, but the waiting period has not elapsed. */
  WAITING: 'waiting',
  NOT_ELIGIBLE: 'not_eligible',
})

/**
 * Why a lead was refused at send time.
 *
 * Every one of these is re-checked on the server against the lead as it stands
 * at that instant, not as it stood when the list was drawn. The list is a
 * suggestion; this is the decision.
 */
export const SKIP_REASON = Object.freeze({
  REPLIED: 'replied',
  ALREADY_SENT: 'already_sent',
  TOO_SOON: 'too_soon',
  NO_INITIAL_EMAIL: 'no_initial_email',
  NO_EMAIL_ADDRESS: 'no_email_address',
  DO_NOT_CONTACT: 'do_not_contact',
  CLOSED: 'closed',
  NOT_FOUND: 'not_found',
})

/** Human wording for each refusal, so the console does not map these itself. */
export const SKIP_REASON_LABELS = Object.freeze({
  [SKIP_REASON.REPLIED]: 'The customer has replied since this list was loaded',
  [SKIP_REASON.ALREADY_SENT]: 'A follow-up has already been sent',
  [SKIP_REASON.TOO_SOON]: 'The waiting period has not elapsed',
  [SKIP_REASON.NO_INITIAL_EMAIL]: 'No introduction was ever sent',
  [SKIP_REASON.NO_EMAIL_ADDRESS]: 'The enquiry has no email address',
  [SKIP_REASON.DO_NOT_CONTACT]: 'The customer has opted out',
  [SKIP_REASON.CLOSED]: 'The enquiry is closed',
  [SKIP_REASON.NOT_FOUND]: 'That enquiry no longer exists',
})

/**
 * The default follow-up wording.
 *
 * Deliberately short, and deliberately not a sales push. The recipient already
 * has the first message; this one exists to make replying easy, so it asks one
 * question and offers help. Variables use the same `{{...}}` vocabulary the
 * template engine already renders for the introduction.
 */
export const DEFAULT_FOLLOW_UP = Object.freeze({
  subject: 'Just checking in — are you still interested?',
  body: `Hi {{customerName}},

I wanted to follow up on my previous email and check whether you're still interested in exploring this opportunity.

If you have any questions, need additional information, or would like us to assist with anything, please feel free to let me know.

I'd be happy to help.

Best regards,
{{senderName}}`,
})

export default {
  FOLLOW_UP_WAIT_DAYS,
  FOLLOW_UP_COOLDOWN_DAYS,
  FOLLOW_UP_MAX_SEQUENCE,
  REPLY_STATUS,
  FOLLOW_UP_STATUS,
  SKIP_REASON,
  SKIP_REASON_LABELS,
  DEFAULT_FOLLOW_UP,
}
