/**
 * Cross-user monitoring: campaigns and enquiries.
 *
 * ## Why these two exist when the brief listed seven endpoints
 *
 * Phase 14.1 shipped a Campaign monitor and a Lead monitor screen, and the
 * objective of this phase is to replace their placeholder data with real data.
 * The brief's endpoint list does not name them, and the honest options were to
 * delete two working screens, leave them permanently empty, or serve them.
 *
 * Serving them is the only one that meets the objective, and it costs nothing
 * the brief was protecting: both are `GET`, both are in this module, both read
 * collections the CRM already owns, and neither touches the campaign engine or
 * the lead engine — they read the same documents those engines write.
 *
 * They are flagged as an addition in the phase report so they can be dropped if
 * that was not wanted.
 *
 * ## Read-only, like everything here
 *
 * No campaign is paused, resumed or cancelled from this module. The console's
 * controls stay disabled until Phase 14.4, at which point they call the campaign
 * module's existing `control` service rather than a second implementation of it.
 */

import { ApiError } from '../../../utils/ApiError.js'
import { Campaign } from '../../../models/campaign.model.js'
import { Lead } from '../../../models/lead.model.js'
import { Company } from '../../../models/company.model.js'
import { Contact } from '../../../models/contact.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { User } from '../../../models/user.model.js'
import { CAMPAIGN_STATUS_LABELS } from '../../campaigns/constants/campaignConstants.js'
import {
  LEAD_STAGE,
  LEAD_STAGE_LABELS,
  MARKET_LABELS,
  MARKET_VALUES,
  WON_STAGES,
} from '../../leads/constants/leadConstants.js'
import { AUTO_MAIL_STATUS, AUTO_MAIL_STATUS_VALUES } from '../../leads/constants/syncConstants.js'
import { ACTIVE_LEAD_DAYS, STALE_LEAD_DAYS } from '../constants/adminConstants.js'
import { resolveRange } from '../validators/adminAnalytics.validator.js'

/** Escapes a caller-supplied search term before it reaches a regex. */
/** Escapes a user-supplied term so it cannot smuggle regex syntax into a query. */
function escapeRegex(term) {
  return String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function safePattern(term) {
  return new RegExp(escapeRegex(term), 'i')
}

/** Resolves a set of user ids to display names in one query. */
async function nameMap(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))]
  if (unique.length === 0) return new Map()

  const users = await User.find({ _id: { $in: unique } })
    .select('displayName email')
    .lean()

  return new Map(
    users.map((user) => [String(user._id), user.displayName ?? user.email ?? 'Unknown user']),
  )
}

/**
 * Every campaign in the deployment, with its owner and sending mailbox.
 *
 * The counters come from `Campaign.stats`, which the campaign engine maintains
 * as it sends. Recounting from `CampaignRecipient` would be one aggregation per
 * campaign and could disagree with the number the campaign's own detail page
 * shows — and there would be no way to say which was right.
 */
