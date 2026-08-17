/**
 * Admin controllers.
 *
 * Thin, as everywhere in this codebase: parse the request, call a service, shape
 * the response. No business rule lives here, and nothing here touches a model.
 *
 * ## Verbs
 *
 * Read handlers were the whole module until Phase 14.3A. That phase added three
 * writes, and only three: invite, activate, suspend. There is still no delete
 * and no role update — not disabled, not commented out, simply absent.
 */

import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import {
  ADMIN_SURFACE_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
} from '../../../constants/permissions.js'
import { ROLE_LABELS } from '../../../constants/roles.js'
import { buildRoleMatrix, permissionListForRole, roleHasAdminAccess } from '../../../constants/roleMatrix.js'
import { buildAdminAnalytics } from '../services/adminAnalytics.service.js'
import { buildAdminAuditSummary } from '../services/adminAudit.service.js'
import { buildAdminDashboard } from '../services/adminDashboard.service.js'
import { buildAdminHealth } from '../services/adminHealth.service.js'
import { buildAdminOrganization } from '../services/adminOrganization.service.js'
import { listAdminMailboxes } from '../services/adminMailbox.service.js'
import {
  buildEmployeePerformance,
  buildPerformanceComparison,
  buildPerformanceHighlights,
} from '../services/employeePerformance.service.js'
import {
  buildLeadAnalytics,
  buildMailboxAnalytics,
  buildOrganisationActivity,
  buildTeamPerformance,
  buildUserPerformance,
} from '../services/adminTeam.service.js'
import {
  assignUsersToMailbox,
  getMailboxDetail,
  listMailboxesForUser,
  setDefaultMailboxForUser,
  setUserMailboxes,
  unassignUsersFromMailbox,
} from '../services/mailboxAssignment.service.js'
import { listAdminCampaigns, listAdminLeads } from '../services/adminMonitoring.service.js'
import { deleteUser, restoreUser } from '../services/adminUserLifecycle.service.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import {
  activateUser,
  changeUserRole,
  getBootstrapStatus,
  getRoleControl,
  linkMicrosoftIdentity,
  unlinkMicrosoftIdentity,
  getUser,
  inviteUser,
  listUsers,
  suspendUser,
} from '../services/adminUserAdmin.service.js'
import { assignWorkbookToUser, deleteUserLeads } from '../services/adminUserLeads.service.js'
import {
  adminAnalyticsQuerySchema,
  adminCampaignQuerySchema,
  adminLeadQuerySchema,
} from '../validators/admin.validator.js'
import {
  adminUserInviteSchema,
  adminUserListQuerySchema,
  adminUserDeleteSchema,
  adminUserLeadDeleteSchema,
  adminUserLeadImportSchema,
  adminUserRoleSchema,
  microsoftIdentitySchema,
  objectIdSchema,
} from '../validators/adminUser.validator.js'
import {
  activityQuerySchema,
  performanceCompareQuerySchema,
  performanceQuerySchema,
  rangeQuerySchema,
  resolveRange,
  teamQuerySchema,
  userTrendQuerySchema,
} from '../validators/adminAnalytics.validator.js'
import {
  adminMailboxListSchema,
  mailboxAssignSchema,
  mailboxDefaultSchema,
  userMailboxesSchema,
} from '../validators/adminMailbox.validator.js'

/**
 * GET /api/v1/admin/me/permissions
 *
 * What the caller may do. Authentication only — requiring a permission to
 * discover your own permissions is circular, and the answer is not sensitive.
 *
 * This is the endpoint the client's permission layer reads. It returns three
 * things deliberately:
 *
 *  - `permissions` — the caller's effective set, which decides what renders;
 *  - `catalogue` — every permission that exists, so the client can warn in
 *    development when it asks about a string the server has never heard of.
 *    That is how a typo in a `<Can do="...">` is caught, rather than silently
 *    hiding a control forever;
 *  - `adminAccess` — whether the console should open at all.
 *
 * What it renders is a convenience. What the server enforces is the control.
 */
