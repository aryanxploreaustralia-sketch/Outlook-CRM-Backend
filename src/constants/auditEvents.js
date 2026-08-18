/**
 * The audit event registry.
 *
 * One place where every recordable event is declared, and the only place an
 * event name is written down. `recordAudit()` refuses a key that is not here, so
 * a typo at a call site is a loud failure in development rather than an entry
 * nobody can filter for.
 *
 * ## Why a registry rather than free-text actions
 *
 * An audit log is only useful if it can be *queried*. Free-text actions produce
 * `campaign.start`, `campaign.started` and `CAMPAIGN_START` in three modules,
 * and the filter that finds the first misses the other two — which reads as
 * "that never happened". Declaring the catalogue makes the filter list
 * derivable and makes coverage measurable.
 *
 * ## Each event declares its own metadata
 *
 * Category, label and default entity type live with the event, not at the call
 * site. That is what lets the console build its category filter, its action
 * filter and its labels from the server's own definitions instead of a second
 * copy in React that drifts the first time an event is renamed.
 *
 * ## `severity` is about attention, not danger
 *
 * `notice` is the ordinary business action. `warning` is something an operator
 * would want to notice — a permission refused, a disconnection. `critical` is
 * the small set that changes who can do what, or destroys data. The console
 * sorts and colours by it; nothing in the backend behaves differently.
 */

/** Event categories. The console's primary filter. */
export const AUDIT_CATEGORY = Object.freeze({
  AUTH: 'auth',
  USER: 'user',
  ROLE: 'role',
  MAILBOX: 'mailbox',
  CAMPAIGN: 'campaign',
  LEAD: 'lead',
  COMPANY: 'company',
  CONTACT: 'contact',
  WORKBOOK: 'workbook',
  TEMPLATE: 'template',
  SCHEDULER: 'scheduler',
  SYSTEM: 'system',
  ORGANIZATION: 'organization',
  NOTIFICATION: 'notification',
  /** Phase 18. Assigned work and the targets set against it. */
  TASK: 'task',
  GOAL: 'goal',
})

export const AUDIT_CATEGORY_VALUES = Object.freeze(Object.values(AUDIT_CATEGORY))

export const AUDIT_CATEGORY_LABELS = Object.freeze({
  [AUDIT_CATEGORY.AUTH]: 'Authentication',
  [AUDIT_CATEGORY.USER]: 'Users',
  [AUDIT_CATEGORY.ROLE]: 'Roles',
  [AUDIT_CATEGORY.MAILBOX]: 'Mailboxes',
  [AUDIT_CATEGORY.CAMPAIGN]: 'Campaigns',
  [AUDIT_CATEGORY.LEAD]: 'Enquiries',
  [AUDIT_CATEGORY.COMPANY]: 'Companies',
  [AUDIT_CATEGORY.CONTACT]: 'Contacts',
  [AUDIT_CATEGORY.WORKBOOK]: 'Workbooks',
  [AUDIT_CATEGORY.TEMPLATE]: 'Templates',
  [AUDIT_CATEGORY.SCHEDULER]: 'Scheduler',
  [AUDIT_CATEGORY.SYSTEM]: 'System',
  [AUDIT_CATEGORY.ORGANIZATION]: 'Organization',
  [AUDIT_CATEGORY.NOTIFICATION]: 'Notifications',
  [AUDIT_CATEGORY.TASK]: 'Tasks',
  [AUDIT_CATEGORY.GOAL]: 'Goals',
})

/** What the action was performed on. Drives the entity filter and deep links. */
export const AUDIT_ENTITY = Object.freeze({
  USER: 'user',
  SESSION: 'session',
  MAILBOX: 'mailbox',
  CAMPAIGN: 'campaign',
  LEAD: 'lead',
  COMPANY: 'company',
  CONTACT: 'contact',
  TEMPLATE: 'template',
  IMPORT_JOB: 'importJob',
  SCHEDULER: 'scheduler',
  SYSTEM: 'system',
  NOTIFICATION: 'notification',
  TASK: 'task',
  GOAL: 'goal',
})

export const AUDIT_ENTITY_VALUES = Object.freeze(Object.values(AUDIT_ENTITY))

/** Outcome. Stored on every entry so a filter can find only what failed. */
export const AUDIT_RESULT = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  DENIED: 'denied',
})

export const AUDIT_RESULT_VALUES = Object.freeze(Object.values(AUDIT_RESULT))

