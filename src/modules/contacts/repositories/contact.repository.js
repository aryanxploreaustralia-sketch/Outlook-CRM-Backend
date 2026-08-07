/**
 * Contact persistence: querying, filtering, search and pagination.
 *
 * Every function takes an `owner` and applies it to the filter, which is what
 * makes cross-user access impossible by construction rather than by remembering
 * to check.
 */

import { Contact } from '../../../models/contact.model.js'
import { ContactGroup } from '../../../models/contactGroup.model.js'
import {
  CONTACT_FILTER,
  CONTACT_SOURCE,
  CONTACT_SYNC_STATUS,
  RECENT_WINDOW_DAYS,
} from '../constants/contactConstants.js'

/** Escapes a user string so it cannot alter regex meaning or cause backtracking. */
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000)

/**
 * Translates query parameters into a Mongo filter.
 *
 * Kept separate from the query itself so counting and listing provably share one
 * filter — a divergence there produces pagination totals that disagree with the
 * rows, which is confusing and hard to spot.
 *
 * @param {object} params
 * @returns {object}
 */
export function buildFilter({
  owner,
  search,
  filter,
  company,
  country,
  tags,
  category,
  source,
  groupMembers = null,
  includeDeleted = false,
}) {
  const query = { owner }

  if (!includeDeleted) query.isDeleted = false

  if (company) query.company = new RegExp(`^${escapeRegex(company)}$`, 'i')
  if (country) query.country = new RegExp(`^${escapeRegex(country)}$`, 'i')
  if (category) query.category = category
  if (source) query.source = source

  if (tags?.length > 0) query.tags = { $all: tags }

  // Restricting to a group's membership, when one was requested.
  if (groupMembers) query._id = { $in: groupMembers }

  switch (filter) {
    case CONTACT_FILTER.FAVORITES:
      query.favorite = true
      break

    case CONTACT_FILTER.RECENTLY_ADDED:
      query.createdAt = { $gte: daysAgo(RECENT_WINDOW_DAYS) }
      break

    case CONTACT_FILTER.RECENTLY_CONTACTED:
      query.lastInteraction = { $gte: daysAgo(RECENT_WINDOW_DAYS) }
      break

    case CONTACT_FILTER.CRM_ONLY:
      // Anything not synchronised from a provider — created here or imported.
      query.source = { $in: [CONTACT_SOURCE.CRM, CONTACT_SOURCE.IMPORT, CONTACT_SOURCE.API] }
      break

    case CONTACT_FILTER.OUTLOOK_ONLY:
      query.source = CONTACT_SOURCE.OUTLOOK
      break

    case CONTACT_FILTER.HAS_CONFLICT:
      query.syncStatus = CONTACT_SYNC_STATUS.CONFLICT
      break

    default:
      break
  }

  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i')

    /**
     * Regex rather than the text index.
     *
     * The text index is present and used for ranked full-text search, but it
     * cannot match partial words — searching "prah" would not find "Prahlad".
     * A contacts search box is used as a type-ahead, so substring matching is
     * what users actually expect.
     */
    query.$or = [
      { displayName: pattern },
      { firstName: pattern },
      { lastName: pattern },
      { company: pattern },
      { primaryEmail: pattern },
      { secondaryEmail: pattern },
      { matchPhones: pattern },
      { tags: pattern },
      { notes: pattern },
    ]
  }

  return query
}

/** Sort specifications the API exposes. */
export const SORT_OPTIONS = Object.freeze({
  name: { displayName: 1 },
  '-name': { displayName: -1 },
  created: { createdAt: 1 },
  '-created': { createdAt: -1 },
  updated: { updatedAt: 1 },
  '-updated': { updatedAt: -1 },
  company: { company: 1, displayName: 1 },
  interaction: { lastInteraction: -1 },
})

/**
 * One page of contacts.
 *
 * @returns {Promise<{ items: object[], total: number }>}
 */
