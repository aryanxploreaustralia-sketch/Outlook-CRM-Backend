/**
 * Reply CRM vocabulary.
 *
 * Part of the API contract — the conversation list, the thread view and the
 * activity timeline all match on these strings — so they must not be renamed
 * once published.
 */

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/**
 * Where a conversation stands.
 *
 * `awaiting_reply` and `awaiting_us` are the two that matter operationally:
 * they answer "who owes the next message", which is the question a sales
 * manager actually asks. A single `open` status cannot express it.
 */
export const CONVERSATION_STATUS = Object.freeze({
  /** We sent; the customer has not answered. */
  AWAITING_REPLY: 'awaiting_reply',
  /** The customer answered; the ball is with us. */
  AWAITING_US: 'awaiting_us',
  /** Being worked, with messages both ways. */
  OPEN: 'open',
  /** Finished — booked, lost, or simply done. */
  CLOSED: 'closed',
  /** Hidden from the working list without being deleted. */
  ARCHIVED: 'archived',
})

export const CONVERSATION_STATUS_VALUES = Object.freeze(Object.values(CONVERSATION_STATUS))

export const CONVERSATION_STATUS_LABELS = Object.freeze({
  awaiting_reply: 'Awaiting reply',
  awaiting_us: 'Needs a response',
  open: 'Open',
  closed: 'Closed',
  archived: 'Archived',
})

/** Statuses still on someone's plate. */
export const ACTIVE_CONVERSATION_STATUSES = Object.freeze([
  CONVERSATION_STATUS.AWAITING_REPLY,
  CONVERSATION_STATUS.AWAITING_US,
  CONVERSATION_STATUS.OPEN,
])

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const MESSAGE_DIRECTION = Object.freeze({
  INCOMING: 'incoming',
  OUTGOING: 'outgoing',
})

export const MESSAGE_DIRECTION_VALUES = Object.freeze(Object.values(MESSAGE_DIRECTION))

export const MESSAGE_IMPORTANCE = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
})

export const MESSAGE_IMPORTANCE_VALUES = Object.freeze(Object.values(MESSAGE_IMPORTANCE))

/** How a message got here, and whether it is fully materialised. */
export const MESSAGE_SYNC_STATUS = Object.freeze({
  /** Body and metadata present. */
  SYNCED: 'synced',
  /** Headers known, body not yet fetched. */
  PARTIAL: 'partial',
  /** The provider rejected the fetch. */
  FAILED: 'failed',
  /** Written by this CRM, not read from a mailbox. */
  LOCAL: 'local',
})

export const MESSAGE_SYNC_STATUS_VALUES = Object.freeze(Object.values(MESSAGE_SYNC_STATUS))

// ---------------------------------------------------------------------------
// Reply matching
// ---------------------------------------------------------------------------

/**
 * How an inbound message was tied back to a lead, strongest first.
 *
 * Stored on the conversation so a mis-match can be explained rather than
 * argued about. A match on `sender_email` is a far weaker claim than one on
 * `in_reply_to`, and the UI should be able to say so.
 */
export const MATCH_STRATEGY = Object.freeze({
  /** The In-Reply-To header names a message we sent. Unambiguous. */
  IN_REPLY_TO: 'in_reply_to',
  /** A References entry names a message we sent. Survives subject edits. */
  REFERENCES: 'references',
  /** The provider's own thread id matches. Reliable inside one mail system. */
  THREAD_ID: 'thread_id',
  /** The subject carries a lead reference such as XAMP01. */
  LEAD_REFERENCE: 'lead_reference',
  /** The sender is a known contact with exactly one open enquiry. */
  SENDER_SINGLE_LEAD: 'sender_single_lead',
  /** The sender is known, and the subject matches one of their enquiries. */
  SENDER_AND_SUBJECT: 'sender_and_subject',
  /** The sender is known but which enquiry is ambiguous. Needs a human. */
  SENDER_AMBIGUOUS: 'sender_ambiguous',
  /** Nothing matched. */
  UNMATCHED: 'unmatched',
})

export const MATCH_STRATEGY_VALUES = Object.freeze(Object.values(MATCH_STRATEGY))

export const MATCH_STRATEGY_LABELS = Object.freeze({
  in_reply_to: 'Reply header',
  references: 'Reference chain',
  thread_id: 'Mail thread',
  lead_reference: 'Reference in subject',
  sender_single_lead: 'Sender has one open enquiry',
  sender_and_subject: 'Sender and subject',
  sender_ambiguous: 'Sender known, enquiry unclear',
  unmatched: 'Unmatched',
})

/**
 * Confidence per strategy, 0–1.
 *
 * Used to decide whether a match may drive an automatic stage change. Anything
 * below `AUTO_ADVANCE_THRESHOLD` is recorded but never moves a lead on its own
 * — a guess should not silently rewrite the pipeline.
 */
export const MATCH_CONFIDENCE = Object.freeze({
  in_reply_to: 1,
  references: 0.95,
  thread_id: 0.9,
  lead_reference: 0.85,
  sender_single_lead: 0.7,
  sender_and_subject: 0.6,
  sender_ambiguous: 0.3,
  unmatched: 0,
})

