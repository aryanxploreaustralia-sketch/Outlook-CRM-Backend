/**
 * Querying the lead register.
 *
 * Filters, search, the pipeline board, analytics and the campaign audience.
 * Everything here is scoped by `owner`; nothing accepts a raw Mongo filter from
 * a caller, because that is how a filter parameter becomes a data leak.
 */

import mongoose from 'mongoose'

import { Company } from '../../../models/company.model.js'
import { Contact } from '../../../models/contact.model.js'
import { Lead } from '../../../models/lead.model.js'
import {
  CAMPAIGN_ELIGIBLE_STAGES,
  LEAD_STAGE_LABELS,
  LEAD_STAGE_ORDER,
  LEAD_STAGE_VALUES,
  WON_STAGES,
} from '../constants/leadConstants.js'

/** Sort keys the API exposes, mapped to index-friendly sorts. */
const SORT_OPTIONS = {
  '-created': { createdAt: -1 },
  created: { createdAt: 1 },
  '-quote': { quoteDate: -1 },
  quote: { quoteDate: 1 },
  '-travel': { travelDate: -1 },
  travel: { travelDate: 1 },
  reference: { reference: 1 },
  '-reference': { reference: -1 },
  person: { contactPerson: 1 },
  company: { companyName: 1 },
}

/**
 * Builds a Mongo filter from vetted query parameters.
 *
 * Every branch is an explicit field. A caller cannot introduce an operator.
 */
export function buildLeadFilter({
  owner,
  stage = null,
  stages = null,
  city = null,
  country = null,
  state = null,
  company = null,
  contact = null,
  handledBy = null,
  market = null,
  travelMonth = null,
  importJob = null,
  campaignEligible = null,
  doNotContact = null,
  quoteFrom = null,
  quoteTo = null,
  search = null,
  includeDeleted = false,
} = {}) {
  const filter = { owner }
  if (!includeDeleted) filter.isDeleted = false

  if (stage) filter.stage = stage
  if (Array.isArray(stages) && stages.length > 0) {
    filter.stage = { $in: stages.filter((value) => LEAD_STAGE_VALUES.includes(value)) }
  }

  if (city) filter.city = new RegExp(`^${escapeRegex(city)}$`, 'i')
  if (market) filter.market = market
  if (handledBy) filter.handledBy = new RegExp(`^${escapeRegex(handledBy)}$`, 'i')
  if (company) filter.company = toObjectId(company)
  if (contact) filter.contact = toObjectId(contact)
  if (importJob) filter.importJob = toObjectId(importJob)
  if (doNotContact !== null) filter.doNotContact = Boolean(doNotContact)

  // Country and state live on the company, so they are resolved by the caller
  // into a company id list; see `resolveCompanyScope`.
  if (country || state) filter._companyScope = { country, state }

  if (quoteFrom || quoteTo) {
    filter.quoteDate = {}
    if (quoteFrom) filter.quoteDate.$gte = new Date(quoteFrom)
    if (quoteTo) filter.quoteDate.$lte = new Date(quoteTo)
  }

  /**
   * Travel month, as `YYYY-MM`.
   *
   * A range rather than `$expr` with `$month`, so the `(owner, travelDate)`
   * index is usable. `$expr` would force a collection scan on every lookup.
   */
  if (travelMonth && /^\d{4}-\d{2}$/.test(travelMonth)) {
    const [year, month] = travelMonth.split('-').map(Number)
    filter.travelDate = {
      $gte: new Date(Date.UTC(year, month - 1, 1)),
      $lt: new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1)),
    }
  }

  if (campaignEligible === true) {
    /**
     * Eligibility **intersects** the requested stages; it does not replace them.
     *
     * Overwriting was a real bug: asking for a `booked` audience returned every
     * eligible lead instead of none, because the eligible set was assigned over
     * the requested stage. Someone targeting won deals would have emailed the
     * entire open pipeline.
     *
     * An empty intersection is expressed as `$in: []`, which matches nothing —
     * the honest answer when every requested stage is ineligible.
     */
    const requested = filter.stage
      ? (typeof filter.stage === 'string' ? [filter.stage] : (filter.stage.$in ?? []))
      : null

    filter.stage = {
      $in: requested
        ? requested.filter((value) => CAMPAIGN_ELIGIBLE_STAGES.includes(value))
        : [...CAMPAIGN_ELIGIBLE_STAGES],
    }

    filter.doNotContact = false
    filter.email = { $nin: [null, ''] }
  }

  /**
   * Free-text search across the five fields the search box advertises.
   *
   * ## Why this is a regex and not `$text`
   *
   * It used to be `filter.$text = { $search: search }`. A MongoDB text index
   * tokenises its input and matches **whole tokens only** — it has no concept
   * of a partial or prefix match. `XAMP1687` is indexed as the single token
   * `xamp1687`, so:
   *
   *   - `XAMP1687` matched (whole token)          ✓
   *   - `xamp1687` matched ($text is case-insensitive) ✓
   *   - `XAMP`     matched nothing                ✗
   *   - `1687`     matched nothing                ✗
   *
   * A reference is an opaque code, not prose. People search it the way they
   * search an order number: they type the fragment they remember — the prefix
   * off a subject line, or just the digits. Both of those returned an empty
   * register, which is the reported bug.
   *
   * The text index's weights were never doing anything either: this query sorts
   * by `SORT_OPTIONS[sort]`, never by `{ $meta: 'textScore' }`, so relevance
   * ranking was computed and discarded.
   *
   * This is the same construction `globalSearch` below has always used over the
   * same fields. The two search paths had silently diverged — one supporting
   * partial matches and one not — and this is what brings them back together.
   *
   * Performance: the clause is a *residual* filter. `owner` and `isDeleted`
   * still select the index, so this scans one workspace's leads rather than the
   * collection. The input is escaped, so a user typing `.*` searches for the
   * literal characters instead of injecting a pattern.
   */
  if (search) {
    const term = new RegExp(escapeRegex(search), 'i')

    filter.$or = [
      { reference: term },
      { contactPerson: term },
      { companyName: term },
      { email: term },
      { city: term },
    ]
  }

  return filter
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(String(value)) : null
}

