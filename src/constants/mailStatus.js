/**
 * Lifecycle states for an outbound message.
 *
 * Part of the API contract — the dashboard and the history filter both match on
 * these strings, so they must not be renamed once published.
 *
 * The set is deliberately small. `PENDING` exists as a real persisted state
 * rather than an in-memory one because the record is written *before* Microsoft
 * Graph is called: if the process dies mid-send, the row survives as evidence
 * that a send was attempted, instead of vanishing as though it never happened.
 */

export const MAIL_STATUS = Object.freeze({
  /** Composed but not submitted. Mirrors a real draft in the user's mailbox. */
  DRAFT: 'draft',
  /** Persisted, handed to Graph, outcome not yet known. */
  PENDING: 'pending',
  /** Graph accepted the message for delivery (HTTP 202). */
  SENT: 'sent',
  /** Graph rejected it, or the request never completed. */
  FAILED: 'failed',

  /**
   * The customer answered this message (Phase H4).
   *
   * A terminal state *after* `SENT`, never instead of it: a message only
   * reaches this by having been sent successfully first. Added rather than
   * tracked on a separate boolean so the history filter, which already matches
   * on these strings, can offer "replied" with no other change.
   *
   * Nothing downgrades a message back to `sent`. A second reply is more
   * conversation on a thread already known to have been answered.
   */
  REPLIED: 'replied',
})

export const MAIL_STATUS_VALUES = Object.freeze(Object.values(MAIL_STATUS))

/** Human-readable labels for API responses and the UI. */
export const MAIL_STATUS_LABELS = Object.freeze({
  [MAIL_STATUS.DRAFT]: 'Draft',
  [MAIL_STATUS.PENDING]: 'Pending',
  [MAIL_STATUS.SENT]: 'Sent',
  [MAIL_STATUS.FAILED]: 'Failed',
  [MAIL_STATUS.REPLIED]: 'Replied',
})

export default MAIL_STATUS
