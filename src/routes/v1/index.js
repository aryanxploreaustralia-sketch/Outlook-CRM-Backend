/**
 * API v1 router.
 *
 * Every v1 resource is mounted here. Versioning at the router level means a
 * future v2 can be introduced alongside v1 without breaking existing clients.
 */

import { Router } from 'express'

import accountRoutes from './account.routes.js'
import auditRoutes from '../../modules/audit/routes/audit.routes.js'
import profileRoutes from '../../modules/profile/routes/profile.routes.js'
import adminRoutes from '../../modules/admin/routes/admin.routes.js'
import authRoutes from './auth.routes.js'
import dashboardRoutes from './dashboard.routes.js'
import healthRoutes from './health.routes.js'
import mailRoutes from './mail.routes.js'
import mailboxRoutes from '../../modules/provider/routes/mailbox.routes.js'
import providerRoutes from '../../modules/provider/routes/provider.routes.js'
import {
  contactGroupRouter,
  contactRouter,
} from '../../modules/contacts/routes/contact.routes.js'
import importRoutes from '../../modules/import/routes/import.routes.js'
import campaignRoutes from '../../modules/campaigns/routes/campaign.routes.js'
import { companyRouter, leadRouter } from '../../modules/leads/routes/lead.routes.js'
import conversationRoutes from '../../modules/conversations/routes/conversation.routes.js'
import notificationCentreRoutes from '../../modules/notifications/routes/notification.routes.js'
import searchRoutes from '../../modules/search/routes/search.routes.js'
import syncRoutes from '../../modules/sync/routes/sync.routes.js'
import { goalRouter, taskRouter } from '../../modules/tasks/routes/task.routes.js'
import schedulerRoutes from '../../modules/scheduler/routes/scheduler.routes.js'
import templateRoutes from '../../modules/templates/routes/template.routes.js'
import workbookRoutes from './workbook.routes.js'

const router = Router()

// Public / partially public.
router.use('/health', healthRoutes)
router.use('/auth', authRoutes)

// Authenticated. Each of these routers applies `requireAuth` internally.
router.use('/dashboard', dashboardRoutes)
router.use('/account', accountRoutes)
router.use('/mail', mailRoutes)

// Phase 5 — provider abstraction and mailbox synchronisation. Unchanged: it
// still addresses the workspace's resolved mailbox in the singular.
router.use('/provider', providerRoutes)

// Phase 13.2 — connected mailboxes. Google authenticates the CRM user; this is
// where that user attaches the Microsoft mailboxes the CRM may send and read
// through. Separate from `/auth` on purpose: signing in and authorising a
// mailbox became two different questions in this phase.
router.use('/mailboxes', mailboxRoutes)

// Phase 6 — contacts and address book.
router.use('/contacts', contactRouter)
router.use('/contact-groups', contactGroupRouter)

// Phase 7 — Excel import engine, the primary path for creating contacts.
router.use('/import', importRoutes)

// Phase 8 — campaign engine: bulk outreach, queue, sequences and analytics.
router.use('/campaigns', campaignRoutes)

// Phase 8 — the travel sales register. Companies employ contacts; contacts
// raise leads; campaigns target leads.
router.use('/leads', leadRouter)
router.use('/companies', companyRouter)

// Phase 9 — the reply CRM. Every customer answer becomes part of its enquiry's
// business history, so nobody has to go looking in Outlook.
router.use('/conversations', conversationRoutes)

// Phase 11 — the email template engine. The ACTIVE template is what the morning
// workbook run sends, so the wording of every automatic message is configured
// here rather than in code. Shares the library the campaign builder has always
// used; `/campaigns/templates` continues to behave exactly as before.
router.use('/templates', templateRoutes)

// Phase H2 — background workbook execution. The upload returns a job id and the
// run continues in a worker, so a large import is never bounded by how long a
// proxy will hold a connection open. `/leads/workbook/*` is unchanged and still
// runs synchronously for callers that want to wait for the summary.
router.use('/workbook', workbookRoutes)

// Phase H3 — the morning scheduler. Decides *when* the run above starts and
// nothing else: it finds the day's workbook and enqueues it through the same
// `/workbook` queue, so an automatic run and a manual upload are the same run.
router.use('/scheduler', schedulerRoutes)

// Phase H4 — the notification bell. Written by the reply-sync ingestion, which
// is the only place that knows a customer answered; this only reads them back.
/**
 * Phase 15.1 — the notification centre.
 *
 * Replaces the three routes the conversations module served. The replacement is
 * compatible: `GET /`, `POST /:id/read` and `POST /read-all` keep their paths
 * and response shapes, so nothing that called them needed changing. It adds
 * `GET /unread`, `DELETE /:id`, filtering, search and grouping.
 */
router.use('/notifications', notificationCentreRoutes)

/**
 * Phase 15.1 — global search.
 *
 * One endpoint across nine sources. Authentication only at the route; the
 * permission check is per source inside the service, where a source the caller
 * cannot read is never queried.
 */
router.use('/search', searchRoutes)

/**
 * Offline-first Phase 2 — the incremental change feed.
 *
 * Additive by construction. It reads the same collections the modules above
 * own, through the same owner scoping, and writes to none of them — so it can
 * be added without touching any of them, and removing this line removes the
 * feature entirely.
 *
 * Registered before `/admin` for the same reason the others are: this is a
 * user-facing surface, scoped to the caller.
 */
router.use('/sync', syncRoutes)

// Phase 14.2 — the Enterprise Admin Platform, read side.
//
// Every route beneath this prefix is a GET: the module registers no other verb,
// so a write falls through to `notFoundHandler`. It aggregates from the
// collections the modules above already own and writes to none of them, which is
// what lets it be added without touching any of them.
//
// Mounted last so it is unambiguous that nothing here shadows an existing path.
/**
 * Phase 17.1 — employee self-service profile.
 *
 * A sibling of `/admin`, not a child: this is the surface an *employee* uses
 * for their own record, and every route is scoped to the caller. The admin
 * views of the same data live under `/admin/users/:id/...`.
 */
router.use('/profile', profileRoutes)

/**
 * Phase 18 — assigned work and the targets set against it.
 *
 * CRM routes rather than admin ones: the people who use them are the people
 * doing the work, and most of them hold no admin capability at all. Assigning
 * and goal-setting are gated inside the module on `users.delete`, which is what
 * keeps the management half owner-and-admin without a new permission.
 *
 * Two routers from one module because they are two resources with one domain —
 * a goal is a target over the same work a task records.
 */
router.use('/tasks', taskRouter)
router.use('/goals', goalRouter)

router.use('/admin', adminRoutes)

// Phase 14.7 — the audit log.
//
// A sibling of `/admin` rather than a child of it, because the log is not an
// admin *view* of another module's data: it is its own collection, written by
// every module and read through one permission. Nesting it under `/admin` would
// imply the admin console owns it, and the recording side does not live there.
//
// GET only. There is no endpoint that can create or delete an entry.
router.use('/audit', auditRoutes)

export default router
