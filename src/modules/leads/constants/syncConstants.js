/**
 * Workbook sync vocabulary.
 *
 * The sales team exports a fresh workbook every morning. Yesterday's had 5
 * rows, today's has 12 — 5 of which are the same enquiries. This module's whole
 * job is to tell those apart, and these are the words it uses to do it.
 *
 * Part of the API contract, so they must not be renamed once published.
 */

/**
 * What a workbook row turned out to be.
 *
 * The distinction between `updated` and `unchanged` is the point of the phase:
 * an import that re-saves every row cannot tell you what actually moved, and —
 * far worse — an import that cannot tell "new" from "seen before" would email
 * the same customer every single morning.
 */
export const ROW_CATEGORY = Object.freeze({
  /** The reference has never been seen. Create it, and mail them. */
  NEW: 'new',
  /** The reference exists and at least one compared field differs. Update only. */
  UPDATED: 'updated',
  /** The reference exists and nothing differs. Touch nothing. */
  UNCHANGED: 'unchanged',
  /** The row cannot become a lead. Reported, never guessed at. */
  INVALID: 'invalid',
})

export const ROW_CATEGORY_VALUES = Object.freeze(Object.values(ROW_CATEGORY))

export const ROW_CATEGORY_LABELS = Object.freeze({
  new: 'New',
  updated: 'Updated',
  unchanged: 'Unchanged',
  invalid: 'Invalid',
})

/**
 * The fields compared to decide `updated` versus `unchanged`.
 *
 * Deliberately a fixed list rather than "every field on the document". Derived
 * and internal fields — `updatedAt`, `sourceRow`, `importJob`, the CRM's own
 * `stage` — change for reasons that have nothing to do with what the sales team
 * typed, and comparing them would report every row as updated every morning.
 *
 * `stage` is excluded for a stronger reason: once the CRM is live the pipeline
 * is maintained here, not in the spreadsheet, and treating a stale sheet value
 * as a change would drag a lead backwards every day.
 */
export const COMPARED_FIELDS = Object.freeze([
  'contactPerson',
  'companyName',
  'email',
  'phones',
  'city',
  'travelDate',
  'travelDateText',
  'paxText',
  'adultCount',
  'childCount',
  'handledBy',
  'internalNotes',
  'quoteDate',
  'market',
])

/** Human labels for the change report. */
export const FIELD_LABELS = Object.freeze({
  contactPerson: 'Contact person',
  companyName: 'Company',
  email: 'Email',
  phones: 'Phone',
  city: 'City',
  travelDate: 'Travel date',
  travelDateText: 'Travel date (as written)',
  paxText: 'Pax',
  adultCount: 'Adults',
  childCount: 'Children',
  handledBy: 'Handled by',
  internalNotes: 'Remark',
  quoteDate: 'Query Date',
  market: 'Market',
  stage: 'Status',
})

// ---------------------------------------------------------------------------
// Automatic mail
// ---------------------------------------------------------------------------

/**
 * Whether the introductory email has gone out for a lead.
 *
 * Persisted on the lead rather than inferred from mail history, because the
 * question "has this customer already been written to" must be answerable
 * without scanning a mail collection, and must survive mail history being
 * cleared.
 */
export const AUTO_MAIL_STATUS = Object.freeze({
  /** Never attempted. */
  PENDING: 'pending',
  /** Sent. Never send again unless a human explicitly forces it. */
  SENT: 'sent',
  /** The provider rejected it. Retryable. */
  FAILED: 'failed',
  /** Deliberately not sent — no address, do-not-contact, or automation off. */
  SKIPPED: 'skipped',
})

export const AUTO_MAIL_STATUS_VALUES = Object.freeze(Object.values(AUTO_MAIL_STATUS))

/** Why a lead was not mailed. Shown in the import report. */
export const SKIP_REASON = Object.freeze({
  NOT_NEW: 'not_new',
  ALREADY_SENT: 'already_sent',
  NO_EMAIL: 'no_email',
  DO_NOT_CONTACT: 'do_not_contact',
  AUTOMATION_OFF: 'automation_off',
  NO_TEMPLATE: 'no_template',
  NO_MAILBOX: 'no_mailbox',
})

export const SKIP_REASON_LABELS = Object.freeze({
  not_new: 'Not a new lead',
  already_sent: 'Already emailed',
  no_email: 'No email address',
  do_not_contact: 'Marked do-not-contact',
  automation_off: 'Automatic mail was disabled for this run',
  no_template: 'No message template was configured',
  no_mailbox: 'No mailbox is connected',
})

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

/**
 * Rows applied per chunk.
 *
 * Smaller than the import engine's 250 because each new row here may also send
 * an email, and a chunk that holds the event loop through 250 network round
 * trips would stall every other request on the server.
 */
export const SYNC_CHUNK_SIZE = 100

/**
 * Pause between automatic sends, in milliseconds.
 *
 * Exchange Online starts throttling around 30 messages a minute. A morning
 * workbook with 120 new leads would trip that in seconds without a gap, and the
 * resulting backoff takes longer than pacing would have.
 */
export const AUTO_MAIL_INTERVAL_MS = 2100

/** Ceiling on automatic sends in one run, whatever the workbook contains. */
export const MAX_AUTO_MAILS_PER_RUN = 500

export default ROW_CATEGORY
