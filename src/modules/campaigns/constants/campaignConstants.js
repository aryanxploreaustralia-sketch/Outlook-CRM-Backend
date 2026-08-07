/**
 * Campaign engine vocabulary.
 *
 * Part of the API contract — the builder and the live dashboard both match on
 * these strings — so they must not be renamed once published.
 */

/** Campaign lifecycle. */
export const CAMPAIGN_STATUS = Object.freeze({
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  ARCHIVED: 'archived',
})

export const CAMPAIGN_STATUS_VALUES = Object.freeze(Object.values(CAMPAIGN_STATUS))

export const CAMPAIGN_STATUS_LABELS = Object.freeze({
  draft: 'Draft',
  scheduled: 'Scheduled',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  archived: 'Archived',
})

/** Statuses from which a campaign may still send. */
export const ACTIVE_STATUSES = Object.freeze([
  CAMPAIGN_STATUS.SCHEDULED,
  CAMPAIGN_STATUS.RUNNING,
  CAMPAIGN_STATUS.PAUSED,
])

/**
 * Per-recipient delivery state.
 *
 * Ordered as a progression: a recipient moves forward through these and never
 * back. `SKIPPED` is terminal and deliberate — a contact marked do-not-contact,
 * or one who already replied to an earlier step in the sequence.
 */
export const RECIPIENT_STATUS = Object.freeze({
  QUEUED: 'queued',
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  OPENED: 'opened',
  CLICKED: 'clicked',
  REPLIED: 'replied',
  FAILED: 'failed',
  BOUNCED: 'bounced',
  SKIPPED: 'skipped',
})

export const RECIPIENT_STATUS_VALUES = Object.freeze(Object.values(RECIPIENT_STATUS))

export const RECIPIENT_STATUS_LABELS = Object.freeze({
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  opened: 'Opened',
  clicked: 'Clicked',
  replied: 'Replied',
  failed: 'Failed',
  bounced: 'Bounced',
  skipped: 'Skipped',
})

/** Statuses meaning the recipient is finished with — no further work is owed. */
export const TERMINAL_RECIPIENT_STATUSES = Object.freeze([
  RECIPIENT_STATUS.REPLIED,
  RECIPIENT_STATUS.BOUNCED,
  RECIPIENT_STATUS.SKIPPED,
])

/** Every meaningful thing that can happen to a recipient, for the audit trail. */
export const CAMPAIGN_EVENT = Object.freeze({
  QUEUED: 'queued',
  SEND_ATTEMPTED: 'send_attempted',
  SENT: 'sent',
  DELIVERED: 'delivered',
  OPENED: 'opened',
  CLICKED: 'clicked',
  REPLIED: 'replied',
  BOUNCED: 'bounced',
  FAILED: 'failed',
  RETRY_SCHEDULED: 'retry_scheduled',
  SKIPPED: 'skipped',
  UNSUBSCRIBED: 'unsubscribed',
  SEQUENCE_ADVANCED: 'sequence_advanced',
  SEQUENCE_STOPPED: 'sequence_stopped',
})

export const CAMPAIGN_EVENT_VALUES = Object.freeze(Object.values(CAMPAIGN_EVENT))

/**
 * Why a send failed, in provider-independent terms.
 *
 * The distinction that matters is temporary versus permanent. Retrying a
 * mailbox-busy error succeeds; retrying an invalid address never does, and
 * doing so repeatedly is what gets a sending domain flagged as a spam source.
 */
export const FAILURE_KIND = Object.freeze({
  /** Provider is throttling. Retry after the stated interval. */
  RATE_LIMITED: 'rate_limited',
  /** Mailbox temporarily unavailable. Retry. */
  MAILBOX_BUSY: 'mailbox_busy',
  /** Network or provider outage. Retry. */
  TEMPORARY: 'temporary',
  /** The address is malformed or does not exist. Never retry. */
  INVALID_EMAIL: 'invalid_email',
  /** The sending mailbox is gone or unlicensed. Never retry on this mailbox. */
  MAILBOX_NOT_FOUND: 'mailbox_not_found',
  /** Recipient rejected permanently. Never retry. */
  PERMANENT: 'permanent',
  UNKNOWN: 'unknown',
})

export const FAILURE_KIND_VALUES = Object.freeze(Object.values(FAILURE_KIND))

/** Failures worth retrying. Anything else is terminal for that recipient. */
export const RETRYABLE_FAILURES = Object.freeze(
  new Set([FAILURE_KIND.RATE_LIMITED, FAILURE_KIND.MAILBOX_BUSY, FAILURE_KIND.TEMPORARY]),
)

