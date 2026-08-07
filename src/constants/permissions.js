/**
 * The permission registry.
 *
 * **The single source of truth for authorization in this CRM.** Every guard,
 * every route, every client check resolves to a string defined here. Nothing
 * anywhere else invents one.
 *
 * ## Permissions, not roles
 *
 * A role is a bundle of these and nothing more. That distinction is the whole
 * point of the phase: a route guarded by `requireRole(['owner','admin'])` has to
 * be found and edited every time the role list changes, and the answer to "what
 * can a Manager do?" is only discoverable by grepping. A route guarded by
 * `requirePermission(LEADS_DELETE)` states its own requirement, and
 * `roleMatrix.js` answers the question in one table.
 *
 * ## Naming
 *
 * `resource.action`, lower case, dot-separated. `view` is read; `manage` is the
 * catch-all write where a resource has no meaningful CRUD split. The strings are
 * part of the API contract — the client receives them verbatim from
 * `/admin/me/permissions` — so they must not be renamed once published.
 *
 * ## Two scopes in one registry, deliberately
 *
 * Some of these guard the admin console and some guard the CRM. They live
 * together because they are the same mechanism and because a person's
 * capabilities are one set, not two. `ADMIN_SURFACE_PERMISSIONS` at the foot
 * marks which ones imply access to the console.
 */

export const PERMISSIONS = Object.freeze({
  // --- CRM: overview -------------------------------------------------------
  /** The CRM's own dashboard. The admin dashboard requires `ANALYTICS_VIEW`. */
  DASHBOARD_VIEW: 'dashboard.view',

  // --- Directory -----------------------------------------------------------
  USERS_VIEW: 'users.view',
  USERS_INVITE: 'users.invite',
  USERS_ACTIVATE: 'users.activate',
  USERS_SUSPEND: 'users.suspend',
  /**
   * Soft-delete and restore (Phase 15.2).
   *
   * Distinct from `USERS_SUSPEND` because the two say different things to the
   * person affected and to whoever reads the directory later: suspension is a
   * pause an administrator expects to undo, deletion is a departure. Sharing
   * one permission would make "may pause somebody" and "may remove them" the
   * same grant.
   */
  USERS_DELETE: 'users.delete',

  // --- Roles ---------------------------------------------------------------
  ROLES_VIEW: 'roles.view',
  /** Editing role definitions. Reserved — system roles are not editable yet. */
  ROLES_MANAGE: 'roles.manage',

  // --- Mailboxes -----------------------------------------------------------
  MAILBOXES_VIEW: 'mailboxes.view',
  /** Reserved for the phase that introduces mailbox assignment. */
  MAILBOXES_ASSIGN: 'mailboxes.assign',
  /** Reserved for the same phase: choosing the default sending mailbox. */
  MAILBOXES_DEFAULT: 'mailboxes.default',

  // --- Reporting -----------------------------------------------------------
  /** Cross-user analytics. Also what gates the admin console's own dashboard. */
  ANALYTICS_VIEW: 'analytics.view',

  // --- Campaigns -----------------------------------------------------------
  CAMPAIGNS_VIEW: 'campaigns.view',
  CAMPAIGNS_CREATE: 'campaigns.create',
  /** Covers launch, pause, resume and cancel — all of them edit a live campaign. */
  CAMPAIGNS_EDIT: 'campaigns.edit',
  CAMPAIGNS_DELETE: 'campaigns.delete',

  // --- Templates -----------------------------------------------------------
  TEMPLATES_VIEW: 'templates.view',
  /**
   * Create, edit, delete, and **activate**.
   *
   * Activation deserves noting: the active template is what the morning
   * workbook run sends, so this permission decides the wording of every
   * automatic message a customer receives.
   */
  TEMPLATES_MANAGE: 'templates.manage',

  // --- Sales register ------------------------------------------------------
  LEADS_VIEW: 'leads.view',
  LEADS_CREATE: 'leads.create',
  LEADS_EDIT: 'leads.edit',
  /** Single and bulk deletion both. */
  LEADS_DELETE: 'leads.delete',
  /**
   * Taking the register out of the CRM.
   *
   * Not in the phase brief's list; added because the brief names Export as a
   * permissioned button, and folding it into `LEADS_VIEW` would mean anyone who
   * can read an enquiry can extract every customer record in the business.
   */
  LEADS_EXPORT: 'leads.export',

  CONTACTS_VIEW: 'contacts.view',
  COMPANIES_VIEW: 'companies.view',

  // --- Replies -------------------------------------------------------------
  /** Conversations, the reply inbox, and triggering a sync by hand. */
  REPLYSYNC_VIEW: 'replysync.view',
  NOTIFICATIONS_VIEW: 'notifications.view',

  // --- Mail ----------------------------------------------------------------
  COMPOSE_SEND: 'compose.send',
  MAILHISTORY_VIEW: 'mailhistory.view',

  // --- Workbook ------------------------------------------------------------
  WORKBOOK_IMPORT: 'workbook.import',
  WORKBOOK_HISTORY: 'workbook.history',

  // --- Scheduler -----------------------------------------------------------
  /**
   * Reading the morning run's configuration and history.
   *
   * Not in the brief's list; added because the brief supplies only
   * `scheduler.manage`, and the `GET /scheduler` routes would otherwise have to
   * be guarded by the permission that *changes* when customers are emailed.
   */
  SCHEDULER_VIEW: 'scheduler.view',
  /** Changing the run time, enabling/disabling, and running it by hand. */
  SCHEDULER_MANAGE: 'scheduler.manage',

  // --- Organization --------------------------------------------------------
  ORGANIZATION_VIEW: 'organization.view',
  ORGANIZATION_MANAGE: 'organization.manage',

  // --- Governance ----------------------------------------------------------
  AUDIT_VIEW: 'audit.view',
  SYSTEMHEALTH_VIEW: 'systemhealth.view',
  /** Re-probing dependencies on demand, which costs external calls. */
  SYSTEMHEALTH_MANAGE: 'systemhealth.manage',
})