export const getMyPermissions = asyncHandler(async (req, res) => {
  const role = req.auth.user.role ?? null

  return sendSuccess(res, {
    message: 'Permissions loaded.',
    data: {
      role,
      roleLabel: ROLE_LABELS[role] ?? role,
      permissions: permissionListForRole(role),
      adminAccess: roleHasAdminAccess(role),
      adminSurfacePermissions: ADMIN_SURFACE_PERMISSIONS,
      catalogue: PERMISSION_LABELS,
      groups: PERMISSION_GROUPS,
    },
  })
})

/**
 * GET /api/v1/admin/roles
 *
 * The role matrix, derived from the same constants the middleware enforces —
 * so the Roles screen cannot describe a model the server does not apply.
 */
export const getAdminRoles = asyncHandler(async (_req, res) =>
  sendSuccess(res, {
    message: 'Roles loaded.',
    data: {
      roles: buildRoleMatrix().map((entry) => ({
        ...entry,
        label: ROLE_LABELS[entry.role] ?? entry.role,
      })),
      groups: PERMISSION_GROUPS,
      catalogue: PERMISSION_LABELS,
    },
  }),
)

/** GET /api/v1/admin/dashboard */
export const getAdminDashboard = asyncHandler(async (req, res) => {
  // The dashboard accepts the same global range as every other analytics
  // surface, so moving the period filter on one screen means the same thing on
  // all of them. Absent parameters resolve to the shared default.
  const range = resolveRange(rangeQuerySchema.parse(req.query))

  return sendSuccess(res, {
    message: 'Admin dashboard loaded.',
    data: await buildAdminDashboard(req.auth, range),
  })
})

/**
 * GET /api/v1/admin/users
 *
 * Pagination is returned in `meta` rather than inside `data`, matching the
 * envelope `ApiResponse` already defines, so a client reads it from the same
 * place on every paginated endpoint in the product.
 */
export const getAdminUsers = asyncHandler(async (req, res) => {
  const query = adminUserListQuerySchema.parse(req.query)
  const { items, roles, statusCounts, pagination } = await listUsers(query)

  return sendSuccess(res, {
    message: 'Users loaded.',
    data: { items, roles, statusCounts },
    meta: pagination,
  })
})

/** GET /api/v1/admin/users/:id — the profile drawer. */
export const getAdminUser = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'User loaded.',
    data: await getUser(objectIdSchema.parse(req.params.id), req.auth.user),
  }),
)

/**
 * POST /api/v1/admin/users/invite
 *
 * 201, because a resource was created — the invitation *is* the user record.
 * No email is sent: notifying the invitee is a later phase, and this endpoint
 * would otherwise depend on a connected mailbox to create an account for
 * somebody who may be the one who is meant to connect it.
 */
/**
 * POST /api/v1/admin/users/:id/leads/import
 *
 * Assigns a workbook of enquiries to one user, typically the account just
 * created for them.
 *
 * Separate from `/users/invite` on purpose. Creating the account and stocking
 * it are two operations with two outcomes, and a single endpoint would have to
 * report "created but not imported" as one ambiguous result — or worse, fail
 * the whole call and leave the administrator unsure whether the user exists.
 * Two calls let the client say exactly what happened.
 *
 * The body is the raw file, with the name in `X-Filename`: the same convention
 * the workbook import, profile documents and task attachments already use.
 */
