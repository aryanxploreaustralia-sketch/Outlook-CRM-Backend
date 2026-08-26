/**
 * Admin routes.
 *
 * Mounted at `${API_PREFIX}/v1/admin`.
 *
 * ## Every route names the capability it needs
 *
 * Since Phase 14.4 there is no unguarded admin endpoint and no role check. Each
 * route declares a permission from `constants/permissions.js`, and
 * `constants/roleMatrix.js` decides who holds it. Adding a role changes nothing
 * in this file.
 *
 * The one exception is `/me/permissions`, which is guarded by authentication
 * alone — a permission required to discover your own permissions is a circular
 * requirement, and the answer is not sensitive: it is what the caller may
 * already infer by trying things.
 *
 * ## Authentication
 *
 * `requireAuth` is applied at the **router** level, not per route, for the
 * reason `dashboard.routes.js` gives: a route added later cannot be left
 * unprotected by omission. It is the CRM's existing middleware, unmodified.
 *
 * ## Failure is 403, never 404
 *
 * A permission failure means the resource exists and the caller may not act on
 * it. Answering 404 would send an operator looking for a missing record instead
 * of a missing grant.
 *
 * ## Verbs
 *
 * Nine reads and three writes. There is no `DELETE` in this module and no
 * endpoint that changes a role — both absent rather than disabled.
 */

import express, { Router } from 'express'
import rateLimit from 'express-rate-limit'

import { MAX_FILE_BYTES } from '../../import/constants/importConstants.js'

import { requireAuth } from '../../../middlewares/authenticate.js'
import { requireAllPermissions, requirePermission } from '../../../middlewares/authorise.js'
import { ERROR_CODES } from '../../../constants/errorCodes.js'
import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { PERMISSIONS } from '../../../constants/permissions.js'
import * as controller from '../controllers/admin.controller.js'
import * as profileController from '../../profile/controllers/profile.controller.js'

const router = Router()

/**
 * A tighter limit for the two endpoints that do real work.
 *
 * `/analytics` runs four bucketed aggregations and `/system-health` runs nine
 * probes. Neither is expensive enough to protect the database from one operator,
 * and both are cheap enough to hurt it from a tab left polling on a five-second
 * timer. Thirty a minute is generous for a human and firm against a loop.
 */
const heavyReadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many admin requests. Please wait a moment before refreshing again.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

/**
 * Invitations are rate-limited harder than a read.
 *
 * An invitation creates a real account row, and a loop against this endpoint
 * would fill the directory with records that cannot be deleted — there is no
 * delete, by design.
 */
const inviteLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many invitations sent in the last hour. Please wait before inviting more people.',
      code: ERROR_CODES.RATE_LIMITED,
      timestamp: new Date().toISOString(),
      requestId: req.id ?? null,
    }),
})

router.use(requireAuth)

// --- Self ------------------------------------------------------------------
// Authentication only. See the note at the top: gating this on a permission
// would be circular, and the catalogue it returns is not a secret.
router.get('/me/permissions', controller.getMyPermissions)

// --- Overview --------------------------------------------------------------
// The admin dashboard is a cross-user analytics summary, so it is gated on the
// same capability the analytics screen is — not on the CRM's `dashboard.view`,
// which every signed-in user holds.
router.get('/dashboard', requirePermission(PERMISSIONS.ANALYTICS_VIEW), controller.getAdminDashboard)

// --- Directory -------------------------------------------------------------
router.get('/users', requirePermission(PERMISSIONS.USERS_VIEW), controller.getAdminUsers)

// `invite` before `:id`, so the literal path can never be captured as a user id.
router.post(
  '/users/invite',
  requirePermission(PERMISSIONS.USERS_INVITE),
  inviteLimiter,
  controller.postAdminUserInvite,
)

