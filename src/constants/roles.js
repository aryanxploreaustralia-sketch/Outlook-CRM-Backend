/**
 * System roles.
 *
 * A role is **a named bundle of permissions and nothing else**. It carries no
 * authority of its own: `constants/permissions.js` defines what can be done and
 * `constants/roleMatrix.js` says which bundle each role holds. Nothing in the
 * codebase should branch on a role directly — every check goes through a
 * permission.
 *
 * ## Phase 14.4 extended this enum, additively
 *
 * It held `owner`, `admin` and `member`. Four roles were added to complete the
 * designed hierarchy. `member` was **kept**, not renamed and not removed:
 * documents and invitations already reference it, and an enum value that
 * disappears turns every record holding it into a validation failure.
 *
 * `OWNER` remains the default. Every account in this deployment holds it, so
 * extending the enum changes nobody's access — which is the property that made
 * enforcement safe to switch on.
 */

export const ROLES = Object.freeze({
  /** The account holder. Everything, including owner-only settings. */
  OWNER: 'owner',

  /** Full operational control, minus the two owner-only permissions. */
  ADMIN: 'admin',

  /** Owns a team's output: all CRM data, plus read access to reporting. */
  MANAGER: 'manager',

  /** Day-to-day operator: works enquiries, sends mail, builds campaigns. */
  SALES: 'sales',

  /** The reply desk: answers customers, reads the register for context. */
  SUPPORT: 'support',

  /** Read-only across the CRM. No administration, no sending, no export. */
  VIEWER: 'viewer',

  /**
   * Legacy, retained for compatibility.
   *
   * The original non-administrative role, from before the hierarchy existed.
   * `roleMatrix.js` resolves it to the same bundle as `SALES`, which is the
   * closest description of what it was used for. Nobody currently holds it and
   * nothing new should be created with it — but removing the value would
   * invalidate any record that already does.
   */
  MEMBER: 'member',
})

/** Human-readable labels for the UI. */
export const ROLE_LABELS = Object.freeze({
  [ROLES.OWNER]: 'Owner',
  [ROLES.ADMIN]: 'Administrator',
  [ROLES.MANAGER]: 'Manager',
  [ROLES.SALES]: 'Sales',
  [ROLES.SUPPORT]: 'Support',
  [ROLES.VIEWER]: 'Viewer',
  [ROLES.MEMBER]: 'Member (legacy)',
})

/**
 * One sentence on what each role is *for* (Phase 15.2).
 *
 * Deliberately about responsibility rather than capability. The exact
 * capabilities are derived from the permission matrix and shown alongside —
 * restating them here would be a second list, in prose, guaranteed to fall out
 * of step with the engine the first time a permission moves.
 */
export const ROLE_DESCRIPTIONS = Object.freeze({
  [ROLES.OWNER]: 'Full control of the organization, including roles, users and billing-level settings.',
  [ROLES.ADMIN]: 'Administers people and mailboxes, but cannot create or modify owners.',
  [ROLES.MANAGER]: 'Oversees the team’s work and reporting across every consultant.',
  [ROLES.SALES]: 'Works enquiries, sends mail and runs campaigns from assigned mailboxes.',
  [ROLES.SUPPORT]: 'Handles replies and enquiry follow-up without campaign control.',
  [ROLES.VIEWER]: 'Read-only access to the CRM. Cannot change anything.',
  [ROLES.MEMBER]: 'Legacy role retained so existing accounts keep validating. Not assignable.',
})

export const ROLE_VALUES = Object.freeze(Object.values(ROLES))

/**
 * Roles offered when inviting somebody.
 *
 * Excludes `member`, which is retained only so existing records validate. An
 * invitation form that offers a deprecated role is how the deprecation never
 * finishes.
 */
export const ASSIGNABLE_ROLES = Object.freeze([
  ROLES.OWNER,
  ROLES.ADMIN,
  ROLES.MANAGER,
  ROLES.SALES,
  ROLES.SUPPORT,
  ROLES.VIEWER,
])

/**
 * Precedence, lowest number most privileged.
 *
 * Not used for authorization — permissions decide that. It exists so a future
 * phase can refuse to let somebody grant a role at or above their own, which is
 * a rule about privilege escalation rather than about capability.
 */
export const ROLE_RANK = Object.freeze({
  [ROLES.OWNER]: 0,
  [ROLES.ADMIN]: 1,
  [ROLES.MANAGER]: 2,
  [ROLES.SALES]: 3,
  [ROLES.MEMBER]: 3,
  [ROLES.SUPPORT]: 4,
  [ROLES.VIEWER]: 5,
})

/**
 * Roles permitted to destroy data.
 *
 * **Superseded by permissions in Phase 14.4** and retained only because
 * `requireRole` still exports it. Every route that used it now names the
 * permission it actually needs. Do not use it in new code.
 *
 * @deprecated Use `requirePermission()` with a specific permission.
 */
export const DESTRUCTIVE_ROLES = Object.freeze([ROLES.OWNER, ROLES.ADMIN])

export default ROLES
