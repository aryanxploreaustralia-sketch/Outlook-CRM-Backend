/**
 * Directory validation.
 *
 * Zod, matching the rest of the codebase. The error handler already turns a
 * `ZodError` into a 422 with field-level detail, so nothing here formats a
 * response.
 *
 * ## What is actually being defended
 *
 * On the read side, the same two things every list endpoint must bound: `limit`,
 * or one request asks for the whole collection, and `sort`, which reaches
 * Mongoose directly and would otherwise be an in-memory sort of an unindexed
 * field.
 *
 * On the write side, the address. It is the join key the Google identity flow
 * uses to turn an invitation into a real account, so it has to be stored in
 * exactly the form that flow will look for — trimmed and lowercased — or the
 * invitation silently never matches anybody.
 */

import { z } from 'zod'

import { ROLE_OPTIONS } from '../../../constants/roleAssignment.js'
import { ROLE_VALUES } from '../../../constants/roles.js'
import { USER_STATUS_VALUES } from '../../../constants/userStatus.js'
import {
  ADMIN_DEFAULT_PAGE_SIZE,
  ADMIN_MAX_PAGE_SIZE,
} from '../constants/adminConstants.js'

/**
 * A CRM email address.
 *
 * Trimmed and lowercased **inside the schema**, so every consumer receives the
 * canonical form and no call site can forget to normalise. This is what makes
 * "case-insensitive uniqueness" true: the stored value and the compared value
 * are the same string, and the duplicate check stays an indexed equality rather
 * than a regex scan.
 */
const emailField = z
  .string({ message: 'An email address is required.' })
  .trim()
  .toLowerCase()
  .min(3, 'That email address is too short.')
  .max(254, 'That email address is too long.')
  .email('Enter a valid email address.')

/**
 * Sortable fields.
 *
 * An allowlist, not a pattern. Every entry is a field the collection is indexed
 * on or small enough to sort without concern.
 */
const USER_SORTS = Object.freeze([
  'createdAt',
  '-createdAt',
  'lastLoginAt',
  '-lastLoginAt',
  'displayName',
  '-displayName',
  'email',
  '-email',
  'role',
  '-role',
  'status',
  '-status',
])

const positiveInt = (max) => z.coerce.number().int().min(1).max(max)

/** `GET /admin/users` */
export const adminUserListQuerySchema = z
  .object({
    page: positiveInt(10_000).default(1),
    limit: positiveInt(ADMIN_MAX_PAGE_SIZE).default(ADMIN_DEFAULT_PAGE_SIZE),
    search: z.string().trim().min(1).max(120).optional(),
    role: z.enum(ROLE_VALUES).optional(),
    status: z.enum(USER_STATUS_VALUES).optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    lastLoginFrom: z.coerce.date().optional(),
    lastLoginTo: z.coerce.date().optional(),
    sort: z.enum(USER_SORTS).default('-createdAt'),
  })
  /**
   * A reversed range returns nothing and explains nothing, so the reader
   * concludes the directory is empty rather than that they asked backwards.
   */
  .refine((value) => !value.createdFrom || !value.createdTo || value.createdFrom <= value.createdTo, {
    message: 'The "created from" date must not be after the "created to" date.',
    path: ['createdFrom'],
  })
  .refine(
    (value) => !value.lastLoginFrom || !value.lastLoginTo || value.lastLoginFrom <= value.lastLoginTo,
    {
      message: 'The "last login from" date must not be after the "last login to" date.',
      path: ['lastLoginFrom'],
    },
  )

/** A Mongo ObjectId in a path parameter. */
export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'That is not a valid user id.')

/**
 * `POST /admin/users/invite`
 *
 * `role` is required rather than defaulted. The schema's default is `owner`,
 * and an invitation that silently created an owner because a form field was
 * missed is the single worst outcome this endpoint could have.
 */
export const adminUserInviteSchema = z.object({
  fullName: z
    .string({ message: 'A full name is required.' })
    .trim()
    .min(2, 'Enter the person’s full name.')
    .max(128, 'That name is too long.'),

  email: emailField,

  role: z.enum(ROLE_VALUES, {
    message: `Choose a role. One of: ${ROLE_VALUES.join(', ')}.`,
  }),

  /**
   * The Microsoft address this person will sign in with (Phase 14.8C).
   *
   * Optional, and deliberately unrelated to `email`. An owner may be invited as
   * `enquiry@xploreaustralia.com` while their primary address is
   * `aryan@gmail.com`; requiring the two to match is the assumption this phase
   * exists to remove.
   */
  microsoftEmail: emailField.optional().nullable(),

  notes: z.string().trim().max(512, 'Notes are limited to 512 characters.').optional(),
})

/**
 * `DELETE /admin/users/:id`
 *
 * The body is optional — a delete with no explanation is still a valid delete,
 * and demanding one would push administrators towards typing "x". When given,
 * it lands on the audit entry, which is where anybody asking "why is this
 * person gone" will look.
 */
export const adminUserDeleteSchema = z.object({
  reason: z.string().trim().max(500).optional().nullable(),
})

/** `PUT /admin/users/:id/microsoft-identity` */
export const microsoftIdentitySchema = z.object({
  microsoftEmail: emailField,
})

/**
 * `PATCH /admin/users/:id/role`
 *
 * The role is validated against `ROLE_OPTIONS`, not against every value the
 * schema enum permits: `member` is a legacy role kept alive so existing
 * documents keep validating, and it must not become newly assignable.
 *
 * The reason is optional and bounded. It is free text written by an
 * administrator that ends up on an audit entry, so it is length-capped here
 * rather than trusted to be a sentence.
 */
export const adminUserRoleSchema = z.object({
  role: z.enum(ROLE_OPTIONS),
  reason: z.string().trim().max(500).optional().nullable(),
})

export default {
  adminUserInviteSchema,
  adminUserListQuerySchema,
  adminUserDeleteSchema,
  adminUserRoleSchema,
  microsoftIdentitySchema,
  objectIdSchema,
}