/**
 * Assigning a starting book of enquiries to a user.
 *
 * Registered before `/users/:id` for the same reason `/users/invite` is: a
 * literal segment must not be captured as an id.
 *
 * Gated on `users.invite` — the capability that creates the account. Stocking
 * it is part of the same act of onboarding, and a caller who may bring somebody
 * into the CRM may decide what they start with. It deliberately does *not*
 * open a way to move enquiries between existing users; that would be a
 * different capability and a different endpoint.
 *
 * `inviteLimiter` is reused rather than given its own budget: this is the same
 * onboarding flow, and a second allowance would only let a caller exhaust the
 * first through the other door. `express.raw` matches the workbook importer's
 * ceiling, so the two agree on what "too large" means.
 */
router.post(
  '/users/:id/leads/import',
  requirePermission(PERMISSIONS.USERS_INVITE),
  inviteLimiter,
  express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
  controller.postAdminUserLeadImport,
)

/**
 * Deleting a user's enquiries.
 *
 * ## Why `leads.delete` alone is not the guard
 *
 * It was, briefly, and that was wrong. **A manager holds `leads.delete`** — the
 * matrix grants it so they can clear their own register through the CRM's
 * routes. Guarding this endpoint on that permission alone would have let a
 * manager purge *any* user's entire book of business, which is a privilege
 * escalation rather than the capability the permission describes.
 *
 * The distinction the CRM already draws is that `leads.delete` says "may delete
 * enquiries", not "may act on another person's account". The second half is
 * what `isOrganizationAdministrator` answers, and `roleMatrix.js` derives that
 * from `USERS_VIEW` — the closest capability to "administers the organization",
 * documented there as deliberately narrower than `roleHasAdminAccess` (which a
 * manager passes, because the console does show them reporting).
 *
 * So both are required, expressed with the middleware already used by
 * `/admin/leads`: the capability being exercised, and the standing to exercise
 * it on somebody else. That is Owner and Admin only — no new permission, no
 * second role system, no hardcoded identities.
 *
 * Registered before `/users/:id` so the literal segment cannot be captured.
 */
router.delete(
  '/users/:id/leads',
  requireAllPermissions([PERMISSIONS.LEADS_DELETE, PERMISSIONS.USERS_VIEW]),
  controller.deleteAdminUserLeads,
)

router.get('/users/:id', requirePermission(PERMISSIONS.USERS_VIEW), controller.getAdminUser)

router.patch(
  '/users/:id/activate',
  requirePermission(PERMISSIONS.USERS_ACTIVATE),
  controller.patchAdminUserActivate,
)
router.patch(
  '/users/:id/suspend',
  requirePermission(PERMISSIONS.USERS_SUSPEND),
  controller.patchAdminUserSuspend,
)

/**
 * Employee profile and documents (Phase 17.1).
 *
 * Read is gated on `users.view` — the same capability that opens the directory,
 * because this is the same information about the same people, in more detail.
 *
 * The verification decisions need `users.manage`... which does not exist, so
 * they use `USERS_DELETE`: the capability the owner and the admin hold and
 * nobody else, and the closest existing match to "may make binding decisions
 * about an employee's record". Introducing a fifth user permission for two
 * endpoints would add a row to the matrix that nobody would ever set
 * independently.
 *
 * There is no admin *write* to somebody else's profile. An administrator can
 * read and can rule on documents; the employee owns their own details. That is
 * deliberate and matches the brief, which gives admins "view" and "verify".
 */
router.get(
  '/users/:id/profile',
  requirePermission(PERMISSIONS.USERS_VIEW),
  profileController.getUserProfile,
)

router.get(
  '/users/:id/documents',
  requirePermission(PERMISSIONS.USERS_VIEW),
  profileController.getUserDocuments,
)

router.get(
  '/users/:id/documents/:documentId/file',
  requirePermission(PERMISSIONS.USERS_VIEW),
  profileController.getUserDocumentFile,
)

router.patch(
  '/users/:id/documents/:documentId/verify',
  requirePermission(PERMISSIONS.USERS_DELETE),
  profileController.verifyUserDocument,
)

router.patch(
  '/users/:id/documents/:documentId/reject',
  requirePermission(PERMISSIONS.USERS_DELETE),
  profileController.rejectUserDocument,
)