export const postAdminUserLeadImport = asyncHandler(async (req, res) => {
  const id = objectIdSchema.parse(req.params.id)

  const buffer = Buffer.isBuffer(req.body) ? req.body : null
  if (!buffer || buffer.length === 0) throw ApiError.badRequest('No file was uploaded.')

  const filename = String(req.get('x-filename') ?? 'workbook.xlsx').slice(0, 255)

  /**
   * Wizard options, in `X-Import-Options` like every other raw upload.
   *
   * All optional, and absent is the invitation flow's case: no selection, no
   * mapping override, not a preview — import every lead sheet, which is what
   * that flow has always done and continues to do.
   */
  const options = adminUserLeadImportSchema.parse(
    JSON.parse(req.get('x-import-options') ?? '{}'),
  )

  const result = await assignWorkbookToUser({
    userId: id,
    buffer,
    filename,
    actor: req.auth.user,
    sheets: options.sheets ?? null,
    mapping: options.mapping ?? null,
    dryRun: options.dryRun,
  })

  // A preview writes nothing, so there is nothing to record and no 201 to give.
  if (result.dryRun) {
    return sendSuccess(res, {
      message: `${result.previews.reduce((sum, p) => sum + p.counts.valid, 0)} row(s) are importable.`,
      data: result,
    })
  }

  await recordAudit({
    req,
    event: 'WORKBOOK_IMPORTED',
    summary: `Assigned ${filename} to ${result.user.email} — ${result.created} enquiry/enquiries`,
    target: { id: result.importJob, name: filename },
    performedFor: { _id: result.user.id, email: result.user.email },
    affectedCount: result.created + result.updated,
    metadata: {
      assignedTo: result.user.id,
      filename,
      created: result.created,
      updated: result.updated,
      duplicate: result.duplicate,
      invalid: result.invalid,
      failed: result.failed,
      sheets: result.sheets.filter((sheet) => sheet.imported).map((sheet) => sheet.name),
    },
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message:
      `${result.created} enquiry/enquiries assigned to ${result.user.email}` +
      (result.updated > 0 ? `, ${result.updated} updated` : '') +
      (result.invalid + result.failed > 0
        ? `. ${result.invalid + result.failed} row(s) could not be imported.`
        : '.'),
    data: result,
  })
})

/**
 * DELETE /api/v1/admin/users/:id/leads
 *
 * Deletes enquiries belonging to one user. `{ leadIds }` soft-deletes a named
 * set; `{ all: true }` runs the same hard purge the CRM's own "delete all"
 * uses. The service scopes every query by the target user's id, so a foreign
 * lead id matches nothing rather than being deleted.
 */
export const deleteAdminUserLeads = asyncHandler(async (req, res) => {
  const id = objectIdSchema.parse(req.params.id)
  const body = adminUserLeadDeleteSchema.parse(req.body ?? {})

  const result = await deleteUserLeads({
    userId: id,
    leadIds: body.leadIds ?? [],
    all: body.all === true,
    actor: req.auth.user,
  })

  await recordAudit({
    req,
    event: 'LEAD_DELETED',
    summary:
      `Deleted ${result.deleted} enquiry/enquiries for ${result.user.email}` +
      (result.mode === 'purge' ? ' (purged the whole register)' : ''),
    target: { id: result.user.id, name: result.user.email },
    performedFor: { _id: result.user.id, email: result.user.email },
    affectedCount: result.deleted,
    metadata: {
      mode: result.mode,
      requested: result.requested,
      skipped: result.skipped.length,
    },
  })

  return sendSuccess(res, {
    message:
      result.deleted === 0
        ? 'No enquiries were deleted.'
        : `${result.deleted} enquiry/enquiries deleted.`,
    data: result,
  })
})

export const postAdminUserInvite = asyncHandler(async (req, res) => {
  const input = adminUserInviteSchema.parse(req.body)
  const result = await inviteUser(input, req.auth.user)

  /**
   * Recorded after the service succeeded, never before.
   *
   * An entry written first would claim an invitation that a later validation
   * failure prevented — and there is no compensating delete, because the log is
   * append-only. Recording last means the log can miss an action if the process
   * dies between the two, which is the right way round: a missing entry is a
   * gap, a false entry is a lie.
   */
  await recordAudit({
    req,
    event: 'USER_INVITED',
    summary: `Invited ${result.user.email} as ${result.user.roleLabel ?? result.user.role}`,
    target: { id: result.user.id, name: result.user.email },
    performedFor: { _id: result.user.id, email: result.user.email },
    metadata: { role: result.user.role, notes: input.notes ?? null },
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: `${result.user.email} has been invited.`,
    data: result,
  })
})

/** PATCH /api/v1/admin/users/:id/activate */
export const patchAdminUserActivate = asyncHandler(async (req, res) => {
  const result = await activateUser(objectIdSchema.parse(req.params.id), req.auth.user)

  await recordAudit({
    req,
    event: 'USER_ACTIVATED',
    summary: `Activated ${result.user.email ?? 'an account'}`,
    target: { id: result.user.id, name: result.user.email },
    performedFor: { _id: result.user.id, email: result.user.email },
    // The transition, not the whole user document — the log records the change,
    // and a copy of the record belongs in the record.
    metadata: { from: result.from, to: result.to },
  })

  return sendSuccess(res, {
    message: `${result.user.email ?? 'The account'} is now active.`,
    data: result,
  })
})