export const PERMISSION_VALUES = Object.freeze(Object.values(PERMISSIONS))

/** Fast membership test, so an unknown string is caught rather than ignored. */
const PERMISSION_SET = new Set(PERMISSION_VALUES)

/**
 * Whether a string is a registered permission.
 *
 * Used by the middleware factory at import time. A guard built from a typo would
 * otherwise deny everybody silently and forever, which is the worst failure mode
 * available: it looks exactly like a correctly-configured guard.
 */
export function isPermission(value) {
  return PERMISSION_SET.has(value)
}

/**
 * Grouping and human labels, for the console's permission views.
 *
 * Kept beside the registry rather than in the UI, so a permission cannot be
 * added without deciding where it belongs and what to call it.
 */
export const PERMISSION_GROUPS = Object.freeze([
  {
    key: 'directory',
    label: 'Users & access',
    permissions: [
      PERMISSIONS.USERS_VIEW,
      PERMISSIONS.USERS_INVITE,
      PERMISSIONS.USERS_ACTIVATE,
      PERMISSIONS.USERS_SUSPEND,
      PERMISSIONS.USERS_DELETE,
      PERMISSIONS.ROLES_VIEW,
      PERMISSIONS.ROLES_MANAGE,
    ],
  },
  {
    key: 'sales',
    label: 'Sales register',
    permissions: [
      PERMISSIONS.LEADS_VIEW,
      PERMISSIONS.LEADS_CREATE,
      PERMISSIONS.LEADS_EDIT,
      PERMISSIONS.LEADS_DELETE,
      PERMISSIONS.LEADS_EXPORT,
      PERMISSIONS.CONTACTS_VIEW,
      PERMISSIONS.COMPANIES_VIEW,
    ],
  },
  {
    key: 'outreach',
    label: 'Outreach',
    permissions: [
      PERMISSIONS.CAMPAIGNS_VIEW,
      PERMISSIONS.CAMPAIGNS_CREATE,
      PERMISSIONS.CAMPAIGNS_EDIT,
      PERMISSIONS.CAMPAIGNS_DELETE,
      PERMISSIONS.TEMPLATES_VIEW,
      PERMISSIONS.TEMPLATES_MANAGE,
      PERMISSIONS.COMPOSE_SEND,
      PERMISSIONS.MAILHISTORY_VIEW,
    ],
  },
  {
    key: 'replies',
    label: 'Replies',
    permissions: [PERMISSIONS.REPLYSYNC_VIEW, PERMISSIONS.NOTIFICATIONS_VIEW],
  },
  {
    key: 'automation',
    label: 'Automation',
    permissions: [
      PERMISSIONS.WORKBOOK_IMPORT,
      PERMISSIONS.WORKBOOK_HISTORY,
      PERMISSIONS.SCHEDULER_VIEW,
      PERMISSIONS.SCHEDULER_MANAGE,
    ],
  },
  {
    key: 'mailboxes',
    label: 'Mailboxes',
    permissions: [
      PERMISSIONS.MAILBOXES_VIEW,
      PERMISSIONS.MAILBOXES_ASSIGN,
      PERMISSIONS.MAILBOXES_DEFAULT,
    ],
  },
  {
    key: 'platform',
    label: 'Platform',
    permissions: [
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.ANALYTICS_VIEW,
      PERMISSIONS.ORGANIZATION_VIEW,
      PERMISSIONS.ORGANIZATION_MANAGE,
      PERMISSIONS.AUDIT_VIEW,
      PERMISSIONS.SYSTEMHEALTH_VIEW,
      PERMISSIONS.SYSTEMHEALTH_MANAGE,
    ],
  },
])