/**
 * Employee performance (Phase 17.3).
 *
 * ## Two permissions, for the same reason the trend endpoint needs two
 *
 * A performance dashboard is a report **about a named individual** — their
 * output, their attendance, their standing against colleagues. That is a
 * different disclosure from an aggregate, so it requires `users.view` (may read
 * about a person) *and* `analytics.view` (may read across people), exactly as
 * `/analytics/users/:id` has since 14.6.
 *
 * A manager holds `analytics.view` but not `users.view`, so they see the
 * leaderboard and the highlights and not an individual's dashboard. That is the
 * existing matrix answering the question, not a new rule invented here.
 *
 * `heavyReadLimiter` applies to all of them: each runs nine concurrent
 * aggregations, which is cheap for an operator reading a screen and expensive
 * for a tab left polling.
 */
router.get(
  '/users/:id/performance',
  requireAllPermissions([PERMISSIONS.ANALYTICS_VIEW, PERMISSIONS.USERS_VIEW]),
  heavyReadLimiter,
  controller.getAdminUserPerformanceDashboard,
)

/**
 * Soft delete and restore (Phase 15.2).
 *
 * `users.delete` is held by the owner and the admin. Which *targets* each may
 * act on is decided inside the service by the same seniority rule role changes
 * use — an admin reaching this route is still refused when the target is an
 * owner or another admin, and nobody may delete themselves or the last owner.
 *
 * `DELETE` here removes access, never the document. The "never physically
 * delete a user" rule from Phase 14.3A is intact and is what the service
 * implements.
 */
router.delete(
  '/users/:id',
  requirePermission(PERMISSIONS.USERS_DELETE),
  controller.deleteAdminUser,
)

router.post(
  '/users/:id/restore',
  requirePermission(PERMISSIONS.USERS_DELETE),
  controller.postAdminUserRestore,
)

/**
 * Identity linking (Phase 14.8C).
 *
 * Guarded on `roles.manage`, not `users.manage`. Linking a Microsoft address to
 * an owner grants the highest privilege in the deployment through the
 * organization door — so it needs the same capability as granting that role,
 * and the service additionally refuses anybody who could not have granted the
 * target's role in the first place. Gating it lower would be a way around the
 * role rules.
 *
 * `DELETE` is the first one in this module. It removes a *link*, not an
 * account — the "never physically delete users" rule is intact, and unlinking
 * refuses when Microsoft is the only way into the account.
 */
router.put(
  '/users/:id/microsoft-identity',
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  controller.putAdminUserMicrosoftIdentity,
)

router.delete(
  '/users/:id/microsoft-identity',
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  controller.deleteAdminUserMicrosoftIdentity,
)

/*
 * The Google equivalent, and the same capability.
 *
 * Its usual subject is a *removed* account whose Google identity is blocking
 * the replacement account from ever signing in — the case the sign-in service
 * refuses and tells an operator to resolve here.
 */
router.delete(
  '/users/:id/google-identity',
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  controller.deleteAdminUserGoogleIdentity,
)

/** Whether the organization has been claimed. Read-only. */
router.get(
  '/organization/bootstrap',
  requirePermission(PERMISSIONS.ORGANIZATION_VIEW),
  controller.getAdminBootstrapStatus,
)

/**
 * Role management (Phase 14.8A).
 *
 * `roles.manage` is the gate; it is held by the owner and the admin. Which
 * roles each may actually grant, and to whom, is decided inside the service by
 * `canAssignRole` — an admin reaching this route is still refused when they try
 * to mint an owner or modify a peer.
 *
 * The read is guarded on the same permission as the write. It reveals which
 * accounts the caller could promote, which is not information somebody without
 * the capability needs.
 */
router.get(
  '/users/:id/role',
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  controller.getAdminUserRole,
)

router.patch(
  '/users/:id/role',
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  controller.patchAdminUserRole,
)

// --- Roles -----------------------------------------------------------------
// Serves the matrix that is actually enforced, rather than a second description
// of it that can drift from the code.
router.get('/roles', requirePermission(PERMISSIONS.ROLES_VIEW), controller.getAdminRoles)

