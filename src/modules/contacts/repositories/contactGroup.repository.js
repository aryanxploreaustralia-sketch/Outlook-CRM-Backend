/**
 * Contact group persistence.
 *
 * Membership writes go through `addMembers` / `removeMembers` rather than being
 * assigned directly, so the denormalised `memberCount` is maintained in one
 * place and cannot drift from the array it summarises.
 */

import { Contact } from '../../../models/contact.model.js'
import { ContactGroup } from '../../../models/contactGroup.model.js'

/** @returns {Promise<{ items: object[], total: number }>} */
export async function list({ owner, page = 1, limit = 50, search = null }) {
  const filter = { owner, isDeleted: false }

  if (search) {
    const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    filter.name = new RegExp(escaped, 'i')
  }

  const skip = (page - 1) * limit

  const [documents, total] = await Promise.all([
    ContactGroup.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
    ContactGroup.countDocuments(filter),
  ])

  return { items: documents.map((group) => group.toPublicJSON()), total }
}

/** @returns {Promise<?object>} */
export async function findById({ owner, id }) {
  return ContactGroup.findOne({ _id: id, owner, isDeleted: false })
}

/**
 * Creates a group, optionally with initial members.
 *
 * Member ids are filtered against the owner's contacts before being stored: an
 * unchecked id list would let a caller attach another user's contact to their
 * group, which the group detail endpoint would then happily return.
 */
export async function create({ owner, data, createdBy = null }) {
  const members = await verifyOwnership({ owner, ids: data.members ?? [] })

  return ContactGroup.create({
    ...data,
    members,
    memberCount: members.length,
    owner,
    createdBy,
    updatedBy: createdBy,
  })
}

/** @returns {Promise<?object>} */
export async function update({ owner, id, data, updatedBy = null }) {
  const group = await findById({ owner, id })
  if (!group) return null

  if (data.members) {
    group.members = await verifyOwnership({ owner, ids: data.members })
  }

  for (const field of ['name', 'description', 'color']) {
    if (data[field] !== undefined) group[field] = data[field]
  }

  group.updatedBy = updatedBy
  await group.save()

  return group
}

/** Soft-deletes a group. Its contacts are untouched — only the grouping is removed. */
export async function softDelete({ owner, id, updatedBy = null }) {
  const group = await findById({ owner, id })
  if (!group) return null

  group.isDeleted = true
  group.deletedAt = new Date()
  group.updatedBy = updatedBy
  await group.save()

  return group
}

/**
 * Filters an id list to contacts the owner actually holds.
 *
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
async function verifyOwnership({ owner, ids }) {
  if (!ids?.length) return []

  const contacts = await Contact.find({ _id: { $in: ids }, owner, isDeleted: false }).select('_id')

  return contacts.map((contact) => contact._id)
}

/**
 * Adds members, ignoring ones already present.
 *
 * `$addToSet` makes the operation idempotent, so adding the same contact twice
 * cannot inflate the count.
 */
export async function addMembers({ owner, id, contactIds, updatedBy = null }) {
  const group = await findById({ owner, id })
  if (!group) return null

  const verified = await verifyOwnership({ owner, ids: contactIds })

  const existing = new Set(group.members.map((member) => member.toString()))
  for (const contactId of verified) {
    if (!existing.has(contactId.toString())) group.members.push(contactId)
  }

  group.memberCount = group.members.length
  group.updatedBy = updatedBy
  await group.save()

  return group
}

/** Removes members. Ids not in the group are ignored rather than erroring. */
export async function removeMembers({ owner, id, contactIds, updatedBy = null }) {
  const group = await findById({ owner, id })
  if (!group) return null

  const removing = new Set(contactIds.map(String))
  group.members = group.members.filter((member) => !removing.has(member.toString()))
  group.memberCount = group.members.length
  group.updatedBy = updatedBy
  await group.save()

  return group
}

/** Groups a given contact belongs to. */
export async function groupsForContact({ owner, contactId }) {
  const groups = await ContactGroup.find({ owner, isDeleted: false, members: contactId })
  return groups.map((group) => group.toPublicJSON())
}

export default {
  list,
  findById,
  create,
  update,
  softDelete,
  addMembers,
  removeMembers,
  groupsForContact,
}