/** PATCH /api/v1/admin/users/:id/suspend */
export const patchAdminUserSuspend = asyncHandler(async (req, res) => {
  const result = await suspendUser(objectIdSchema.parse(req.params.id), req.auth.user)

  await recordAudit({
    req,
    event: 'USER_SUSPENDED',
    summary: `Suspended ${result.user.email ?? 'an account'}`,
    target: { id: result.user.id, name: result.user.email },
    performedFor: { _id: result.user.id, email: result.user.email },
    // The transition, not the whole user document — the log records the change,
    // and a copy of the record belongs in the record.
    metadata: { from: result.from, to: result.to },
  })

  return sendSuccess(res, {
    message: `${result.user.email ?? 'The account'} has been suspended.`,
    data: result,
  })
})

/**
 * GET /api/v1/admin/users/:id/role
 *
 * Which roles the caller may set on this person, and why not for the rest.
 *
 * A read, so the console can render a dropdown that only offers legal choices.
 * It is a convenience: `PATCH` evaluates the same rules again, and that is the
 * control. A client that ignored this and posted `owner` anyway would be
 * refused by the endpoint, not by the absence of an option.
 */
export const getAdminUserRole = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Role options loaded.',
    data: await getRoleControl({
      targetId: objectIdSchema.parse(req.params.id),
      actor: req.auth.user,
    }),
  }),
)

/**
 * PATCH /api/v1/admin/users/:id/role
 *
 * The only endpoint in the product that writes `role`.
 *
 * Reaching it needs `roles.manage`; what may actually be done once here is
 * decided by `canAssignRole`, which is re-evaluated inside the service. The
 * split matters: the permission is a capability, and the rules are about the
 * relationship between the actor, the target and the requested role.
 */
export const patchAdminUserRole = asyncHandler(async (req, res) => {
  const { role, reason } = adminUserRoleSchema.parse(req.body)
  const id = objectIdSchema.parse(req.params.id)

  const result = await changeUserRole({ id, role, reason, actor: req.auth.user })

  await recordAudit({
    req,
    event: 'ROLE_CHANGED',
    summary: `Changed ${result.user.email}'s role from ${result.fromLabel} to ${result.toLabel}`,
    target: { id: result.user.id, name: result.user.email },
    performedFor: { _id: result.user.id, email: result.user.email },
    // The reason is the administrator's own words and is the single most useful
    // field on this entry when somebody asks why an account was promoted.
    metadata: { from: result.from, to: result.to, reason: result.reason },
  })

  return sendSuccess(res, {
    message: `${result.user.email} is now a ${result.toLabel}.`,
    data: result,
  })
})

/**
 * PUT /api/v1/admin/users/:id/microsoft-identity
 *
 * Links a Microsoft address to an existing account, so one person can reach it
 * through either provider without the two addresses being equal.
 */
export const putAdminUserMicrosoftIdentity = asyncHandler(async (req, res) => {
  const { microsoftEmail } = microsoftIdentitySchema.parse(req.body)
  const id = objectIdSchema.parse(req.params.id)

  const result = await linkMicrosoftIdentity({ id, microsoftEmail, actor: req.auth.user })

  await recordAudit({
    req,
    event: 'MICROSOFT_CONNECTED',
    summary: `Linked ${result.microsoftEmail} to ${result.user.email}`,
    target: { type: 'user', id: result.user.id, name: result.user.email },
    performedFor: { _id: result.user.id, email: result.user.email },
    metadata: { microsoftEmail: result.microsoftEmail, previous: result.previous },
  })

  return sendSuccess(res, {
    message: `${result.microsoftEmail} can now sign in as ${result.user.email}.`,
    data: result,
  })
})

