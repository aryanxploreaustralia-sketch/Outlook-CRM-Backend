/**
 * Contact groups controller.
 */

import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import * as groups from '../repositories/contactGroup.repository.js'
import * as contacts from '../repositories/contact.repository.js'
import {
  contactIdSchema,
  createGroupSchema,
  groupMembersSchema,
  updateGroupSchema,
} from '../validators/contact.validator.js'

const ownerOf = (req) => req.auth.user._id

/** GET /api/v1/contact-groups */
export const list = asyncHandler(async (req, res) => {
  const page = Number(req.query.page ?? 1)
  const limit = Math.min(Number(req.query.limit ?? 50), 200)

  const { items, total } = await groups.list({
    owner: ownerOf(req),
    page,
    limit,
    search: req.query.search ?? null,
  })

  return sendSuccess(res, {
    message: 'Contact groups retrieved successfully.',
    data: { items },
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1,
    },
  })
})

/**
 * GET /api/v1/contact-groups/:id
 *
 * Includes the members themselves, not just their ids — the group screen always
 * needs them, and a second round trip to resolve ids would be pure latency.
 */
export const getById = asyncHandler(async (req, res) => {
  const { id } = contactIdSchema.parse(req.params)
  const owner = ownerOf(req)

  const group = await groups.findById({ owner, id })
  if (!group) throw ApiError.notFound('No group with that id exists.')

  const { items } = await contacts.list({
    owner,
    group: id,
    page: 1,
    limit: 500,
    sort: 'name',
  })

  return sendSuccess(res, {
    message: 'Contact group retrieved successfully.',
    data: { group: group.toDetailJSON(), members: items },
  })
})

/** POST /api/v1/contact-groups */
export const create = asyncHandler(async (req, res) => {
  const data = createGroupSchema.parse(req.body)
  const owner = ownerOf(req)

  try {
    const group = await groups.create({ owner, data, createdBy: owner })

    return sendSuccess(res, {
      statusCode: HTTP_STATUS.CREATED,
      message: 'Contact group created successfully.',
      data: { group: group.toPublicJSON() },
    })
  } catch (error) {
    // The unique index rejected a name this user already has. Reported as a
    // conflict rather than a generic 500.
    if (error?.code === 11000) {
      throw ApiError.conflict(`You already have a group named “${data.name}”.`)
    }
    throw error
  }
})

/** PUT /api/v1/contact-groups/:id */
export const update = asyncHandler(async (req, res) => {
  const { id } = contactIdSchema.parse(req.params)
  const data = updateGroupSchema.parse(req.body)

  try {
    const group = await groups.update({ owner: ownerOf(req), id, data, updatedBy: ownerOf(req) })
    if (!group) throw ApiError.notFound('No group with that id exists.')

    return sendSuccess(res, {
      message: 'Contact group updated successfully.',
      data: { group: group.toPublicJSON() },
    })
  } catch (error) {
    if (error?.code === 11000) {
      throw ApiError.conflict(`You already have a group named “${data.name}”.`)
    }
    throw error
  }
})

/**
 * DELETE /api/v1/contact-groups/:id
 *
 * Removes the grouping only. The contacts themselves are untouched — deleting a
 * label should never delete the people it was applied to.
 */
export const remove = asyncHandler(async (req, res) => {
  const { id } = contactIdSchema.parse(req.params)

  const group = await groups.softDelete({ owner: ownerOf(req), id, updatedBy: ownerOf(req) })
  if (!group) throw ApiError.notFound('No group with that id exists.')

  return sendSuccess(res, {
    message: 'Contact group deleted. The contacts in it were not affected.',
    data: { id, deleted: true },
  })
})

/** POST /api/v1/contact-groups/:id/members */
export const addMembers = asyncHandler(async (req, res) => {
  const { id } = contactIdSchema.parse(req.params)
  const { contactIds } = groupMembersSchema.parse(req.body)

  const group = await groups.addMembers({
    owner: ownerOf(req),
    id,
    contactIds,
    updatedBy: ownerOf(req),
  })

  if (!group) throw ApiError.notFound('No group with that id exists.')

  return sendSuccess(res, {
    message: `Group now has ${group.memberCount} member(s).`,
    data: { group: group.toPublicJSON() },
  })
})

/** DELETE /api/v1/contact-groups/:id/members */
export const removeMembers = asyncHandler(async (req, res) => {
  const { id } = contactIdSchema.parse(req.params)
  const { contactIds } = groupMembersSchema.parse(req.body)

  const group = await groups.removeMembers({
    owner: ownerOf(req),
    id,
    contactIds,
    updatedBy: ownerOf(req),
  })

  if (!group) throw ApiError.notFound('No group with that id exists.')

  return sendSuccess(res, {
    message: `Group now has ${group.memberCount} member(s).`,
    data: { group: group.toPublicJSON() },
  })
})

export default { list, getById, create, update, remove, addMembers, removeMembers }