/** Turns a country/state filter into a company id set. */
async function resolveCompanyScope(owner, scope) {
  const query = { owner, isDeleted: false }
  if (scope.country) query.country = new RegExp(`^${escapeRegex(scope.country)}$`, 'i')
  if (scope.state) query.state = new RegExp(`^${escapeRegex(scope.state)}$`, 'i')

  const companies = await Company.find(query).select('_id').lean()
  return companies.map((company) => company._id)
}

/**
 * The same resolution, exposed for the workbook export.
 *
 * A re-export rather than a copy: the export applies the caller's filters
 * through `buildLeadFilter` and must therefore complete the `_companyScope`
 * placeholder exactly as `listLeads` does, or the country and state filters
 * would widen the exported file relative to the screen. Nothing about the
 * function itself changes.
 */
export { resolveCompanyScope as resolveCompanyScopeForExport }

/**
 * Lists leads.
 *
 * @returns {Promise<{ items, pagination, facets }>}
 */
export async function listLeads({ owner, page = 1, limit = 50, sort = '-quote', ...criteria }) {
  const filter = buildLeadFilter({ owner, ...criteria })

  if (filter._companyScope) {
    const ids = await resolveCompanyScope(owner, filter._companyScope)
    delete filter._companyScope
    filter.company = filter.company ? filter.company : { $in: ids }
  }

  const skip = (page - 1) * limit
  const sortSpec = SORT_OPTIONS[sort] ?? SORT_OPTIONS['-quote']

  const [items, total] = await Promise.all([
    Lead.find(filter).sort(sortSpec).skip(skip).limit(limit),
    Lead.countDocuments(filter),
  ])

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNext: skip + items.length < total,
      hasPrevious: page > 1,
    },
  }
}

/**
 * Distinct values for the filter dropdowns.
 *
 * Computed from the leads that exist rather than a fixed list, so the city
 * filter offers "Hydrabad" if that is genuinely what the sheet says.
 */