/*
 * Rewriting a role definition. Gated on `roles.manage`, the permission the
 * matrix already names for exactly this, rather than on a role comparison —
 * which is the rule the rest of the product follows and the reason a permission
 * system exists at all.
 *
 * Who may edit *which* role, and what they may put in it, is decided in the
 * service against the request's own actor: holding `roles.manage` opens the
 * door, it does not decide what is behind it.
 */
router.patch(
  '/roles/:role',
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  controller.patchAdminRolePermissions,
)

// --- Mailboxes -------------------------------------------------------------
//
// Reads need `mailboxes.view`; changing who may use a mailbox needs
// `mailboxes.assign`; changing whose default it is needs `mailboxes.default`.
// Three separate capabilities because they are three separate decisions - the
// last one changes which address a customer hears from.
router.get('/mailboxes', requirePermission(PERMISSIONS.MAILBOXES_VIEW), controller.getAdminMailboxes)
router.get('/mailboxes/:id', requirePermission(PERMISSIONS.MAILBOXES_VIEW), controller.getAdminMailbox)

router.post(
  '/mailboxes/:id/assign',
  requirePermission(PERMISSIONS.MAILBOXES_ASSIGN),
  controller.postAdminMailboxAssign,
)
router.post(
  '/mailboxes/:id/unassign',
  requirePermission(PERMISSIONS.MAILBOXES_ASSIGN),
  controller.postAdminMailboxUnassign,
)
router.patch(
  '/mailboxes/:id/default',
  requirePermission(PERMISSIONS.MAILBOXES_DEFAULT),
  controller.patchAdminMailboxDefault,
)

// The user-side view of the same relationship. Reading it needs both
// capabilities: it is a fact about a person *and* about mailboxes.
router.get(
  '/users/:id/mailboxes',
  requireAllPermissions([PERMISSIONS.USERS_VIEW, PERMISSIONS.MAILBOXES_VIEW]),
  controller.getAdminUserMailboxes,
)
router.put(
  '/users/:id/mailboxes',
  requirePermission(PERMISSIONS.MAILBOXES_ASSIGN),
  controller.putAdminUserMailboxes,
)

// --- Reporting -------------------------------------------------------------
router.get(
  '/analytics',
  requirePermission(PERMISSIONS.ANALYTICS_VIEW),
  heavyReadLimiter,
  controller.getAdminAnalytics,
)

// --- Analytics platform (Phase 14.6) ---------------------------------------
//
// All read-only, all aggregated live, all behind `analytics.view` - the same
// capability that already gates cross-user reporting. `heavyReadLimiter`
// applies to each: these run several aggregations per request, which is cheap
// for an operator and expensive for a tab left polling.
router.get(
  '/analytics/team',
  requirePermission(PERMISSIONS.ANALYTICS_VIEW),
  heavyReadLimiter,
  controller.getAdminTeamPerformance,
)

// One person's trend. Needs `users.view` as well: it is a report *about a named
// individual*, which is a different disclosure from an aggregate.
router.get(
  '/analytics/users/:id',
  requireAllPermissions([PERMISSIONS.ANALYTICS_VIEW, PERMISSIONS.USERS_VIEW]),
  heavyReadLimiter,
  controller.getAdminUserPerformance,
)

/**
 * The performance widgets and the comparison (Phase 17.3).
 *
 * Aggregates across the team, so `analytics.view` alone — the same bar as the
 * leaderboard they summarise.
 *
 * An employee's own report is **not** here. It lives on `/v1/profile/performance`
 * beside the rest of the self routes, where the subject comes from the session
 * and there is no id in the URL to change.
 */
router.get(
  '/performance/highlights',
  requirePermission(PERMISSIONS.ANALYTICS_VIEW),
  heavyReadLimiter,
  controller.getAdminPerformanceHighlights,
)