export async function listAdminCampaigns(query = {}) {
  /*
   * `limit` defaults to 200 — the fixed ceiling this function used before it
   * accepted paging — so every existing caller behaves exactly as it did. The
   * admin user profile passes a smaller page size and a page number.
   */
  const { status, search, owner, page = 1, limit = 200 } = query

  const filter = {}
  if (status) filter.status = status
  if (search) filter.name = safePattern(search)

  /*
   * Scopes the monitor to one person, for the admin user profile.
   *
   * Filtered here rather than on the returned page. The console used to fetch
   * this list unscoped and match `ownerId` in the browser, which silently
   * capped a user's register at whatever fell inside the first 200 rows
   * globally — so a busy consultant's campaigns could be missing with nothing
   * on screen to say so. Absent means every owner, which is what the monitor
   * page itself asks for.
   */
  if (owner) filter.owner = owner

  const [campaigns, total] = await Promise.all([
    Campaign.find(filter)
      .select('name status owner senderMailboxes stats startedAt completedAt createdAt lastError')
      .sort({ startedAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    // Across everything the filter matches, not just this page.
    Campaign.countDocuments(filter),
  ])

  const [owners, mailboxes] = await Promise.all([
    nameMap(campaigns.map((campaign) => campaign.owner)),
    Mailbox.find({ _id: { $in: campaigns.flatMap((campaign) => campaign.senderMailboxes ?? []) } })
      .select('emailAddress')
      .lean(),
  ])

  const mailboxById = new Map(mailboxes.map((mailbox) => [String(mailbox._id), mailbox.emailAddress]))

  const items = campaigns.map((campaign) => {
    const stats = campaign.stats ?? {}

    return {
      id: String(campaign._id),
      name: campaign.name,
      status: campaign.status,
      statusLabel: CAMPAIGN_STATUS_LABELS[campaign.status] ?? campaign.status,
      owner: owners.get(String(campaign.owner)) ?? 'Unknown user',
      /**
       * The owner's id, alongside their name.
       *
       * Added in Phase 14.5.1 for the per-user dashboard, which needs to select
       * one person's campaigns. The row already carried the owner - as a display
       * name - and filtering on that would attribute one person's campaigns to
       * another whenever two names collide or a name is absent and falls back to
       * an address. On an administration screen that is a correctness problem,
       * not a cosmetic one.
       *
       * Purely additive: every existing consumer reads `owner` and is unaffected.
       */
      ownerId: String(campaign.owner),
      mailbox:
        (campaign.senderMailboxes ?? [])
          .map((id) => mailboxById.get(String(id)))
          .filter(Boolean)
          .join(', ') || null,
      recipients: stats.recipients ?? 0,
      sent: stats.sent ?? 0,
      replies: stats.replied ?? 0,
      failed: (stats.failed ?? 0) + (stats.bounced ?? 0),
      startedAt: campaign.startedAt ?? null,
      completedAt: campaign.completedAt ?? null,
      createdAt: campaign.createdAt,
      lastError: campaign.lastError?.message ?? null,
    }
  })

  return {
    /*
     * `pagination` is additive. Existing consumers read `items` and `summary`
     * and are unaffected; only the user profile reads this.
     */
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrevious: page > 1,
    },
    items,
    summary: {
      total: items.length,
      running: items.filter((item) => item.status === 'running').length,
      scheduled: items.filter((item) => item.status === 'scheduled').length,
      recipients: items.reduce((total, item) => total + item.recipients, 0),
      failed: items.reduce((total, item) => total + item.failed, 0),
    },
  }
}

/**
 * Every enquiry in the deployment, with the two attention flags.
 *
 * ## `assignedTo` is reported as the owner, and that is not a fudge
 *
 * `Lead` has `owner` and `createdBy` but no `assignedTo` — the Phase 14.0
 * design adds it, and adding a field is a schema change this phase must not
 * make. So the column shows who the enquiry belongs to, which is the truthful
 * answer to "whose is this" under the current model. When `assignedTo` exists
 * the column reads it and nothing else here changes.
 *
 * ## Staleness is measured from `updatedAt`
 *
 * `Lead` records no last-activity timestamp of its own. `updatedAt` moves on
 * every stage change, edit and auto-mail attempt, which is close enough to
 * "somebody has touched this" to be useful, and it is stated in the response so
 * nobody mistakes it for a conversation timestamp.
 */
/**
 * The orders `listAdminLeads` will sort by, by name.
 *
 * `recent` is left exactly as it was written — no `_id` tiebreak added, even
 * though one would make its paging more deterministic. That is a real
 * improvement and a real change, and this task is not the place to slip it into
 * the order every existing caller already reads.
 *
 * `travel` has the tiebreak from the start: without it two enquiries sharing a
 * travel date can come back in either order on either request, which lets a
 * paged list show one twice and skip another.
 *
 * Ascending `travelDate` puts nulls first in MongoDB, but a caller asking for
 * this order is asking about a window and sends `from`, and a `$gte: <Date>`
 * bound never matches a null — so an enquiry with no travel date is already
 * excluded before the sort sees it.
 */
const LEAD_ORDER = Object.freeze({
  recent: { createdAt: -1 },
  travel: { travelDate: 1, _id: 1 },
})

export async function listAdminLeads(query = {}) {
  const {
    stage,
    market,
    introduction,
    activity,
    search,
    attention,
    owner,
    company,
    dateField = 'travelDate',
    preset,
    from,
    to,
    sort = 'recent',
    page = 1,
    limit = 50,
  } = query

  const staleCutoffDate = new Date(Date.now() - STALE_LEAD_DAYS * 86_400_000)
  const activeCutoffDate = new Date(Date.now() - ACTIVE_LEAD_DAYS * 86_400_000)

  const filter = { isDeleted: false }

  /*
   * Every enum filter arrives as an array and becomes `$in`, including the
   * one-element case. A single value would read marginally better in a log, but
   * two code paths for one question is how the single and multiple cases drift
   * apart.
   */
  if (stage?.length) filter.stage = { $in: stage }
  if (market?.length) filter.market = { $in: market }
  if (introduction?.length) filter['autoMail.status'] = { $in: introduction }

  // Scopes the global monitor to one person, for the admin user profile. Absent
  // means every owner, which is what the monitor page itself asks for.
  if (owner) filter.owner = owner

  if (attention === 'unassigned') filter.owner = null
  if (attention === 'stale') filter.updatedAt = { $lt: staleCutoffDate }

  /*
   * One company's enquiries, anchored.
   *
   * `^…$` rather than a contains match: "ABC Travels" must not also return
   * "ABC Travels International", or the count on the companies page would
   * disagree with the rows this returns. Case-insensitive because the workbook
   * is typed by hand, which is the same reason the companies aggregation groups
   * case-insensitively.
   */
  if (company) filter.companyName = new RegExp(`^${escapeRegex(company)}$`, 'i')

  /*
   * The date window, on whichever field the caller named.
   *
   * Merged into any operator already on that field rather than assigned over
   * it. `attention=stale` writes `updatedAt.$lt`, so a range on `updatedAt`
   * would otherwise erase it and quietly return rows the reader had filtered
   * out — the bounds use different operator keys, so both survive and intersect.
   */
  /*
   * The range is opt-in, which `resolveRange` on its own is not.
   *
   * Its `default:` case is `last30`, because every analytics screen wants a
   * period even when nobody picked one. A register is the opposite: asking for
   * "the enquiries" and being shown the last thirty days of them, with a total
   * that agrees, is a silent lie about how many exist. So an absent preset means
   * no date clause at all — exactly what this endpoint did before the filter
   * existed, which is what keeps the unfiltered monitor unchanged.
   */
  const hasDateFilter = Boolean(preset || from || to)
  const {
    from: rangeFrom,
    to: rangeTo,
    preset: resolvedPreset,
  } = hasDateFilter ? resolveRange({ preset, from, to }) : { from: null, to: null, preset: 'all' }
  if (rangeFrom || rangeTo) {
    filter[dateField] = {
      ...(filter[dateField] ?? {}),
      ...(rangeFrom ? { $gte: rangeFrom } : {}),
      ...(rangeTo ? { $lte: rangeTo } : {}),
    }
  }

  /*
   * Activity, in an `$and` rather than merged onto the filter.
   *
   * `awaiting` constrains `autoMail.status`, which the introduction filter may
   * already constrain, and `recent`/`quiet` constrain `updatedAt`, which the
   * stale filter and the range may already constrain. An `$and` lets both
   * conditions stand and intersect; assignment would let whichever ran last win.
   */
  const and = []
  if (activity === 'recent') and.push({ updatedAt: { $gte: activeCutoffDate } })
  if (activity === 'quiet') and.push({ updatedAt: { $lt: activeCutoffDate } })
  if (activity === 'replied') and.push({ replyReceived: true })
  // "We wrote, they have not answered" — which is only meaningful once the
  // introduction actually went out. Never replied *and* never contacted is not
  // awaiting anything.
  if (activity === 'awaiting') {
    and.push({ replyReceived: false }, { 'autoMail.status': AUTO_MAIL_STATUS.SENT })
  }
  if (and.length) filter.$and = and

  if (search) {
    const pattern = safePattern(search)
    filter.$or = [
      { reference: pattern },
      { contactPerson: pattern },
      { companyName: pattern },
      { email: pattern },
      // The workbook carries numbers the reference does not, and a phone number
      // is often the only thing a caller can quote.
      { phones: pattern },
    ]
  }

  /*
   * Stale, within whatever the filter already selects.
   *
   * Built by `$and` for the same reason as above: spreading `updatedAt` over the
   * filter would drop a range the caller set on that field, and this count sits
   * beside the others in one summary — a tile computed against a different
   * window than the table below it is worse than no tile.
   */
  const staleFilter = { ...filter, $and: [...and, { updatedAt: { $lt: staleCutoffDate } }] }

  /**
   * One page, plus counts taken across the whole filtered set.
   *
   * The summary is deliberately **not** derived from `leads` any more. It used
   * to be, and with a fixed 200-row ceiling that made "total" mean "how many
   * came back", which is not a number anybody wants: an admin looking at a
   * register of 1,671 was told it held 200. The counts now describe everything
   * the filter matches, and the rows are just the page being read.
   */
  const [leads, total, unassigned, stale, won] = await Promise.all([
    Lead.find(filter)
      .select(
        'reference contactPerson companyName email stage market owner quoteDate travelDate travelDateText internalNotes createdAt updatedAt autoMail.status',
      )
      .sort(LEAD_ORDER[sort] ?? LEAD_ORDER.recent)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Lead.countDocuments(filter),
    Lead.countDocuments({ ...filter, owner: null }),
    Lead.countDocuments(staleFilter),
    Lead.countDocuments({ ...filter, stage: { $in: WON_STAGES } }),
  ])

  /*
   * The owner facet, over the whole register rather than the current filter.
   *
   * One `distinct` on an indexed field, resolved through the same `nameMap` the
   * rows use — so the dropdown and the Owner column can never disagree about
   * what somebody is called.
   */
  const [owners, facetOwnerIds] = await Promise.all([
    nameMap(leads.map((lead) => lead.owner)),
    Lead.distinct('owner', { isDeleted: false }),
  ])

  const facetOwnerNames = await nameMap(facetOwnerIds)
  const ownerOptions = [...facetOwnerNames.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))

  const staleCutoff = Date.now() - STALE_LEAD_DAYS * 86_400_000

  const items = leads.map((lead) => {
    const lastActivityAt = lead.updatedAt ?? lead.createdAt

    return {
      id: String(lead._id),
      reference: lead.reference,
      customer: lead.contactPerson,
      company: lead.companyName ?? null,
      email: lead.email ?? null,
      stage: lead.stage,
      stageLabel: LEAD_STAGE_LABELS[lead.stage] ?? lead.stage,
      market: lead.market ?? null,
      /*
       * The enquiry's operative date, and what the console's lead tables lead
       * with. `travelDateText` carries the prose the workbook sometimes holds
       * instead ("August"); the row sends both so the client can show what the
       * sheet actually said rather than inventing a date for it.
       */
      /** The enquiry's own date — the workbook's `Q Date` column. */
      quoteDate: lead.quoteDate ?? null,
      travelDate: lead.travelDate ?? null,
      travelDateText: lead.travelDateText ?? null,
      /** The workbook's `Remark` column. Truncated by the tables that show it. */
      remarks: lead.internalNotes ?? null,
      assignedTo: owners.get(String(lead.owner)) ?? null,
      /** The owner's id. Same reasoning as `ownerId` on the campaign row above. */
      assignedToId: lead.owner ? String(lead.owner) : null,
      autoMailStatus: lead.autoMail?.status ?? null,
      lastActivityAt,
      lastActivityDays: Math.floor((Date.now() - new Date(lastActivityAt).getTime()) / 86_400_000),
      isStale: new Date(lastActivityAt).getTime() < staleCutoff,
      createdAt: lead.createdAt,
    }
  })

  return {
    items,
    // Across everything the filter matches, not just this page.
    summary: { total, unassigned, stale, won },
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: page * limit < total,
      hasPrevious: page > 1,
    },
    meta: {
      staleAfterDays: STALE_LEAD_DAYS,
      activeWithinDays: ACTIVE_LEAD_DAYS,
      activitySource: 'updatedAt',
      note: 'Last activity is the record\'s last modification, not a conversation timestamp.',

      /**
       * The vocabularies the filter row offers, served rather than mirrored.
       *
       * The console could hold its own copy of each list, and for stages it
       * already does. But `owners` cannot be a constant — it is whoever holds an
       * enquiry today — and once one facet has to come from the server, sending
       * the rest with it costs nothing and removes the way a client-side copy
       * goes stale: an option that no longer exists still being offered, which
       * looks like a filter that returns nothing rather than a filter that is
       * wrong.
       *
       * `owners` is deliberately computed over the whole register, not the
       * current filter. A dropdown whose options disappear as you use it cannot
       * be used to change your mind.
       */
      owners: ownerOptions,
      markets: MARKET_VALUES.map((value) => ({ value, label: MARKET_LABELS[value] ?? value })),
      introductionStatuses: AUTO_MAIL_STATUS_VALUES.map((value) => ({ value, label: value })),

      /** What the range actually applied to, echoed so the page can say so. */
      dateField,
      range: {
        preset: resolvedPreset,
        from: rangeFrom ? rangeFrom.toISOString() : null,
        to: rangeTo ? rangeTo.toISOString() : null,
      },
    },
  }
}