export const PERMISSION_LABELS = Object.freeze({
  [PERMISSIONS.DASHBOARD_VIEW]: 'View the CRM dashboard',
  [PERMISSIONS.USERS_VIEW]: 'View the user directory',
  [PERMISSIONS.USERS_INVITE]: 'Invite users',
  [PERMISSIONS.USERS_ACTIVATE]: 'Activate users',
  [PERMISSIONS.USERS_SUSPEND]: 'Suspend users',
  [PERMISSIONS.USERS_DELETE]: 'Delete and restore users',
  [PERMISSIONS.ROLES_VIEW]: 'View roles and permissions',
  [PERMISSIONS.ROLES_MANAGE]: 'Change role definitions',
  [PERMISSIONS.MAILBOXES_VIEW]: 'View connected mailboxes',
  [PERMISSIONS.MAILBOXES_ASSIGN]: 'Assign mailboxes to users',
  [PERMISSIONS.MAILBOXES_DEFAULT]: 'Set the default sending mailbox',
  [PERMISSIONS.ANALYTICS_VIEW]: 'View cross-user analytics',
  [PERMISSIONS.CAMPAIGNS_VIEW]: 'View campaigns',
  [PERMISSIONS.CAMPAIGNS_CREATE]: 'Create campaigns',
  [PERMISSIONS.CAMPAIGNS_EDIT]: 'Launch, pause and edit campaigns',
  [PERMISSIONS.CAMPAIGNS_DELETE]: 'Delete campaigns',
  [PERMISSIONS.TEMPLATES_VIEW]: 'View email templates',
  [PERMISSIONS.TEMPLATES_MANAGE]: 'Create, edit and activate templates',
  [PERMISSIONS.LEADS_VIEW]: 'View enquiries',
  [PERMISSIONS.LEADS_CREATE]: 'Create enquiries',
  [PERMISSIONS.LEADS_EDIT]: 'Edit enquiries',
  [PERMISSIONS.LEADS_DELETE]: 'Delete enquiries',
  [PERMISSIONS.LEADS_EXPORT]: 'Export the enquiry register',
  [PERMISSIONS.CONTACTS_VIEW]: 'View contacts',
  [PERMISSIONS.COMPANIES_VIEW]: 'View companies',
  [PERMISSIONS.REPLYSYNC_VIEW]: 'View and answer customer replies',
  [PERMISSIONS.NOTIFICATIONS_VIEW]: 'View notifications',
  [PERMISSIONS.COMPOSE_SEND]: 'Send email',
  [PERMISSIONS.MAILHISTORY_VIEW]: 'View mail history',
  [PERMISSIONS.WORKBOOK_IMPORT]: 'Import a workbook',
  [PERMISSIONS.WORKBOOK_HISTORY]: 'View import history',
  [PERMISSIONS.SCHEDULER_VIEW]: 'View the morning scheduler',
  [PERMISSIONS.SCHEDULER_MANAGE]: 'Change or run the morning scheduler',
  [PERMISSIONS.ORGANIZATION_VIEW]: 'View organization settings',
  [PERMISSIONS.ORGANIZATION_MANAGE]: 'Change organization settings',
  [PERMISSIONS.AUDIT_VIEW]: 'Read the audit log',
  [PERMISSIONS.SYSTEMHEALTH_VIEW]: 'View system health',
  [PERMISSIONS.SYSTEMHEALTH_MANAGE]: 'Re-probe system health',
})

/**
 * Holding any of these means the admin console is reachable.
 *
 * Used to decide whether `/admin` renders at all, rather than letting somebody
 * with no admin capability land on a shell of empty pages. Everything else in
 * the registry guards the CRM, where every signed-in user already belongs.
 */
export const ADMIN_SURFACE_PERMISSIONS = Object.freeze([
  PERMISSIONS.ANALYTICS_VIEW,
  PERMISSIONS.USERS_VIEW,
  PERMISSIONS.ROLES_VIEW,
  PERMISSIONS.MAILBOXES_VIEW,
  PERMISSIONS.AUDIT_VIEW,
  PERMISSIONS.SYSTEMHEALTH_VIEW,
  PERMISSIONS.ORGANIZATION_VIEW,
])

export default PERMISSIONS
