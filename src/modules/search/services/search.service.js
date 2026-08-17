/**
 * Global search.
 *
 * ## Permission is a filter, not a post-filter
 *
 * Each source declares the permission it needs. A source the caller does not
 * hold is **never queried** — it is dropped before any database work happens,
 * rather than searched and then stripped from the response. The difference
 * matters twice: a viewer's search does not read the audit log at all, and a
 * mistake in the response shaping cannot leak a row that was never fetched.
 *
 * On top of that, the two sources that are per-person rather than
 * organization-wide — mailboxes and notifications — are scoped by owner inside
 * their own query, reusing the filters the rest of the product already uses
 * (`scopedMailboxFilter`, owner equality). Search does not invent a second
 * definition of "yours".
 *
 * ## Every source runs in parallel and fails independently
 *
 * One unreadable collection costs its own group, not the search. A source that
 * throws is reported with `available: false` and a reason, so the console can
 * say "companies could not be searched" instead of implying there were none.
 *
 * ## Why not one aggregation
 *
 * Nine `$unionWith` stages against nine differently-shaped collections produces
 * a query nobody can read and a plan nobody can predict, to save eight round
 * trips that already run concurrently against indexes.
 */

import { Campaign } from '../../../models/campaign.model.js'
import { Company } from '../../../models/company.model.js'
import { Lead } from '../../../models/lead.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { User } from '../../../models/user.model.js'
import { AuditLog } from '../../../models/auditLog.model.js'
import { CampaignTemplate } from '../../../models/campaignTemplate.model.js'
import { Notification } from '../../../models/notification.model.js'
import { OrganizationBootstrap } from '../../../models/organizationBootstrap.model.js'
import { PERMISSIONS } from '../../../constants/permissions.js'
import { LEAD_STAGE_LABELS } from '../../leads/constants/leadConstants.js'
import { scopedMailboxFilter } from '../../../constants/mailboxAccess.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('search')

/** How many rows one group may contribute. The palette shows a handful. */
const PER_GROUP = 5

/**
 * Escapes a caller-supplied term before it reaches a regex.
 *
 * Every source below uses a prefix/substring regex rather than `$text`, because
 * search-as-you-type must match partial words — a `$text` index would not find
 * "enq" in "enquiry@…", which is most of what anybody types into a palette.
 * That makes escaping mandatory: an unescaped `(` is a syntax error and an
 * unescaped `.*` is a scan.
 */