export const AUDIT_SEVERITY = Object.freeze({
  NOTICE: 'notice',
  WARNING: 'warning',
  CRITICAL: 'critical',
})

export const AUDIT_SEVERITY_VALUES = Object.freeze(Object.values(AUDIT_SEVERITY))

const { AUTH, USER, ROLE, MAILBOX, CAMPAIGN, LEAD, COMPANY, CONTACT, WORKBOOK, TEMPLATE, SCHEDULER, SYSTEM, ORGANIZATION, NOTIFICATION, TASK, GOAL } = AUDIT_CATEGORY
const { NOTICE, WARNING, CRITICAL } = AUDIT_SEVERITY

/**
 * Every recordable event.
 *
 * The key is what call sites reference (`AUDIT_EVENT.USER_INVITED`). The
 * `action` is what is stored and queried — dotted and lowercase, matching the
 * six actions that already exist in the collection so nothing written before
 * this phase becomes unfilterable.
 *
 * @type {Readonly<Record<string, { action: string, category: string, label: string,
 *   entityType?: string, severity: string }>>}
 */
export const AUDIT_EVENTS = Object.freeze({
  // --- Authentication ------------------------------------------------------
  GOOGLE_LOGIN: { action: 'auth.google_login', category: AUTH, label: 'Signed in with Google', entityType: AUDIT_ENTITY.SESSION, severity: NOTICE },
  GOOGLE_LOGOUT: { action: 'auth.google_logout', category: AUTH, label: 'Signed out', entityType: AUDIT_ENTITY.SESSION, severity: NOTICE },
  /**
   * Phase 14.8B. Administrator sign-in through Microsoft.
   *
   * `critical` rather than `notice`, unlike the Google employee sign-in: this
   * one only ever succeeds for an account that holds admin-portal access, so
   * every entry is somebody entering the console.
   */
  MICROSOFT_LOGIN: { action: 'auth.microsoft_login', category: AUTH, label: 'Signed in with Microsoft (admin)', entityType: AUDIT_ENTITY.SESSION, severity: CRITICAL },
  LOGIN_FAILED: { action: 'auth.login_failed', category: AUTH, label: 'Sign-in failed', entityType: AUDIT_ENTITY.SESSION, severity: WARNING },
  PERMISSION_DENIED: { action: 'auth.permission_denied', category: AUTH, label: 'Permission denied', entityType: AUDIT_ENTITY.SYSTEM, severity: WARNING },

  // --- Users ---------------------------------------------------------------
  USER_INVITED: { action: 'user.invited', category: USER, label: 'Invited a user', entityType: AUDIT_ENTITY.USER, severity: CRITICAL },
  USER_ACTIVATED: { action: 'user.activated', category: USER, label: 'Activated a user', entityType: AUDIT_ENTITY.USER, severity: CRITICAL },
  USER_SUSPENDED: { action: 'user.suspended', category: USER, label: 'Suspended a user', entityType: AUDIT_ENTITY.USER, severity: CRITICAL },
  /**
   * Phase 15.2. A soft delete — the document is retained in full and every
   * lead, campaign and audit entry that references it stays intact. What the
   * person loses is access.
   */
  USER_DELETED: { action: 'user.deleted', category: USER, label: 'Deleted a user', entityType: AUDIT_ENTITY.USER, severity: CRITICAL },
  USER_RESTORED: { action: 'user.restored', category: USER, label: 'Restored a user', entityType: AUDIT_ENTITY.USER, severity: CRITICAL },
  /**
   * Phase 17.1. A statement an administrator made about a named person's
   * identity evidence — the kind of decision somebody asks about later.
   */
  USER_DOCUMENT_VERIFIED: { action: 'user.document_verified', category: USER, label: 'Verified a document', entityType: AUDIT_ENTITY.USER, severity: NOTICE },
  USER_DOCUMENT_REJECTED: { action: 'user.document_rejected', category: USER, label: 'Rejected a document', entityType: AUDIT_ENTITY.USER, severity: WARNING },

  // --- Roles ---------------------------------------------------------------
  ROLE_CHANGED: { action: 'role.changed', category: ROLE, label: "Changed a user's role", entityType: AUDIT_ENTITY.USER, severity: CRITICAL },
  ROLE_PERMISSIONS_UPDATED: { action: 'role.permissions_updated', category: ROLE, label: 'Changed a role definition', entityType: AUDIT_ENTITY.SYSTEM, severity: CRITICAL },

  // --- Mailboxes -----------------------------------------------------------
  MAILBOX_CONNECTED: { action: 'mailbox.connected', category: MAILBOX, label: 'Connected a mailbox', entityType: AUDIT_ENTITY.MAILBOX, severity: CRITICAL },
  MAILBOX_DISCONNECTED: { action: 'mailbox.disconnected', category: MAILBOX, label: 'Disconnected a mailbox', entityType: AUDIT_ENTITY.MAILBOX, severity: CRITICAL },
  MICROSOFT_CONNECTED: { action: 'mailbox.microsoft_connected', category: MAILBOX, label: 'Authorised Microsoft', entityType: AUDIT_ENTITY.MAILBOX, severity: CRITICAL },
  MAILBOX_ASSIGNED: { action: 'mailbox.assigned', category: MAILBOX, label: 'Assigned a mailbox', entityType: AUDIT_ENTITY.MAILBOX, severity: CRITICAL },
  MAILBOX_UNASSIGNED: { action: 'mailbox.unassigned', category: MAILBOX, label: 'Removed mailbox access', entityType: AUDIT_ENTITY.MAILBOX, severity: CRITICAL },
  DEFAULT_MAILBOX_CHANGED: { action: 'mailbox.default_changed', category: MAILBOX, label: 'Changed a default mailbox', entityType: AUDIT_ENTITY.MAILBOX, severity: NOTICE },

  // --- Campaigns -----------------------------------------------------------
  CAMPAIGN_CREATED: { action: 'campaign.created', category: CAMPAIGN, label: 'Created a campaign', entityType: AUDIT_ENTITY.CAMPAIGN, severity: NOTICE },
  CAMPAIGN_UPDATED: { action: 'campaign.updated', category: CAMPAIGN, label: 'Updated a campaign', entityType: AUDIT_ENTITY.CAMPAIGN, severity: NOTICE },
  CAMPAIGN_STARTED: { action: 'campaign.started', category: CAMPAIGN, label: 'Started a campaign', entityType: AUDIT_ENTITY.CAMPAIGN, severity: CRITICAL },
  CAMPAIGN_PAUSED: { action: 'campaign.paused', category: CAMPAIGN, label: 'Paused a campaign', entityType: AUDIT_ENTITY.CAMPAIGN, severity: NOTICE },
  CAMPAIGN_COMPLETED: { action: 'campaign.completed', category: CAMPAIGN, label: 'Completed a campaign', entityType: AUDIT_ENTITY.CAMPAIGN, severity: NOTICE },
  CAMPAIGN_DELETED: { action: 'campaign.deleted', category: CAMPAIGN, label: 'Deleted a campaign', entityType: AUDIT_ENTITY.CAMPAIGN, severity: CRITICAL },

  // --- Enquiries -----------------------------------------------------------
  LEAD_CREATED: { action: 'lead.created', category: LEAD, label: 'Created an enquiry', entityType: AUDIT_ENTITY.LEAD, severity: NOTICE },
  LEAD_UPDATED: { action: 'lead.updated', category: LEAD, label: 'Updated an enquiry', entityType: AUDIT_ENTITY.LEAD, severity: NOTICE },
  LEAD_DELETED: { action: 'lead.deleted', category: LEAD, label: 'Deleted an enquiry', entityType: AUDIT_ENTITY.LEAD, severity: CRITICAL },
  LEAD_IMPORTED: { action: 'lead.imported', category: LEAD, label: 'Imported enquiries', entityType: AUDIT_ENTITY.LEAD, severity: NOTICE },
  /**
   * Pre-existing. Written before this phase with exactly this action string, so
   * it is declared with the same value rather than renamed — renaming would
   * orphan every entry already in the collection.
   */
  LEADS_BULK_DELETE: { action: 'leads.bulk_delete', category: LEAD, label: 'Deleted all enquiries', entityType: AUDIT_ENTITY.LEAD, severity: CRITICAL },

  // --- Directory -----------------------------------------------------------
  COMPANY_CREATED: { action: 'company.created', category: COMPANY, label: 'Created a company', entityType: AUDIT_ENTITY.COMPANY, severity: NOTICE },
  COMPANY_UPDATED: { action: 'company.updated', category: COMPANY, label: 'Updated a company', entityType: AUDIT_ENTITY.COMPANY, severity: NOTICE },
  COMPANY_DELETED: { action: 'company.deleted', category: COMPANY, label: 'Deleted a company', entityType: AUDIT_ENTITY.COMPANY, severity: CRITICAL },
  CONTACT_CREATED: { action: 'contact.created', category: CONTACT, label: 'Created a contact', entityType: AUDIT_ENTITY.CONTACT, severity: NOTICE },
  CONTACT_UPDATED: { action: 'contact.updated', category: CONTACT, label: 'Updated a contact', entityType: AUDIT_ENTITY.CONTACT, severity: NOTICE },
  CONTACT_DELETED: { action: 'contact.deleted', category: CONTACT, label: 'Deleted a contact', entityType: AUDIT_ENTITY.CONTACT, severity: CRITICAL },

  // --- Workbooks -----------------------------------------------------------
  WORKBOOK_IMPORTED: { action: 'workbook.imported', category: WORKBOOK, label: 'Imported a workbook', entityType: AUDIT_ENTITY.IMPORT_JOB, severity: NOTICE },
  WORKBOOK_VALIDATED: { action: 'workbook.validated', category: WORKBOOK, label: 'Validated a workbook', entityType: AUDIT_ENTITY.IMPORT_JOB, severity: NOTICE },
  WORKBOOK_SEND_STARTED: { action: 'workbook.send_started', category: WORKBOOK, label: 'Started a workbook send', entityType: AUDIT_ENTITY.IMPORT_JOB, severity: CRITICAL },
  WORKBOOK_SEND_COMPLETED: { action: 'workbook.send_completed', category: WORKBOOK, label: 'Completed a workbook send', entityType: AUDIT_ENTITY.IMPORT_JOB, severity: NOTICE },

  // --- Templates -----------------------------------------------------------
  TEMPLATE_CREATED: { action: 'template.created', category: TEMPLATE, label: 'Created a template', entityType: AUDIT_ENTITY.TEMPLATE, severity: NOTICE },
  TEMPLATE_UPDATED: { action: 'template.updated', category: TEMPLATE, label: 'Updated a template', entityType: AUDIT_ENTITY.TEMPLATE, severity: NOTICE },
  TEMPLATE_DELETED: { action: 'template.deleted', category: TEMPLATE, label: 'Deleted a template', entityType: AUDIT_ENTITY.TEMPLATE, severity: CRITICAL },
  TEMPLATE_ACTIVATED: { action: 'template.activated', category: TEMPLATE, label: 'Made a template active', entityType: AUDIT_ENTITY.TEMPLATE, severity: CRITICAL },

  // --- Scheduler (pre-existing action strings, preserved) ------------------
  SCHEDULER_ENABLED: { action: 'scheduler.enabled', category: SCHEDULER, label: 'Enabled the morning scheduler', entityType: AUDIT_ENTITY.SCHEDULER, severity: CRITICAL },
  SCHEDULER_DISABLED: { action: 'scheduler.disabled', category: SCHEDULER, label: 'Disabled the morning scheduler', entityType: AUDIT_ENTITY.SCHEDULER, severity: CRITICAL },
  SCHEDULER_UPDATED: { action: 'scheduler.updated', category: SCHEDULER, label: 'Changed the scheduler settings', entityType: AUDIT_ENTITY.SCHEDULER, severity: NOTICE },
  SCHEDULER_RUN_NOW: { action: 'scheduler.run_now', category: SCHEDULER, label: 'Ran the scheduler manually', entityType: AUDIT_ENTITY.SCHEDULER, severity: CRITICAL },
  REPLY_SYNC_RUN_NOW: { action: 'reply_sync.run_now', category: SCHEDULER, label: 'Synced replies manually', entityType: AUDIT_ENTITY.SCHEDULER, severity: NOTICE },

  // --- Tasks and goals (Phase 18) ------------------------------------------
  //
  // `NOTICE` throughout, with one exception. Assigning work is ordinary
  // management, not a privileged act — logging it as critical would bury the
  // role changes and mailbox grants that genuinely are. Deletion is the
  // exception: it removes evidence of what somebody was asked to do.
  TASK_CREATED: { action: 'task.created', category: TASK, label: 'Created a task', entityType: AUDIT_ENTITY.TASK, severity: NOTICE },
  TASK_ASSIGNED: { action: 'task.assigned', category: TASK, label: 'Assigned a task', entityType: AUDIT_ENTITY.TASK, severity: NOTICE },
  TASK_UPDATED: { action: 'task.updated', category: TASK, label: 'Updated a task', entityType: AUDIT_ENTITY.TASK, severity: NOTICE },
  TASK_STATUS_CHANGED: { action: 'task.status_changed', category: TASK, label: 'Changed a task status', entityType: AUDIT_ENTITY.TASK, severity: NOTICE },
  TASK_COMPLETED: { action: 'task.completed', category: TASK, label: 'Completed a task', entityType: AUDIT_ENTITY.TASK, severity: NOTICE },
  TASK_COMMENTED: { action: 'task.commented', category: TASK, label: 'Commented on a task', entityType: AUDIT_ENTITY.TASK, severity: NOTICE },
  TASK_ATTACHMENT_ADDED: { action: 'task.attachment_added', category: TASK, label: 'Attached a file to a task', entityType: AUDIT_ENTITY.TASK, severity: NOTICE },
  TASK_DELETED: { action: 'task.deleted', category: TASK, label: 'Deleted a task', entityType: AUDIT_ENTITY.TASK, severity: CRITICAL },

  GOAL_CREATED: { action: 'goal.created', category: GOAL, label: 'Set a goal', entityType: AUDIT_ENTITY.GOAL, severity: NOTICE },
  GOAL_UPDATED: { action: 'goal.updated', category: GOAL, label: 'Changed a goal', entityType: AUDIT_ENTITY.GOAL, severity: NOTICE },
  GOAL_DELETED: { action: 'goal.deleted', category: GOAL, label: 'Removed a goal', entityType: AUDIT_ENTITY.GOAL, severity: WARNING },
  GOAL_ACHIEVED: { action: 'goal.achieved', category: GOAL, label: 'Achieved a goal', entityType: AUDIT_ENTITY.GOAL, severity: NOTICE },

  // --- Organization and system ---------------------------------------------
  ORGANIZATION_UPDATED: { action: 'organization.updated', category: ORGANIZATION, label: 'Updated organization settings', entityType: AUDIT_ENTITY.SYSTEM, severity: CRITICAL },
  SYSTEM_ERROR: { action: 'system.error', category: SYSTEM, label: 'System error', entityType: AUDIT_ENTITY.SYSTEM, severity: WARNING },
  NOTIFICATION_SENT: { action: 'notification.sent', category: NOTIFICATION, label: 'Sent a notification', entityType: AUDIT_ENTITY.NOTIFICATION, severity: NOTICE },
})