/** Minimum confidence before a reply may advance a lead's stage by itself. */
export const AUTO_ADVANCE_THRESHOLD = 0.7

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/** Everything that can appear on a lead's timeline. */
export const ACTIVITY_TYPE = Object.freeze({
  LEAD_IMPORTED: 'lead_imported',
  CAMPAIGN_ADDED: 'campaign_added',
  MAIL_SENT: 'mail_sent',
  REPLY_RECEIVED: 'reply_received',
  FORWARD_RECEIVED: 'forward_received',
  AUTO_REPLY_RECEIVED: 'auto_reply_received',
  BOUNCE_RECEIVED: 'bounce_received',
  ATTACHMENT_ADDED: 'attachment_added',
  NOTE_ADDED: 'note_added',
  TASK_CREATED: 'task_created',
  TASK_COMPLETED: 'task_completed',
  FOLLOW_UP_SCHEDULED: 'follow_up_scheduled',
  FOLLOW_UP_DUE: 'follow_up_due',
  ASSIGNED: 'assigned',
  STATUS_CHANGED: 'status_changed',
  STAGE_CHANGED: 'stage_changed',
  CONVERSATION_MERGED: 'conversation_merged',
  SYNC_FAILED: 'sync_failed',
})

export const ACTIVITY_TYPE_VALUES = Object.freeze(Object.values(ACTIVITY_TYPE))

export const ACTIVITY_TYPE_LABELS = Object.freeze({
  lead_imported: 'Lead imported',
  campaign_added: 'Added to campaign',
  mail_sent: 'Mail sent',
  reply_received: 'Reply received',
  forward_received: 'Forwarded message received',
  auto_reply_received: 'Automatic reply received',
  bounce_received: 'Bounce received',
  attachment_added: 'Attachment added',
  note_added: 'Note added',
  task_created: 'Task created',
  task_completed: 'Task completed',
  follow_up_scheduled: 'Follow-up scheduled',
  follow_up_due: 'Follow-up due',
  assigned: 'Assigned',
  status_changed: 'Status changed',
  stage_changed: 'Stage changed',
  conversation_merged: 'Conversations merged',
  sync_failed: 'Sync failed',
})

// ---------------------------------------------------------------------------
// Tasks and follow-ups
// ---------------------------------------------------------------------------

/** Task kinds the travel desk actually raises. */
export const TASK_TYPE = Object.freeze({
  CALL_CUSTOMER: 'call_customer',
  PREPARE_QUOTATION: 'prepare_quotation',
  VISA_DOCUMENTS: 'visa_documents',
  PAYMENT_REMINDER: 'payment_reminder',
  ASSIGN_AGENT: 'assign_agent',
  SEND_ITINERARY: 'send_itinerary',
  CONFIRM_BOOKING: 'confirm_booking',
  FOLLOW_UP: 'follow_up',
  OTHER: 'other',
})

export const TASK_TYPE_VALUES = Object.freeze(Object.values(TASK_TYPE))

export const TASK_TYPE_LABELS = Object.freeze({
  call_customer: 'Call customer',
  prepare_quotation: 'Prepare quotation',
  visa_documents: 'Visa documents',
  payment_reminder: 'Payment reminder',
  assign_agent: 'Assign an agent',
  send_itinerary: 'Send itinerary',
  confirm_booking: 'Confirm booking',
  follow_up: 'Follow up',
  other: 'Other',
})

export const TASK_STATUS = Object.freeze({
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  CANCELLED: 'cancelled',
})

export const TASK_STATUS_VALUES = Object.freeze(Object.values(TASK_STATUS))

export const TASK_PRIORITY = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
})

export const TASK_PRIORITY_VALUES = Object.freeze(Object.values(TASK_PRIORITY))

/** The quick-pick follow-up intervals, in days. */
export const FOLLOW_UP_PRESETS = Object.freeze([
  { id: 'tomorrow', label: 'Tomorrow', days: 1 },
  { id: 'three_days', label: 'In 3 days', days: 3 },
  { id: 'one_week', label: 'In a week', days: 7 },
  { id: 'two_weeks', label: 'In 2 weeks', days: 14 },
])

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const ATTACHMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  DOWNLOADED: 'downloaded',
  FAILED: 'failed',
  /** Refused by policy — see `BLOCKED_ATTACHMENT_EXTENSIONS`. */
  BLOCKED: 'blocked',
  /** Too large to store; the metadata is kept so the row is not a mystery. */
  TOO_LARGE: 'too_large',
})

export const ATTACHMENT_STATUS_VALUES = Object.freeze(Object.values(ATTACHMENT_STATUS))

/**
 * Extensions never downloaded, whatever the sender claims the MIME type is.
 *
 * A travel agency exchanges PDFs, images and spreadsheets. Nothing in that
 * workflow needs an executable or a script, and storing one on the server —
 * then offering it for preview — turns a mailbox into a malware delivery path.
 */
export const BLOCKED_ATTACHMENT_EXTENSIONS = Object.freeze(
  new Set([
    'exe', 'com', 'bat', 'cmd', 'msi', 'scr', 'pif', 'cpl', 'jar', 'app',
    'vbs', 'vbe', 'js', 'jse', 'ws', 'wsf', 'wsh', 'ps1', 'psm1', 'sh',
    'reg', 'lnk', 'inf', 'hta', 'dll', 'sys', 'iso', 'img', 'msc', 'gadget',
  ]),
)

/** Types offered for in-browser preview. Everything else downloads. */
export const PREVIEWABLE_MIME_TYPES = Object.freeze(
  new Set([
    'application/pdf',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml',
    'text/plain', 'text/csv',
  ]),
)

/** Largest attachment stored, in bytes. Beyond this only metadata is kept. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Inbound messages examined per sync pass. */
export const SYNC_BATCH_SIZE = 200

/**
 * How far back a first conversation sync reaches.
 *
 * A mailbox may hold a decade of mail; rebuilding conversations from all of it
 * would take hours and surface enquiries closed years ago. Ninety days covers
 * every campaign this CRM has sent.
 */
export const INITIAL_SYNC_WINDOW_DAYS = 90

export default CONVERSATION_STATUS
