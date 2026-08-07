/**
 * Zod schemas for the contacts API.
 *
 * Validation runs before anything reaches the database, and every message is
 * written to be shown to a person — the error handler turns a `ZodError` into a
 * 422 with field-level detail.
 */

import { z } from 'zod'

import {
  CONTACT_CATEGORY_VALUES,
  CONTACT_FILTER_VALUES,
  CONTACT_SOURCE_VALUES,
  GROUP_COLORS,
  IMPORT_MODE,
  IMPORT_MODE_VALUES,
  TRANSFER_FORMAT,
  TRANSFER_FORMAT_VALUES,
} from '../constants/contactConstants.js'
import { SORT_OPTIONS } from '../repositories/contact.repository.js'

/** A trimmed string that treats empty as absent, so a cleared field becomes null. */
const optionalText = (max, label) =>
  z
    .string()
    .trim()
    .max(max, `${label} cannot exceed ${max} characters.`)
    .optional()
    .nullable()
    .transform((value) => (value === '' ? null : (value ?? null)))

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email('“{input}” is not a valid email address.')
  .optional()
  .nullable()
  .or(z.literal('').transform(() => null))

/**
 * Phone numbers are validated loosely on purpose.
 *
 * International formats vary enormously — extensions, country prefixes, local
 * conventions — and a strict pattern rejects legitimate numbers far more often
 * than it catches typos. Length and character class are checked; the rest is the
 * user's business.
 */
const optionalPhone = z
  .string()
  .trim()
  .max(48, 'Phone numbers cannot exceed 48 characters.')
  .regex(/^[\d\s()+.\-x#]*$/i, 'Phone numbers may only contain digits and the usual separators.')
  .optional()
  .nullable()
  .transform((value) => (value === '' ? null : (value ?? null)))

const optionalUrl = z
  .string()
  .trim()
  .max(512)
  .optional()
  .nullable()
  .transform((value) => (value === '' ? null : (value ?? null)))
  .refine(
    (value) => value === null || /^https?:\/\/.+/i.test(value),
    'Website must begin with http:// or https://.',
  )

/** Fields shared by create and update. */
const contactShape = {
  firstName: optionalText(128, 'First name'),
  lastName: optionalText(128, 'Last name'),
  displayName: optionalText(256, 'Display name'),
  company: optionalText(256, 'Company'),
  jobTitle: optionalText(256, 'Job title'),

  primaryEmail: optionalEmail,
  secondaryEmail: optionalEmail,

  phone: optionalPhone,
  mobile: optionalPhone,
  businessPhone: optionalPhone,

  website: optionalUrl,

  address: optionalText(512, 'Address'),
  city: optionalText(128, 'City'),
  state: optionalText(128, 'State'),
  country: optionalText(128, 'Country'),
  postalCode: optionalText(32, 'Postal code'),

  notes: optionalText(10_000, 'Notes'),

  tags: z
    .array(z.string().trim().min(1).max(48))
    .max(50, 'A contact cannot carry more than 50 tags.')
    .optional()
    // De-duplicated and lower-cased, so "VIP" and "vip" are one tag rather than
    // two entries the filter treats as different.
    .transform((tags) => (tags ? [...new Set(tags.map((tag) => tag.toLowerCase()))] : undefined)),

  category: z.enum(CONTACT_CATEGORY_VALUES).optional(),
  favorite: z.boolean().optional(),

  birthday: z.coerce.date().optional().nullable(),
  lastInteraction: z.coerce.date().optional().nullable(),
}

/**
 * `POST /contacts`.
 *
 * A contact needs at least one identifying field. A record with neither a name
 * nor an address is not a contact — it is an empty row nobody can act on.
 */
export const createContactSchema = z
  .object(contactShape)
  .refine(
    (data) => Boolean(data.firstName || data.lastName || data.displayName || data.primaryEmail),
    { message: 'A contact needs at least a name or an email address.', path: ['displayName'] },
  )

/** `PUT /contacts/:id` — every field optional; only what is sent is changed. */
export const updateContactSchema = z.object(contactShape).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'Provide at least one field to update.' },
)

/** `GET /contacts` query parameters. */
export const listContactsSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  sort: z
    .enum(Object.keys(SORT_OPTIONS), {
      message: `“sort” must be one of: ${Object.keys(SORT_OPTIONS).join(', ')}.`,
    })
    .optional()
    .default('-created'),

  search: z.string().trim().max(256).optional(),
  filter: z.enum(CONTACT_FILTER_VALUES).optional(),
  company: z.string().trim().max(256).optional(),
  country: z.string().trim().max(128).optional(),
  category: z.enum(CONTACT_CATEGORY_VALUES).optional(),
  source: z.enum(CONTACT_SOURCE_VALUES).optional(),
  group: z.string().regex(/^[0-9a-f]{24}$/i, 'That is not a valid group id.').optional(),

  // Accepts `?tags=a&tags=b` and `?tags=a,b`, because both are natural to write.
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (!value) return undefined
      const list = Array.isArray(value) ? value : String(value).split(',')
      return list.map((tag) => tag.trim().toLowerCase()).filter(Boolean)
    }),

  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})