export async function list({ owner, page = 1, limit = 50, sort = '-created', ...filters }) {
  let groupMembers = null

  // A group filter resolves to an id list first; membership lives on the group.
  if (filters.group) {
    const group = await ContactGroup.findOne({ _id: filters.group, owner, isDeleted: false })
    groupMembers = group?.members ?? []
  }

  const query = buildFilter({ owner, groupMembers, ...filters })
  const skip = (page - 1) * limit

  // Run together: the count does not depend on the page, and serialising them
  // would double the latency of every list request.
  const [documents, total] = await Promise.all([
    Contact.find(query)
      .sort(SORT_OPTIONS[sort] ?? SORT_OPTIONS['-created'])
      .skip(skip)
      .limit(limit)
      .lean({ virtuals: false }),
    Contact.countDocuments(query),
  ])

  // `.lean()` returns plain objects, so the schema methods are not available.
  // Hydrating just for serialisation would defeat the point of lean; the
  // summary is projected directly instead.
  const items = documents.map((doc) => ({
    id: doc._id.toString(),
    firstName: doc.firstName,
    lastName: doc.lastName,
    displayName: doc.displayName,
    company: doc.company,
    jobTitle: doc.jobTitle,
    primaryEmail: doc.primaryEmail,
    mobile: doc.mobile,
    businessPhone: doc.businessPhone,
    city: doc.city,
    country: doc.country,
    tags: doc.tags ?? [],
    category: doc.category,
    favorite: doc.favorite,
    source: doc.source,
    syncStatus: doc.syncStatus,
    hasPhoto: Boolean(doc.photo?.contentType),
    lastInteraction: doc.lastInteraction,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }))

  return { items, total }
}

/** @returns {Promise<?object>} */
export async function findById({ owner, id, withPhoto = false }) {
  const query = Contact.findOne({ _id: id, owner })
  if (withPhoto) query.select('+photo.contentBytes')
  return query
}

/** @returns {Promise<object>} */
export async function create({ owner, data, createdBy = null }) {
  return Contact.create({ ...data, owner, createdBy, updatedBy: createdBy })
}

/**
 * Applies an update.
 *
 * A contact synchronised from a provider is marked `pending` after a local edit,
 * so the next sync knows it owes an upstream write. Without this the CRM would
 * quietly diverge from Outlook.
 *
 * @returns {Promise<?object>}
 */
export async function update({ owner, id, data, updatedBy = null }) {
  const contact = await Contact.findOne({ _id: id, owner, isDeleted: false })
  if (!contact) return null

  Object.assign(contact, data)
  contact.updatedBy = updatedBy

  if (contact.source === CONTACT_SOURCE.OUTLOOK && contact.syncStatus === CONTACT_SYNC_STATUS.SYNCED) {
    contact.syncStatus = CONTACT_SYNC_STATUS.PENDING
  }

  await contact.save()
  return contact
}

/**
 * Soft-deletes a contact.
 *
 * Never a hard delete: a contact carries CRM annotations — tags, notes,
 * category, group membership — that exist nowhere else, and an accidental
 * deletion must be recoverable.
 *
 * @returns {Promise<?object>}
 */
export async function softDelete({ owner, id, updatedBy = null }) {
  const contact = await Contact.findOne({ _id: id, owner, isDeleted: false })
  if (!contact) return null

  contact.isDeleted = true
  contact.deletedAt = new Date()
  contact.updatedBy = updatedBy
  await contact.save()

  // Membership is removed so groups do not report deleted people in their count.
  await ContactGroup.updateMany(
    { owner, members: contact._id },
    { $pull: { members: contact._id }, $inc: { memberCount: -1 } },
  )

  return contact
}

/** @returns {Promise<?object>} */
export async function restore({ owner, id, updatedBy = null }) {
  const contact = await Contact.findOne({ _id: id, owner, isDeleted: true })
  if (!contact) return null

  contact.isDeleted = false
  contact.deletedAt = null
  contact.updatedBy = updatedBy
  await contact.save()

  return contact
}

/**
 * Applies one operation to many contacts.
 *
 * @param {object} params
 * @param {string} params.action `delete` · `favorite` · `unfavorite` · `tag` · `untag` · `category`
 * @returns {Promise<{ matched: number, modified: number }>}
 */