/** DELETE /api/v1/admin/users/:id/microsoft-identity — revokes that route in. */
export const deleteAdminUserMicrosoftIdentity = asyncHandler(async (req, res) => {
  const id = objectIdSchema.parse(req.params.id)
  const result = await unlinkMicrosoftIdentity({ id, actor: req.auth.user })

  await recordAudit({
    req,
    event: 'MAILBOX_DISCONNECTED',
    summary: `Unlinked the Microsoft identity ${result.previous ?? ''} from ${result.user.email}`.trim(),
    target: { type: 'user', id: result.user.id, name: result.user.email },
    performedFor: { _id: result.user.id, email: result.user.email },
    metadata: { previous: result.previous },
  })

  return sendSuccess(res, { message: 'Microsoft identity removed.', data: result })
})

/**
 * GET /api/v1/admin/organization/bootstrap
 *
 * Whether the organization has been claimed. Lets the console explain why a
 * Microsoft sign-in is refused instead of leaving an operator guessing.
 */
export const getAdminBootstrapStatus = asyncHandler(async (_req, res) =>
  sendSuccess(res, { message: 'Bootstrap status loaded.', data: await getBootstrapStatus() }),
)

/**
 * DELETE /api/v1/admin/users/:id
 *
 * A soft delete. The document, and every lead, campaign, audit entry and
 * notification that references it, are retained in full — what the person loses
 * is access. See `adminUserLifecycle.service.js`.
 */
export const deleteAdminUser = asyncHandler(async (req, res) => {
  const id = objectIdSchema.parse(req.params.id)
  const { reason } = adminUserDeleteSchema.parse(req.body ?? {})

  const result = await deleteUser({ id, reason, actor: req.auth.user })

  await recordAudit({
    req,
    event: 'USER_DELETED',
    summary: `Deleted ${result.user.email}`,
    target: { id: result.user.id, name: result.user.email },
    performedFor: { _id: result.user.id, email: result.user.email },
    affectedCount: 1,
    metadata: {
      reason: result.reason,
      revokedSessions: result.revokedSessions,
      mailboxesUnassigned: result.mailboxesUnassigned,
      preserved: result.preserved,
    },
  })

  return sendSuccess(res, {
    message: `${result.user.email} can no longer sign in. Their history is unchanged.`,
    data: result,
  })
})

/** POST /api/v1/admin/users/:id/restore — returns access. Sessions stay revoked. */
export const postAdminUserRestore = asyncHandler(async (req, res) => {
  const id = objectIdSchema.parse(req.params.id)
  const result = await restoreUser({ id, actor: req.auth.user })

  await recordAudit({
    req,
    event: 'USER_RESTORED',
    summary: `Restored ${result.user.email}`,
    target: { id: result.user.id, name: result.user.email },
    performedFor: { _id: result.user.id, email: result.user.email },
    affectedCount: 1,
    metadata: { sessionsRestored: false },
  })

  return sendSuccess(res, {
    message: `${result.user.email} can sign in again. They will need to sign in fresh.`,
    data: result,
  })
})

/** GET /api/v1/admin/mailboxes */
export const getAdminMailboxes = asyncHandler(async (req, res) => {
  const query = adminMailboxListSchema.parse(req.query)

  return sendSuccess(res, {
    message: 'Mailboxes loaded.',
    data: await listAdminMailboxes(query),
  })
})

/** GET /api/v1/admin/mailboxes/:id - one mailbox with the people who can use it. */
export const getAdminMailbox = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Mailbox loaded.',
    data: await getMailboxDetail(objectIdSchema.parse(req.params.id)),
  }),
)

/**
 * POST /api/v1/admin/mailboxes/:id/assign
 *
 * Idempotent: re-assigning somebody who already has access is reported in
 * `skipped`, not refused. The request describes a desired state.
 */
export const postAdminMailboxAssign = asyncHandler(async (req, res) => {
  const { userIds } = mailboxAssignSchema.parse(req.body)
  const mailboxId = objectIdSchema.parse(req.params.id)

  const result = await assignUsersToMailbox({ mailboxId, userIds }, req.auth.user)

  await recordAudit({
    req,
    event: 'MAILBOX_ASSIGNED',
    summary: `Granted ${result.added?.length ?? 0} user(s) access to ${result.mailbox?.emailAddress ?? 'a mailbox'}`,
    target: { id: mailboxId, name: result.mailbox?.emailAddress ?? null },
    refs: { mailboxId },
    affectedCount: result.added?.length ?? 0,
    // The id lists only. The mailbox DTO carries connection and health state
    // that has no business being copied into a log entry.
    metadata: { added: result.added ?? [], skipped: result.skipped ?? [] },
  })

  return sendSuccess(res, { message: 'Mailbox access updated.', data: result })
})