function pattern(term) {
  return new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

/**
 * The sources, in the order the palette renders them.
 *
 * Each declares its permission, its icon and how to turn a document into a
 * result. Declaring them as data rather than as nine hand-written blocks is
 * what keeps the permission check impossible to skip: the runner applies it
 * uniformly, so a source added later cannot forget one.
 *
 * @type {ReadonlyArray<object>}
 */
export const SEARCH_SOURCES = Object.freeze([
  {
    key: 'users',
    label: 'Users',
    icon: 'users',
    permission: PERMISSIONS.USERS_VIEW,
    async run(term, { limit }) {
      const rx = pattern(term)

      const rows = await User.find({
        isDeleted: { $ne: true },
        $or: [{ displayName: rx }, { email: rx }, { microsoftEmail: rx }],
      })
        .select('displayName email role microsoftEmail')
        .limit(limit)
        .lean()

      return rows.map((row) => ({
        id: String(row._id),
        title: row.displayName ?? row.email,
        subtitle: row.email,
        badge: row.role,
        url: `/admin/users/${row._id}`,
      }))
    },
  },
  {
    key: 'companies',
    label: 'Companies',
    icon: 'building',
    permission: PERMISSIONS.COMPANIES_VIEW,
    async run(term, { limit, userId }) {
      const rx = pattern(term)

      const rows = await Company.find({
        owner: userId,
        isDeleted: { $ne: true },
        $or: [{ companyName: rx }, { primaryEmail: rx }],
      })
        .select('companyName primaryEmail leadCount')
        .limit(limit)
        .lean()

      return rows.map((row) => ({
        id: String(row._id),
        title: row.companyName,
        subtitle: row.primaryEmail ?? null,
        url: `/companies/${row._id}`,
      }))
    },
  },
  {
    /**
     * Every enquiry in the deployment, found by reference.
     *
     * Additive: the owner-scoped `leads` source below is untouched and still
     * answers for everybody. This one is a **second** source that only an
     * organization administrator can see, because a source the caller lacks the
     * permission for is never run — the runner applies that, so it cannot be
     * skipped here.
     *
     * ## Why `users.view`
     *
     * `roleMatrix` treats it as the marker for "administers the organization",
     * which is Owner and Admin. A manager holds `leads.view` and would pass a
     * lead-shaped permission, but must not gain cross-user lead access — so the
     * gate is the standing to act across accounts, not the capability to read
     * an enquiry.
     *
     * ## Reference only, and why
     *
     * An administrator searching globally is looking up a known reference, not
     * browsing. Matching contact names or companies across every user would
     * flood the palette with other people's pipeline on a two-letter term.
     * Anchored so the index on `reference` is usable: this is a prefix scan,
     * never a full-collection regex.
     */
    key: 'adminLeads',
    label: 'Enquiries (all users)',
    icon: 'target',
    permission: PERMISSIONS.USERS_VIEW,
    async run(term, { limit }) {
      const trimmed = String(term ?? '').trim()
      if (!trimmed) return []

      // Anchored, case-insensitive prefix: "xamp14" and "XAMP1408" both work,
      // and an exact reference is simply the longest prefix of itself.
      const anchored = new RegExp(
        `^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        'i',
      )

      const rows = await Lead.find({ reference: anchored, isDeleted: { $ne: true } })
        .select('reference contactPerson companyName stage owner')
        .sort({ reference: 1 })
        .limit(limit)
        .lean()

      if (rows.length === 0) return []

      // One lookup for every owner on the page, not one per row.
      const ownerIds = [...new Set(rows.map((row) => String(row.owner)).filter(Boolean))]
      const owners = await User.find({ _id: { $in: ownerIds } })
        .select('displayName email')
        .lean()
      const nameById = new Map(
        owners.map((user) => [String(user._id), user.displayName ?? user.email ?? 'Unknown user']),
      )

      return rows.map((row) => ({
        id: String(row._id),
        title: row.reference,
        subtitle: [
          row.contactPerson,
          row.companyName,
          `Owner: ${nameById.get(String(row.owner)) ?? 'unknown'}`,
          LEAD_STAGE_LABELS[row.stage] ?? row.stage,
        ]
          .filter(Boolean)
          .join(' · '),
        // The admin-scoped detail route. The CRM's own is owner-scoped and
        // would refuse another user's enquiry.
        url: `/admin/leads/${row._id}`,
      }))
    },
  },
  {
    key: 'leads',
    label: 'Enquiries',
    icon: 'target',
    permission: PERMISSIONS.LEADS_VIEW,
    async run(term, { limit, userId }) {
      const rx = pattern(term)

      const rows = await Lead.find({
        owner: userId,
        isDeleted: { $ne: true },
        $or: [{ reference: rx }, { contactPerson: rx }, { companyName: rx }, { city: rx }],
      })
        .select('reference contactPerson companyName stage')
        .limit(limit)
        .lean()

      return rows.map((row) => ({
        id: String(row._id),
        title: row.contactPerson ?? row.reference,
        subtitle: [row.reference, row.companyName].filter(Boolean).join(' · ') || null,
        badge: row.stage,
        url: `/leads/${row._id}`,
      }))
    },
  },
  {
    key: 'campaigns',
    label: 'Campaigns',
    icon: 'megaphone',
    permission: PERMISSIONS.CAMPAIGNS_VIEW,
    async run(term, { limit, userId }) {
      const rx = pattern(term)

      const rows = await Campaign.find({ owner: userId, name: rx })
        .select('name status stats')
        .limit(limit)
        .lean()

      return rows.map((row) => ({
        id: String(row._id),
        title: row.name,
        subtitle: row.stats?.recipients ? `${row.stats.recipients} recipients` : null,
        badge: row.status,
        url: `/campaigns/${row._id}`,
      }))
    },
  },
  {
    key: 'mailboxes',
    label: 'Mailboxes',
    icon: 'inbox',
    permission: PERMISSIONS.MAILBOXES_VIEW,
    async run(term, { limit, userId }) {
      const rx = pattern(term)

      /**
       * Scoped with the product's own access filter, not a fresh one.
       *
       * `scopedMailboxFilter` is what every other mailbox read uses — owner or
       * assignee. Writing `{ user: userId }` here would silently exclude every
       * mailbox somebody was *assigned* in Phase 14.5, and search would
       * disagree with the mailbox list about what they can see.
       */
      const rows = await Mailbox.find(
        scopedMailboxFilter(userId, { $or: [{ emailAddress: rx }, { displayName: rx }] }),
      )
        .select('emailAddress displayName status')
        .limit(limit)
        .lean()

      return rows.map((row) => ({
        id: String(row._id),
        title: row.emailAddress,
        subtitle: row.displayName ?? null,
        badge: row.status,
        url: '/admin/mailboxes',
      }))
    },
  },
  {
    key: 'templates',
    label: 'Templates',
    icon: 'file-text',
    permission: PERMISSIONS.TEMPLATES_VIEW,
    async run(term, { limit, userId }) {
      const rx = pattern(term)

      const rows = await CampaignTemplate.find({
        owner: userId,
        isDeleted: { $ne: true },
        $or: [{ name: rx }, { subject: rx }],
      })
        .select('name subject status version')
        .limit(limit)
        .lean()

      return rows.map((row) => ({
        id: String(row._id),
        title: row.name,
        subtitle: row.subject ?? null,
        badge: row.status,
        url: `/templates/${row._id}`,
      }))
    },
  },
  {
    key: 'notifications',
    label: 'Notifications',
    icon: 'bell',
    /**
     * No permission. A notification belongs to the caller, so "may they read
     * it" is answered by the owner scope below — the same reasoning the
     * notification routes use.
     */
    permission: null,
    async run(term, { limit, userId }) {
      const rx = pattern(term)

      const rows = await Notification.find({
        owner: userId,
        isDeleted: { $ne: true },
        $or: [{ title: rx }, { body: rx }],
      })
        .sort({ occurredAt: -1 })
        .select('title body type link occurredAt isRead')
        .limit(limit)
        .lean()

      return rows.map((row) => ({
        id: String(row._id),
        title: row.title,
        subtitle: row.body ?? null,
        badge: row.isRead ? null : 'unread',
        url: row.link ?? '/notifications',
      }))
    },
  },
  {
    key: 'audit',
    label: 'Audit log',
    icon: 'file-clock',
    permission: PERMISSIONS.AUDIT_VIEW,
    async run(term, { limit }) {
      const rx = pattern(term)

      const rows = await AuditLog.find({ $or: [{ summary: rx }, { actorEmail: rx }, { entityName: rx }] })
        .sort({ occurredAt: -1 })
        .select('summary actorEmail action occurredAt')
        .limit(limit)
        .lean()

      return rows.map((row) => ({
        id: String(row._id),
        title: row.summary,
        subtitle: row.actorEmail ?? null,
        url: `/admin/audit?q=${encodeURIComponent(row.summary?.slice(0, 40) ?? '')}`,
      }))
    },
  },
  {
    key: 'organization',
    label: 'Organization',
    icon: 'building-2',
    permission: PERMISSIONS.ORGANIZATION_VIEW,
    async run(term, { limit }) {
      const rx = pattern(term)

      /**
       * There is no `Organization` entity in this product — the tenancy gap
       * documented since Phase 14.0. What exists is the bootstrap record, which
       * is the one piece of organization-level identity there is. Returning it
       * is honest; inventing an organization to search would not be.
       */
      const rows = await OrganizationBootstrap.find({
        $or: [{ ownerEmail: rx }, { microsoftEmail: rx }],
      })
        .limit(limit)
        .lean()

      return rows.map((row) => ({
        id: String(row._id),
        title: 'Organization',
        subtitle: `Claimed by ${row.ownerEmail ?? 'unknown'}`,
        url: '/admin/organization',
      }))
    },
  },
])

/**
 * Runs every source the caller is allowed to read.
 *
 * @param {object} params
 * @param {string} params.term
 * @param {object} params.user      `req.auth.user`
 * @param {Set}    params.permissions Effective permissions, already resolved.
 * @param {number} [params.limit]   Per group.
 * @param {string[]} [params.only]  Restrict to named sources.
 */
export async function search({ term, user, permissions, limit = PER_GROUP, only = null }) {
  const allowed = SEARCH_SOURCES.filter((source) => {
    if (only && !only.includes(source.key)) return false
    // The permission check. A source the caller cannot read is never queried.
    return source.permission === null || permissions.has(source.permission)
  })

  const context = { limit, userId: user._id }

  const settled = await Promise.all(
    allowed.map(async (source) => {
      try {
        const results = await source.run(term, context)

        return {
          key: source.key,
          label: source.label,
          icon: source.icon,
          permission: source.permission,
          available: true,
          results: results.map((result) => ({
            ...result,
            type: source.key,
            icon: source.icon,
            permission: source.permission,
          })),
        }
      } catch (error) {
        // One unreadable collection costs its own group, not the search.
        log.warn(`Search source "${source.key}" failed`, { message: error.message })

        return {
          key: source.key,
          label: source.label,
          icon: source.icon,
          permission: source.permission,
          available: false,
          reason: 'This source could not be searched.',
          results: [],
        }
      }
    }),
  )

  // Empty groups are dropped so the palette never renders a heading above
  // nothing — but a *failed* group is kept, because "could not search" is
  // information and silence would read as "no matches".
  const groups = settled.filter((group) => group.results.length > 0 || !group.available)

  return {
    term,
    groups,
    total: groups.reduce((sum, group) => sum + group.results.length, 0),

    /**
     * Which sources were skipped for lack of permission.
     *
     * Reported so the console can be honest about the search being partial,
     * without naming what is in them. A reader who cannot see the audit log
     * should know their search did not cover it.
     */
    skipped: SEARCH_SOURCES.filter(
      (source) => source.permission !== null && !permissions.has(source.permission),
    ).map((source) => source.key),

    meta: { source: 'live', limitPerGroup: limit, generatedAt: new Date().toISOString() },
  }
}

export default { SEARCH_SOURCES, search }