export async function leadFacets({ owner }) {
  const [cities, handlers, markets, months, companies] = await Promise.all([
    Lead.distinct('city', { owner, isDeleted: false, city: { $nin: [null, ''] } }),
    Lead.distinct('handledBy', { owner, isDeleted: false, handledBy: { $nin: [null, ''] } }),
    Lead.distinct('market', { owner, isDeleted: false }),
    Lead.aggregate([
      { $match: { owner, isDeleted: false, travelDate: { $ne: null } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$travelDate' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
      { $limit: 60 },
    ]),
    Company.find({ owner, isDeleted: false })
      .select('_id companyName leadCount')
      .sort({ leadCount: -1 })
      .limit(200)
      .lean(),
  ])

  return {
    cities: cities.sort((a, b) => a.localeCompare(b)),
    handledBy: handlers.sort(),
    markets,
    travelMonths: months.map((row) => ({ month: row._id, count: row.count })),
    companies: companies.map((company) => ({
      id: company._id.toString(),
      name: company.companyName,
      leadCount: company.leadCount,
    })),
    stages: LEAD_STAGE_ORDER.map((stage) => ({ value: stage, label: LEAD_STAGE_LABELS[stage] })),
  }
}

/**
 * The pipeline board: leads grouped by stage.
 *
 * Returns counts plus the newest few per stage. The whole register is not
 * returned — a board showing 1,671 cards is unusable and the payload would be
 * megabytes.
 */
export async function pipelineBoard({ owner, perStage = 10 }) {
  const counts = await Lead.aggregate([
    { $match: { owner, isDeleted: false } },
    { $group: { _id: '$stage', count: { $sum: 1 } } },
  ])

  const countByStage = Object.fromEntries(counts.map((row) => [row._id, row.count]))

  const columns = []

  for (const stage of LEAD_STAGE_ORDER) {
    const items = await Lead.find({ owner, isDeleted: false, stage })
      .sort({ quoteDate: -1 })
      .limit(perStage)

    columns.push({
      stage,
      label: LEAD_STAGE_LABELS[stage],
      count: countByStage[stage] ?? 0,
      campaignEligible: CAMPAIGN_ELIGIBLE_STAGES.includes(stage),
      items: items.map((lead) => lead.toSummaryJSON()),
    })
  }

  return { columns, total: Object.values(countByStage).reduce((sum, n) => sum + n, 0) }
}

/**
 * Dashboard widgets.
 *
 * One aggregation per widget rather than one giant pipeline: they are cheap,
 * independently cacheable, and a failure in one does not blank the dashboard.
 */
export async function leadStatistics({ owner }) {
  const startOfToday = new Date()
  startOfToday.setUTCHours(0, 0, 0, 0)

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000)

  const [
    byStage,
    totalLeads,
    companies,
    contacts,
    todaysQuotes,
    recentLeads,
    upcomingTravel,
    campaignReady,
  ] = await Promise.all([
    Lead.aggregate([
      { $match: { owner, isDeleted: false } },
      { $group: { _id: '$stage', count: { $sum: 1 } } },
    ]),
    Lead.countDocuments({ owner, isDeleted: false }),
    Company.countDocuments({ owner, isDeleted: false }),
    Contact.countDocuments({ owner, isDeleted: false }),
    Lead.countDocuments({ owner, isDeleted: false, quoteDate: { $gte: startOfToday } }),
    Lead.countDocuments({ owner, isDeleted: false, createdAt: { $gte: thirtyDaysAgo } }),
    Lead.countDocuments({
      owner,
      isDeleted: false,
      travelDate: { $gte: new Date(), $lte: new Date(Date.now() + 90 * 86_400_000) },
    }),
    Lead.countDocuments({
      owner,
      isDeleted: false,
      doNotContact: false,
      stage: { $in: CAMPAIGN_ELIGIBLE_STAGES },
      email: { $nin: [null, ''] },
    }),
  ])

  const stageCounts = Object.fromEntries(LEAD_STAGE_ORDER.map((stage) => [stage, 0]))
  for (const row of byStage) stageCounts[row._id] = row.count

  const won = WON_STAGES.reduce((sum, stage) => sum + (stageCounts[stage] ?? 0), 0)

  return {
    companies,
    contacts,
    totalLeads,
    newLeads: stageCounts.new,
    todaysQuotes,
    followUps: stageCounts.follow_up,
    negotiation: stageCounts.negotiation,
    visaProcess: stageCounts.visa_process,
    booked: stageCounts.booked,
    completed: stageCounts.completed,
    campaignReady,
    recentLeads,
    upcomingTravel,
    byStage: stageCounts,
    /**
     * Conversion over leads that reached a decision, not over every lead.
     *
     * Counting open enquiries in the denominator would make the rate fall every
     * time a new lead arrived, which reads as the team getting worse at selling.
     */
    conversionRate: (() => {
      const decided = won + (stageCounts.lost ?? 0) + (stageCounts.cancelled ?? 0)
      return decided === 0 ? null : Math.round((won / decided) * 1000) / 10
    })(),
  }
}

/**
 * Cross-entity search.
 *
 * Three text indexes rather than one collection: a salesperson typing "flamingo"
 * may want the company, the person or the enquiry, and guessing which would be
 * wrong two thirds of the time.
 */
export async function globalSearch({ owner, query, limit = 10 }) {
  const text = String(query ?? '').trim()
  if (!text) return { leads: [], companies: [], contacts: [], query: text }

  const escaped = new RegExp(escapeRegex(text), 'i')

  const [leads, companies, contacts] = await Promise.all([
    // A reference is matched exactly first — someone typing "XAMP01" wants that
    // enquiry, not every enquiry mentioning it.
    Lead.find({
      owner,
      isDeleted: false,
      $or: [
        { reference: escaped },
        { contactPerson: escaped },
        { companyName: escaped },
        { email: escaped },
        { city: escaped },
        { phones: escaped },
      ],
    })
      .sort({ quoteDate: -1 })
      .limit(limit),

    Company.find({
      owner,
      isDeleted: false,
      $or: [{ companyName: escaped }, { aliases: escaped }, { emailDomain: escaped }, { city: escaped }],
    })
      .sort({ leadCount: -1 })
      .limit(limit),

    Contact.find({
      owner,
      isDeleted: false,
      $or: [{ displayName: escaped }, { primaryEmail: escaped }, { company: escaped }, { phones: escaped }],
    })
      .sort({ leadCount: -1 })
      .limit(limit),
  ])

  return {
    query: text,
    leads: leads.map((lead) => lead.toSummaryJSON()),
    companies: companies.map((company) => company.toPublicJSON()),
    contacts: contacts.map((contact) => contact.toSummaryJSON?.() ?? contact.toPublicJSON()),
    total: leads.length + companies.length + contacts.length,
  }
}

/**
 * Resolves a campaign audience from lead criteria.
 *
 * The eligibility rule is applied here, not left to the caller: a campaign must
 * never reach a booked, completed, cancelled or lost lead, and enforcing that
 * only in the UI would leave the API able to do it.
 *
 * @returns {{ contactIds, leadIds, excluded, breakdown }}
 */
export async function resolveLeadAudience({ owner, criteria = {} }) {
  const filter = buildLeadFilter({ owner, ...criteria, campaignEligible: true })

  if (filter._companyScope) {
    const ids = await resolveCompanyScope(owner, filter._companyScope)
    delete filter._companyScope
    filter.company = filter.company ?? { $in: ids }
  }

  const leads = await Lead.find(filter).select('_id contact email stage').lean()

  const contactIds = []
  const leadIds = []
  const seenContacts = new Set()
  const excluded = { noContact: 0, duplicateContact: 0 }

  for (const lead of leads) {
    leadIds.push(lead._id)

    if (!lead.contact) {
      excluded.noContact += 1
      continue
    }

    const key = lead.contact.toString()

    /**
     * One message per person, not per enquiry.
     *
     * A contact with 183 open enquiries must receive one email, not 183. The
     * campaign is addressed to a human; the enquiries are the reason for it.
     */
    if (seenContacts.has(key)) {
      excluded.duplicateContact += 1
      continue
    }

    seenContacts.add(key)
    contactIds.push(lead.contact)
  }

  const breakdown = {}
  for (const lead of leads) breakdown[lead.stage] = (breakdown[lead.stage] ?? 0) + 1

  return {
    contactIds,
    leadIds,
    matchedLeads: leads.length,
    recipients: contactIds.length,
    excluded,
    breakdown,
  }
}

export default {
  listLeads,
  leadFacets,
  pipelineBoard,
  leadStatistics,
  globalSearch,
  resolveLeadAudience,
  buildLeadFilter,
}