/** Route parameter shared by every by-id endpoint. */
export const contactIdSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{24}$/i, 'That is not a valid contact id.'),
})

/** `POST /contacts/bulk`. */
export const bulkSchema = z
  .object({
    ids: z
      .array(z.string().regex(/^[0-9a-f]{24}$/i))
      .min(1, 'Select at least one contact.')
      .max(1000, 'A bulk operation is limited to 1000 contacts.'),
    action: z.enum(['delete', 'favorite', 'unfavorite', 'tag', 'untag', 'category']),
    value: z.string().trim().max(48).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    // Tagging with nothing, or setting a category to nothing, are silent no-ops
    // that look like they worked. Caught here instead.
    if (['tag', 'untag', 'category'].includes(data.action) && !data.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `“value” is required for the “${data.action}” action.`,
      })
    }

    if (data.action === 'category' && data.value && !CONTACT_CATEGORY_VALUES.includes(data.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `“value” must be one of: ${CONTACT_CATEGORY_VALUES.join(', ')}.`,
      })
    }
  })

/** `POST /contacts/sync`. */
export const syncSchema = z.object({
  mode: z.enum(['full', 'incremental']).optional().default('incremental'),
})

/**
 * `POST /contacts/import`.
 *
 * Content arrives base64-encoded in JSON rather than as multipart. It keeps the
 * API uniform — every other endpoint in this project is JSON — and avoids adding
 * a multipart parser for one route. The 10 MB ceiling comfortably exceeds any
 * realistic contact file.
 */
export const importSchema = z.object({
  format: z.enum(TRANSFER_FORMAT_VALUES).optional().default(TRANSFER_FORMAT.CSV),
  mode: z.enum(IMPORT_MODE_VALUES).optional().default(IMPORT_MODE.SKIP_DUPLICATES),
  content: z
    .string()
    .min(1, 'The file is empty.')
    .max(14_000_000, 'The file exceeds the 10 MB limit.')
    .transform((value) => value.replace(/^data:[^;,]*;base64,/, '')),
  encoding: z.enum(['base64', 'utf8']).optional().default('base64'),
  defaultTags: z.array(z.string().trim().min(1).max(48)).max(20).optional().default([]),
  /**
   * Imports a lead register as plain contacts anyway.
   *
   * Off by default. A sales workbook holds one row per *enquiry*; importing it
   * here keeps the people and silently discards every reference, quotation
   * date, party size and pipeline stage. That is data loss the user did not
   * ask for, so it has to be chosen deliberately.
   */
  contactsOnly: z.boolean().optional().default(false),
})

/** `POST /contacts/export`. */
export const exportSchema = z.object({
  format: z.enum(TRANSFER_FORMAT_VALUES).optional().default(TRANSFER_FORMAT.CSV),
  ids: z.array(z.string().regex(/^[0-9a-f]{24}$/i)).max(5000).optional(),
  filter: z.enum(CONTACT_FILTER_VALUES).optional(),
  search: z.string().trim().max(256).optional(),
  group: z.string().regex(/^[0-9a-f]{24}$/i).optional(),
})

/** `POST /contact-groups`. */
export const createGroupSchema = z.object({
  name: z.string().trim().min(1, 'A group needs a name.').max(128),
  description: optionalText(1000, 'Description'),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, 'Colour must be a hex value such as #2563eb.')
    .optional()
    .default(GROUP_COLORS[0]),
  members: z.array(z.string().regex(/^[0-9a-f]{24}$/i)).max(5000).optional().default([]),
})

/** `PUT /contact-groups/:id`. */
export const updateGroupSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: optionalText(1000, 'Description'),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  members: z.array(z.string().regex(/^[0-9a-f]{24}$/i)).max(5000).optional(),
})

/** `POST /contact-groups/:id/members`. */
export const groupMembersSchema = z.object({
  contactIds: z
    .array(z.string().regex(/^[0-9a-f]{24}$/i))
    .min(1, 'Select at least one contact.')
    .max(1000),
})

/** `POST /contacts/:id/merge`. */
export const mergeSchema = z.object({
  absorbId: z.string().regex(/^[0-9a-f]{24}$/i, 'That is not a valid contact id.'),
  strategy: z.enum(['remote_wins', 'local_wins', 'field_union', 'manual']).optional().default('field_union'),
})

export default {
  createContactSchema,
  updateContactSchema,
  listContactsSchema,
  contactIdSchema,
  bulkSchema,
  syncSchema,
  importSchema,
  exportSchema,
  createGroupSchema,
  updateGroupSchema,
  groupMembersSchema,
  mergeSchema,
}