export default { listAdminCampaigns, listAdminLeads }

/**
 * One enquiry in full, for an administrator, whoever owns it.
 *
 * The CRM's own `GET /v1/leads/:id` loads through `ownerOf(req)` and is
 * unchanged — a salesperson still cannot open somebody else's enquiry. This is
 * the administrator's path to the same document, and the difference is the
 * whole point: the console exists to look across users.
 *
 * The serialization is not reimplemented. `toPublicJSON()` is the same method
 * the CRM detail page renders from, so the two screens cannot disagree about a
 * stage, a Query Date or a remark, and the owner is resolved to a name through
 * the same helper the list uses.
 *
 * @param {string} leadId
 * @returns {Promise<object>}
 */
/**
 * The company-wise enquiry overview.
 *
 * Answers "which companies send us work, and how much" across the whole
 * deployment — one row per company, not per company *record*.
 *
 * ## Why it groups by name and not by `Company`
 *
 * `Company` is owner-scoped: `owner` is required on the model, so every
 * consultant holds their own document for the same agency. Grouping by `_id`
 * would therefore show "ABC Travels" once per consultant, each with a slice of
 * the total, which is precisely the question this page exists to answer in one
 * row. The name on the lead is the only field that identifies the company the
 * same way across owners.
 *
 * Grouped case-insensitively (`toLower` on a trimmed name) because the register
 * is typed by hand and "ABC Travels" and "ABC travels" are one agency. The
 * label shown is the first spelling encountered, not the lowered key.
 *
 * ## Why an aggregation rather than the existing counts
 *
 * `Company.leadCount` exists but counts one owner's leads and knows nothing
 * about stage, so it can answer neither "total across the business" nor the
 * active/closed split. Nothing else in the codebase aggregates leads by
 * company. This is the smallest read-only addition that answers the page's
 * seven columns in one round trip.
 *
 * Read-only: no collection is written, and no existing query is changed.
 *
 * @param {object} query Parsed by `adminCompanyQuerySchema`.
 */