router.get(
  '/performance/compare',
  requireAllPermissions([PERMISSIONS.ANALYTICS_VIEW, PERMISSIONS.USERS_VIEW]),
  heavyReadLimiter,
  controller.getAdminPerformanceComparison,
)

router.get(
  '/analytics/mailboxes',
  requireAllPermissions([PERMISSIONS.ANALYTICS_VIEW, PERMISSIONS.MAILBOXES_VIEW]),
  heavyReadLimiter,
  controller.getAdminMailboxAnalytics,
)

router.get(
  '/analytics/leads',
  requireAllPermissions([PERMISSIONS.ANALYTICS_VIEW, PERMISSIONS.LEADS_VIEW]),
  heavyReadLimiter,
  controller.getAdminLeadAnalytics,
)

router.get(
  '/activity',
  requirePermission(PERMISSIONS.ANALYTICS_VIEW),
  heavyReadLimiter,
  controller.getAdminActivity,
)

// --- Cross-user monitoring -------------------------------------------------
//
// Two permissions, and the second is the important one.
//
// `campaigns.view` and `leads.view` are held by every role — they are what let
// somebody use the CRM at all. But these endpoints are not the CRM's: they read
// **across every user in the deployment**, where `/api/v1/leads` returns only
// the caller's own.
//
// Guarding them on the resource permission alone therefore granted a Viewer
// strictly more than the CRM does — the whole business's pipeline, by direct
// request, from an account that cannot even open the console. The role matrix
// test caught it.
//
// So they require the resource permission *and* `analytics.view`, which is this
// system's "may read across users" capability. That is precisely what
// `requireAllPermissions` is for: an action that genuinely combines two.
router.get(
  '/campaigns',
  requireAllPermissions([PERMISSIONS.CAMPAIGNS_VIEW, PERMISSIONS.ANALYTICS_VIEW]),
  controller.getAdminCampaigns,
)
router.get(
  '/leads',
  requireAllPermissions([PERMISSIONS.LEADS_VIEW, PERMISSIONS.ANALYTICS_VIEW]),
  controller.getAdminLeads,
)

/**
 * The dashboard calendar.
 *
 * The same two capabilities as the monitor above, for the same reason: this
 * counts and lists enquiries and tasks belonging to every user in the
 * deployment. `/calendar/:date` is registered after the literal `/calendar` so
 * the parameter cannot swallow it.
 */
router.get(
  '/calendar',
  requireAllPermissions([PERMISSIONS.LEADS_VIEW, PERMISSIONS.ANALYTICS_VIEW]),
  heavyReadLimiter,
  controller.getAdminCalendar,
)
router.get(
  '/calendar/:date',
  requireAllPermissions([PERMISSIONS.LEADS_VIEW, PERMISSIONS.ANALYTICS_VIEW]),
  heavyReadLimiter,
  controller.getAdminCalendarDay,
)

/**
 * One enquiry, for the console.
 *
 * The same pair of capabilities the list above requires — reading one row and
 * reading the page it came from are the same act. A manager holding neither is
 * refused here exactly as they are there.
 */
router.get(
  '/leads/:id',
  requireAllPermissions([PERMISSIONS.LEADS_VIEW, PERMISSIONS.ANALYTICS_VIEW]),
  controller.getAdminLeadDetail,
)

// --- Platform --------------------------------------------------------------
// `system-health`, deliberately not `health`: `/api/v1/health` is the public,
// shallow, unauthenticated probe a load balancer polls, and two endpoints whose
// paths differ only by prefix is how somebody points a monitor at the wrong one.
router.get(
  '/system-health',
  requirePermission(PERMISSIONS.SYSTEMHEALTH_VIEW),
  heavyReadLimiter,
  controller.getAdminSystemHealth,
)

// Registered before any future `/audit` collection route, so `summary` can never
// be captured as an entry id.
router.get('/audit/summary', requirePermission(PERMISSIONS.AUDIT_VIEW), controller.getAdminAuditSummary)

router.get(
  '/organization',
  requirePermission(PERMISSIONS.ORGANIZATION_VIEW),
  controller.getAdminOrganization,
)

export default router