/** POST /api/v1/admin/mailboxes/:id/unassign */
export const postAdminMailboxUnassign = asyncHandler(async (req, res) => {
  const { userIds } = mailboxAssignSchema.parse(req.body)
  const mailboxId = objectIdSchema.parse(req.params.id)

  const result = await unassignUsersFromMailbox({ mailboxId, userIds }, req.auth.user)

  await recordAudit({
    req,
    event: 'MAILBOX_UNASSIGNED',
    summary: `Removed ${result.removed?.length ?? 0} user(s) from ${result.mailbox?.emailAddress ?? 'a mailbox'}`,
    target: { id: mailboxId, name: result.mailbox?.emailAddress ?? null },
    refs: { mailboxId },
    affectedCount: result.removed?.length ?? 0,
    // `clearedDefaults` matters: removing access silently drops that person's
    // default mailbox, and the log should show that it happened.
    metadata: { removed: result.removed ?? [], clearedDefaults: result.clearedDefaults ?? [] },
  })

  return sendSuccess(res, { message: 'Mailbox access removed.', data: result })
})

/** PATCH /api/v1/admin/mailboxes/:id/default - make it one user's default. */
export const patchAdminMailboxDefault = asyncHandler(async (req, res) => {
  const { userId } = mailboxDefaultSchema.parse(req.body)
  const mailboxId = objectIdSchema.parse(req.params.id)

  const result = await setDefaultMailboxForUser({ mailboxId, userId }, req.auth.user)

  // The service is idempotent and reports `changed: false` when the mailbox was
  // already that person's default. Recording that would fill the log with
  // entries for requests that changed nothing.
  if (result.changed) {
    await recordAudit({
      req,
      event: 'DEFAULT_MAILBOX_CHANGED',
      summary: `Made ${result.mailbox?.emailAddress ?? 'a mailbox'} the default mailbox for a user`,
      target: { id: mailboxId, name: result.mailbox?.emailAddress ?? null },
      performedFor: { _id: userId },
      refs: { mailboxId },
      metadata: { userId: String(userId) },
    })
  }

  return sendSuccess(res, { message: 'Default mailbox updated.', data: result })
})

/** GET /api/v1/admin/users/:id/mailboxes */
export const getAdminUserMailboxes = asyncHandler(async (req, res) => {
  const userId = objectIdSchema.parse(req.params.id)

  return sendSuccess(res, {
    message: 'Mailboxes loaded.',
    data: { items: await listMailboxesForUser(userId) },
  })
})

/**
 * PUT /api/v1/admin/users/:id/mailboxes
 *
 * A set operation, not a diff: the body is the complete list of mailboxes this
 * person should have. A client submitting an add-list and a remove-list can
 * leave the two inconsistent; a set cannot.
 */
export const putAdminUserMailboxes = asyncHandler(async (req, res) => {
  const { mailboxIds } = userMailboxesSchema.parse(req.body)
  const userId = objectIdSchema.parse(req.params.id)

  const result = await setUserMailboxes({ userId, mailboxIds }, req.auth.user)

  /**
   * A set operation produces both kinds of change, so it is recorded as
   * whichever one it actually performed — and as an assignment when it did
   * both, because that is the more privileged half. Recording two entries for
   * one request would make the log double-count the action.
   */
  const added = result.added?.length ?? 0
  const removed = result.removed?.length ?? 0

  if (added > 0 || removed > 0) {
    await recordAudit({
      req,
      event: added > 0 ? 'MAILBOX_ASSIGNED' : 'MAILBOX_UNASSIGNED',
      summary: `Set mailbox access: ${added} mailbox(es) added, ${removed} removed`,
      target: { type: 'user', id: userId },
      performedFor: { _id: userId },
      affectedCount: added + removed,
      metadata: { added: result.added ?? [], removed: result.removed ?? [] },
    })
  }

  return sendSuccess(res, { message: 'Mailbox assignments updated.', data: result })
})