export async function listAdminCompanies(query = {}) {
  const {
    search,
    owner,
    city,
    market,
    stage,
    dateField = 'quoteDate',
    preset,
    from,
    to,
    sort = 'queries',
    page = 1,
    limit = 25,
  } = query

  /*
   * The filter runs over *leads*, before grouping.
   *
   * So a stage or a date range narrows what is counted rather than which
   * companies appear, and the totals on screen are always the totals of what
   * the filter describes. The same shape as the lead monitor's filter, minus
   * the options that only make sense for a register of individual enquiries.
   */
  const filter = { isDeleted: false, companyName: { $nin: [null, ''] } }

  if (owner) filter.owner = owner
  if (city) filter.city = safePattern(city)
  if (market?.length) filter.market = { $in: market }
  if (stage?.length) filter.stage = { $in: stage }
  if (search) filter.companyName = { $nin: [null, ''], $regex: safePattern(search) }

  const hasDateFilter = Boolean(preset || from || to)
  const { from: rangeFrom, to: rangeTo } = hasDateFilter
    ? resolveRange({ preset, from, to })
    : { from: null, to: null }

  if (rangeFrom || rangeTo) {
    filter[dateField] = {
      ...(rangeFrom ? { $gte: rangeFrom } : {}),
      ...(rangeTo ? { $lte: rangeTo } : {}),
    }
  }

  const ORDER = {
    queries: { total: -1, latestQueryAt: -1 },
    latest: { latestQueryAt: -1, total: -1 },
    name: { name: 1 },
  }

  /*
   * One round trip: the page and the total count of groups.
   *
   * `$facet` because the number of *companies* cannot be derived from a page of
   * them, and running the same grouping twice to learn it would double the work
   * on the largest collection in the deployment.
   */
  const [result] = await Lead.aggregate([
    { $match: filter },
    {
      $group: {
        _id: { $toLower: { $trim: { input: '$companyName' } } },
        name: { $first: '$companyName' },
        total: { $sum: 1 },
        active: { $sum: { $cond: [{ $eq: ['$stage', LEAD_STAGE.ACTIVE] }, 1, 0] } },
        closed: { $sum: { $cond: [{ $eq: ['$stage', LEAD_STAGE.CLOSED] }, 1, 0] } },
        confirmed: { $sum: { $cond: [{ $in: ['$stage', WON_STAGES] }, 1, 0] } },
        // The latest enquiry, by the date the office actually quoted on, with
        // the created date standing in for the rows that never carried one.
        latestQueryAt: { $max: { $ifNull: ['$quoteDate', '$createdAt'] } },
        owners: { $addToSet: '$owner' },
      },
    },
    {
      $facet: {
        rows: [{ $sort: ORDER[sort] ?? ORDER.queries }, { $skip: (page - 1) * limit }, { $limit: limit }],
        counted: [{ $count: 'companies' }],
      },
    },
  ])

  const rows = result?.rows ?? []
  const totalCompanies = result?.counted?.[0]?.companies ?? 0

  // One lookup for the page's owners, not one per row.
  const names = await nameMap(rows.flatMap((row) => row.owners ?? []))

  return {
    items: rows.map((row) => ({
      id: row._id,
      name: row.name ?? '—',
      total: row.total,
      active: row.active,
      closed: row.closed,
      confirmed: row.confirmed,
      latestQueryAt: row.latestQueryAt ?? null,
      owners: (row.owners ?? [])
        .filter(Boolean)
        .map((id) => ({ id: String(id), name: names.get(String(id)) ?? 'Unknown user' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })),
    pagination: {
      page,
      limit,
      total: totalCompanies,
      totalPages: Math.max(1, Math.ceil(totalCompanies / limit)),
      hasNext: page * limit < totalCompanies,
      hasPrevious: page > 1,
    },
    meta: {
      /** The same facet the lead monitor offers, over the whole register. */
      markets: MARKET_VALUES.map((value) => ({ value, label: MARKET_LABELS[value] ?? value })),
      dateField,
    },
  }
}

export async function getAdminLeadDetail(leadId) {
  const lead = await Lead.findOne({ _id: leadId, isDeleted: false })

  // 404 rather than an empty page: a deleted or unknown id is a missing
  // resource, and the caller's permission was never in doubt.
  if (!lead) {
    throw ApiError.notFound('That enquiry does not exist.', { code: 'LEAD_NOT_FOUND' })
  }

  const [company, contact, owners] = await Promise.all([
    lead.company ? Company.findById(lead.company) : null,
    lead.contact ? Contact.findById(lead.contact) : null,
    nameMap([lead.owner]),
  ])

  return {
    lead: lead.toPublicJSON(),
    company: company?.toPublicJSON() ?? null,
    contact: contact?.toPublicJSON() ?? null,
    owner: {
      id: lead.owner ? String(lead.owner) : null,
      name: owners.get(String(lead.owner)) ?? null,
    },
  }
}