/** Failures that mean the *sending mailbox* is unusable, not the recipient. */
export const MAILBOX_FAULTS = Object.freeze(
  new Set([FAILURE_KIND.MAILBOX_NOT_FOUND, FAILURE_KIND.MAILBOX_BUSY]),
)

/** Template categories offered by the library. */
export const TEMPLATE_CATEGORY = Object.freeze({
  TRAVEL_OFFER: 'travel_offer',
  FOLLOW_UP: 'follow_up',
  VISA: 'visa',
  QUOTATION: 'quotation',
  REMINDER: 'reminder',
  CUSTOM: 'custom',
})

export const TEMPLATE_CATEGORY_VALUES = Object.freeze(Object.values(TEMPLATE_CATEGORY))

export const TEMPLATE_CATEGORY_LABELS = Object.freeze({
  travel_offer: 'Travel Offers',
  follow_up: 'Follow-up',
  visa: 'Visa',
  quotation: 'Quotation',
  reminder: 'Reminder',
  custom: 'Custom',
})

/** How a recipient list was assembled. */
export const AUDIENCE_SOURCE = Object.freeze({
  MANUAL: 'manual',
  FILTER: 'filter',
  GROUP: 'group',
  TAG: 'tag',
  IMPORT: 'import',
  SAVED_LIST: 'saved_list',
  /**
   * Built from the lead register.
   *
   * The travel business targets enquiries, not an address book: "everyone at
   * the quoted stage travelling to Australia in March" is the real audience,
   * and it cannot be expressed as a contact filter.
   */
  LEADS: 'leads',
})

export const AUDIENCE_SOURCE_VALUES = Object.freeze(Object.values(AUDIENCE_SOURCE))

/** How a reply was classified. */
export const REPLY_KIND = Object.freeze({
  /** A genuine human reply. Stops the sequence. */
  REPLY: 'reply',
  REPLY_ALL: 'reply_all',
  FORWARD: 'forward',
  /**
   * An automatic out-of-office. Deliberately does NOT stop the sequence — the
   * person has not read the message, and treating it as engagement would drop
   * a live lead.
   */
  OUT_OF_OFFICE: 'out_of_office',
  /** Any other automated response, e.g. a ticketing acknowledgement. */
  AUTO_REPLY: 'auto_reply',
  BOUNCE: 'bounce',
})

export const REPLY_KIND_VALUES = Object.freeze(Object.values(REPLY_KIND))

/** Reply kinds that stop a follow-up sequence. */
export const SEQUENCE_STOPPING_REPLIES = Object.freeze(
  new Set([REPLY_KIND.REPLY, REPLY_KIND.REPLY_ALL, REPLY_KIND.FORWARD]),
)

// ---------------------------------------------------------------------------
// Throughput defaults
// ---------------------------------------------------------------------------

/**
 * Conservative sending limits.
 *
 * Exchange Online's published ceiling is 30 messages per minute and 10,000
 * recipients per day per mailbox. These sit well below that on purpose: the
 * published limit is where Microsoft *starts throttling*, and a campaign that
 * runs at the ceiling will spend most of its life in backoff. Sustained
 * moderate throughput delivers a large campaign sooner than bursting does.
 */
export const DEFAULT_RATE_LIMITS = Object.freeze({
  perMinute: 20,
  perHour: 500,
  perDay: 5000,
})

/** Absolute ceilings a user cannot configure past, whatever they type. */
export const MAX_RATE_LIMITS = Object.freeze({
  perMinute: 30,
  perHour: 3000,
  perDay: 10_000,
})

/** Recipients claimed per batch. */
export const DEFAULT_BATCH_SIZE = 25

export const MAX_BATCH_SIZE = 100

/** Attempts before a recipient is marked permanently failed. */
export const MAX_SEND_ATTEMPTS = 4

/**
 * Backoff schedule, in milliseconds.
 *
 * Deliberately long. A transient mailbox error usually resolves in minutes, not
 * seconds, and retrying aggressively against a throttled mailbox extends the
 * throttle rather than clearing it.
 */
export const RETRY_DELAYS_MS = Object.freeze([60_000, 300_000, 900_000])

/** Consecutive failures before a sending mailbox is taken out of rotation. */
export const MAILBOX_FAILURE_THRESHOLD = 3

/** How long an unhealthy mailbox stays out of rotation before being retried. */
export const MAILBOX_COOLDOWN_MS = 15 * 60 * 1000

/** Campaign priority. Higher runs first when several are eligible. */
export const CAMPAIGN_PRIORITY = Object.freeze({
  LOW: 0,
  NORMAL: 5,
  HIGH: 10,
  URGENT: 20,
})

export const CAMPAIGN_PRIORITY_VALUES = Object.freeze(Object.values(CAMPAIGN_PRIORITY))

export default CAMPAIGN_STATUS