export async function bulk({ owner, ids, action, value = null, updatedBy = null }) {
  const filter = { owner, _id: { $in: ids }, isDeleted: false }

  const update = {
    delete: { $set: { isDeleted: true, deletedAt: new Date(), updatedBy } },
    favorite: { $set: { favorite: true, updatedBy } },
    unfavorite: { $set: { favorite: false, updatedBy } },
    // `$addToSet` rather than `$push`, so tagging twice does not duplicate.
    tag: { $addToSet: { tags: value }, $set: { updatedBy } },
    untag: { $pull: { tags: value }, $set: { updatedBy } },
    category: { $set: { category: value, updatedBy } },
  }[action]

  if (!update) throw new Error(`Unknown bulk action "${action}".`)

  const result = await Contact.updateMany(filter, update)

  if (action === 'delete') {
    await ContactGroup.updateMany({ owner, members: { $in: ids } }, { $pull: { members: { $in: ids } } })
    // Counts are recomputed rather than decremented, because a single group may
    // have lost several members and $inc cannot express "minus however many".
    await recomputeGroupCounts({ owner })
  }

  return { matched: result.matchedCount ?? 0, modified: result.modifiedCount ?? 0 }
}

/** Recomputes every group's denormalised member count. */
export async function recomputeGroupCounts({ owner }) {
  const groups = await ContactGroup.find({ owner, isDeleted: false })

  for (const group of groups) {
    if (group.memberCount !== group.members.length) {
      group.memberCount = group.members.length
      await group.save()
    }
  }
}

/**
 * Aggregate counters for the dashboard widgets.
 *
 * One `$facet` rather than six queries: a single round trip, and every counter
 * necessarily describes the same instant.
 *
 * @returns {Promise<object>}
 */
export async function statistics({ owner }) {
  const recentCutoff = daysAgo(RECENT_WINDOW_DAYS)

  const [facets] = await Contact.aggregate([
    { $match: { owner, isDeleted: false } },
    {
      $facet: {
        total: [{ $count: 'value' }],
        favorites: [{ $match: { favorite: true } }, { $count: 'value' }],
        recentlyAdded: [{ $match: { createdAt: { $gte: recentCutoff } } }, { $count: 'value' }],
        recentlyContacted: [
          { $match: { lastInteraction: { $gte: recentCutoff } } },
          { $count: 'value' },
        ],
        withConflicts: [
          { $match: { syncStatus: CONTACT_SYNC_STATUS.CONFLICT } },
          { $count: 'value' },
        ],
        bySource: [{ $group: { _id: '$source', count: { $sum: 1 } } }],
        byCategory: [{ $group: { _id: '$category', count: { $sum: 1 } } }],
        companies: [
          { $match: { company: { $nin: [null, ''] } } },
          { $group: { _id: '$company', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ],
        distinctCompanies: [
          { $match: { company: { $nin: [null, ''] } } },
          { $group: { _id: '$company' } },
          { $count: 'value' },
        ],
        countries: [
          { $match: { country: { $nin: [null, ''] } } },
          { $group: { _id: '$country', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ],
      },
    },
  ])

  const scalar = (key) => facets?.[key]?.[0]?.value ?? 0
  const pairs = (key) =>
    Object.fromEntries((facets?.[key] ?? []).map((entry) => [entry._id, entry.count]))

  return {
    total: scalar('total'),
    favorites: scalar('favorites'),
    recentlyAdded: scalar('recentlyAdded'),
    recentlyContacted: scalar('recentlyContacted'),
    withConflicts: scalar('withConflicts'),
    companies: scalar('distinctCompanies'),
    bySource: pairs('bySource'),
    byCategory: pairs('byCategory'),
    topCompanies: (facets?.companies ?? []).map((entry) => ({
      company: entry._id,
      count: entry.count,
    })),
    topCountries: (facets?.countries ?? []).map((entry) => ({
      country: entry._id,
      count: entry.count,
    })),
  }
}

/** Distinct values for the filter dropdowns. */
export async function facets({ owner }) {
  const [companies, countries, tags] = await Promise.all([
    Contact.distinct('company', { owner, isDeleted: false, company: { $nin: [null, ''] } }),
    Contact.distinct('country', { owner, isDeleted: false, country: { $nin: [null, ''] } }),
    Contact.distinct('tags', { owner, isDeleted: false }),
  ])

  const sorted = (values) => values.filter(Boolean).sort((a, b) => a.localeCompare(b))

  return { companies: sorted(companies), countries: sorted(countries), tags: sorted(tags) }
}

export default {
  buildFilter,
  list,
  findById,
  create,
  update,
  softDelete,
  restore,
  bulk,
  statistics,
  facets,
  recomputeGroupCounts,
  SORT_OPTIONS,
}