/** Registry keys, e.g. `USER_INVITED`. What call sites pass. */
export const AUDIT_EVENT_KEYS = Object.freeze(Object.keys(AUDIT_EVENTS))

/** Stored action strings, e.g. `user.invited`. What is queried and indexed. */
export const AUDIT_ACTION_VALUES = Object.freeze(
  Object.values(AUDIT_EVENTS).map((event) => event.action),
)

/** `action` → definition. The lookup the reader and the DTO use. */
export const AUDIT_ACTION_INDEX = Object.freeze(
  Object.fromEntries(Object.values(AUDIT_EVENTS).map((event) => [event.action, event])),
)

/** `action` → human label, for a log a non-engineer can read. */
export const AUDIT_ACTION_LABELS = Object.freeze(
  Object.fromEntries(Object.values(AUDIT_EVENTS).map((event) => [event.action, event.label])),
)

/** The filter options the console renders, derived rather than restated. */
export const AUDIT_ACTION_OPTIONS = Object.freeze(
  Object.values(AUDIT_EVENTS)
    .map((event) => ({
      value: event.action,
      label: event.label,
      category: event.category,
      severity: event.severity,
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label)),
)

/**
 * Resolves a registry key to its definition.
 *
 * Throws on an unknown key rather than recording an entry under a name no
 * filter will ever match. A wrong audit entry is worse than a loud crash in
 * development, because it is silent in production.
 *
 * @param {string} key
 * @returns {{ action: string, category: string, label: string, entityType?: string, severity: string }}
 */
export function auditEvent(key) {
  const event = AUDIT_EVENTS[key]

  if (!event) {
    throw new Error(
      `Unknown audit event "${key}". Add it to src/constants/auditEvents.js — event names are never written inline.`,
    )
  }

  return event
}

/** Whether a stored action string is one the registry knows. */
export function isAuditAction(action) {
  return Object.hasOwn(AUDIT_ACTION_INDEX, action)
}

export default AUDIT_EVENTS