/** GET /api/v1/admin/analytics */
export const getAdminAnalytics = asyncHandler(async (req, res) => {
  const query = adminAnalyticsQuerySchema.parse(req.query)

  /**
   * A named preset is resolved to bounds before the service sees it.
   *
   * `all` resolves to no bounds at all, which this endpoint must not be given:
   * it buckets by day and would try to scaffold every day since the first
   * document. Its own default window applies instead.
   */
  const range = query.preset ? resolveRange(query) : query
  const window = range.from ? { from: range.from, to: range.to } : {}

  return sendSuccess(res, {
    message: 'Analytics loaded.',
    data: await buildAdminAnalytics({ ...window, granularity: query.granularity }),
  })
})

/**
 * GET /api/v1/admin/analytics/team
 *
 * The leaderboard. Carries the scoring definition alongside the rows, so the
 * console explains the score from the same data that produced it rather than
 * restating the rules in the interface.
 */
export const getAdminTeamPerformance = asyncHandler(async (req, res) => {
  const query = teamQuerySchema.parse(req.query)
  const range = resolveRange(query)

  return sendSuccess(res, {
    message: 'Team performance loaded.',
    data: {
      ...(await buildTeamPerformance({ ...query, from: range.from, to: range.to })),
      range: { preset: range.preset, from: range.from ?? null, to: range.to ?? null },
    },
  })
})

/** GET /api/v1/admin/analytics/users/:id - one person's activity over time. */
export const getAdminUserPerformance = asyncHandler(async (req, res) => {
  const query = userTrendQuerySchema.parse(req.query)
  const range = resolveRange(query)

  /**
   * A trend needs bounds even when the caller asked for "all".
   *
   * An unbounded series has no first bucket to start scaffolding from, so the
   * open preset falls back to a year - long enough to be a trend, short enough
   * to stay one screen of buckets.
   */
  const to = range.to ?? new Date()
  const from = range.from ?? new Date(to.getTime() - 365 * 86_400_000)

  return sendSuccess(res, {
    message: 'User performance loaded.',
    data: await buildUserPerformance({
      userId: objectIdSchema.parse(req.params.id),
      from,
      to,
      unit: query.unit,
    }),
  })
})

// ---------------------------------------------------------------------------
// Employee performance (Phase 17.3)
// ---------------------------------------------------------------------------

/**
 * One person's performance dashboard.
 *
 * Shared by the admin route and the employee's own, which is why the target id
 * is a parameter rather than something this reads from the session. The routes
 * decide whose id it is; the handler never chooses.
 */
export async function respondWithPerformance(req, res, targetId) {
  const query = performanceQuerySchema.parse(req.query)
  const range = resolveRange(query)

  const data = await buildEmployeePerformance({
    userId: targetId,
    from: range.from,
    to: range.to,
    timelineLimit: query.timelineLimit,
  })

  return sendSuccess(res, {
    message: 'Performance loaded.',
    data: { ...data, range: { preset: range.preset, from: range.from ?? null, to: range.to ?? null } },
  })
}

/** GET /api/v1/admin/users/:id/performance */
export const getAdminUserPerformanceDashboard = asyncHandler((req, res) =>
  respondWithPerformance(req, res, objectIdSchema.parse(req.params.id)),
)

/** GET /api/v1/admin/performance/highlights — the dashboard widgets and badges. */
export const getAdminPerformanceHighlights = asyncHandler(async (req, res) => {
  const range = resolveRange(rangeQuerySchema.parse(req.query))

  return sendSuccess(res, {
    message: 'Performance highlights loaded.',
    data: {
      ...(await buildPerformanceHighlights({ from: range.from, to: range.to })),
      range: { preset: range.preset, from: range.from ?? null, to: range.to ?? null },
    },
  })
})

/** GET /api/v1/admin/performance/compare?users=a,b */
export const getAdminPerformanceComparison = asyncHandler(async (req, res) => {
  const query = performanceCompareQuerySchema.parse(req.query)
  const range = resolveRange(query)

  return sendSuccess(res, {
    message: 'Comparison loaded.',
    data: {
      ...(await buildPerformanceComparison({
        userIds: query.users,
        from: range.from,
        to: range.to,
      })),
      range: { preset: range.preset, from: range.from ?? null, to: range.to ?? null },
    },
  })
})

/** GET /api/v1/admin/analytics/mailboxes */
export const getAdminMailboxAnalytics = asyncHandler(async (req, res) => {
  const range = resolveRange(rangeQuerySchema.parse(req.query))

  return sendSuccess(res, {
    message: 'Mailbox analytics loaded.',
    data: {
      ...(await buildMailboxAnalytics({ from: range.from, to: range.to })),
      range: { preset: range.preset, from: range.from ?? null, to: range.to ?? null },
    },
  })
})

/** GET /api/v1/admin/analytics/leads - the funnel. */
export const getAdminLeadAnalytics = asyncHandler(async (req, res) => {
  const range = resolveRange(rangeQuerySchema.parse(req.query))

  return sendSuccess(res, {
    message: 'Lead analytics loaded.',
    data: {
      ...(await buildLeadAnalytics({ from: range.from, to: range.to })),
      range: { preset: range.preset, from: range.from ?? null, to: range.to ?? null },
    },
  })
})

/** GET /api/v1/admin/activity - the organisation timeline. Not an audit log. */
export const getAdminActivity = asyncHandler(async (req, res) => {
  const query = activityQuerySchema.parse(req.query)
  const range = resolveRange(query)

  return sendSuccess(res, {
    message: 'Activity loaded.',
    data: await buildOrganisationActivity({
      from: range.from,
      to: range.to,
      limit: query.limit,
    }),
  })
})

/** GET /api/v1/admin/campaigns — cross-user campaign monitoring, read-only. */
export const getAdminCampaigns = asyncHandler(async (req, res) => {
  const query = adminCampaignQuerySchema.parse(req.query)

  return sendSuccess(res, {
    message: 'Campaigns loaded.',
    data: await listAdminCampaigns(query),
  })
})

/** GET /api/v1/admin/leads — cross-user enquiry monitoring, read-only. */
export const getAdminLeads = asyncHandler(async (req, res) => {
  const query = adminLeadQuerySchema.parse(req.query)

  return sendSuccess(res, {
    message: 'Enquiries loaded.',
    data: await listAdminLeads(query),
  })
})

/** GET /api/v1/admin/system-health */
export const getAdminSystemHealth = asyncHandler(async (_req, res) =>
  sendSuccess(res, {
    message: 'System health probed.',
    data: await buildAdminHealth(),
  }),
)

/** GET /api/v1/admin/audit/summary */
export const getAdminAuditSummary = asyncHandler(async (_req, res) =>
  sendSuccess(res, {
    message: 'Audit summary loaded.',
    data: await buildAdminAuditSummary(),
  }),
)

/** GET /api/v1/admin/organization */
export const getAdminOrganization = asyncHandler(async (_req, res) =>
  sendSuccess(res, {
    message: 'Organization loaded.',
    data: await buildAdminOrganization(),
  }),
)

export default {
  getAdminActivity,
  getAdminAnalytics,
  getAdminPerformanceComparison,
  getAdminPerformanceHighlights,
  getAdminUserPerformanceDashboard,
  getAdminLeadAnalytics,
  getAdminMailboxAnalytics,
  getAdminTeamPerformance,
  getAdminUserPerformance,
  getAdminMailbox,
  getAdminUserMailboxes,
  patchAdminMailboxDefault,
  postAdminMailboxAssign,
  postAdminMailboxUnassign,
  putAdminUserMailboxes,
  getAdminRoles,
  getMyPermissions,
  getAdminAuditSummary,
  getAdminCampaigns,
  getAdminDashboard,
  getAdminLeads,
  getAdminMailboxes,
  getAdminOrganization,
  getAdminSystemHealth,
  getAdminUser,
  deleteAdminUser,
  deleteAdminUserMicrosoftIdentity,
  postAdminUserRestore,
  getAdminBootstrapStatus,
  getAdminUserRole,
  getAdminUsers,
  putAdminUserMicrosoftIdentity,
  patchAdminUserRole,
  patchAdminUserActivate,
  patchAdminUserSuspend,
  postAdminUserInvite,
  postAdminUserLeadImport,
  deleteAdminUserLeads,
}
