/**
 * Profile validation.
 *
 * ## The schema is the permission boundary
 *
 * `email`, `role`, `status` and `joiningDate` are absent from the update schema
 * — not optional, absent. Zod strips unknown keys, so a hand-crafted PATCH
 * carrying `"role": "owner"` has that key removed before the service ever sees
 * it. Hiding those fields in the form would be a suggestion; leaving them out
 * of the schema is the control.
 */

import { z } from 'zod'
import { sanitizeEmailHtml } from '../../../utils/emailHtml.js'

import {
  DOCUMENT_CATEGORY_VALUES,
  GENDER_VALUES,
} from '../../../constants/employeeProfile.js'

/**
 * A phone number, loosely.
 *
 * Deliberately not a strict E.164 or per-country format. This CRM operates
 * across borders, an emergency contact may be a landline with an extension, and
 * a validator that rejects a number somebody actually has is worse than one
 * that accepts a number they will only ever read. Digits, spaces and the
 * punctuation people really type; length-bounded so it cannot be an essay.
 */
const phone = z
  .string()
  .trim()
  .min(6, 'That number looks too short.')
  .max(32, 'That number looks too long.')
  .regex(/^[+\d][\d\s().-]*$/, 'Use digits, spaces and + ( ) - only.')

/** Trims, and turns an emptied field into `null` rather than `""`. */
const optionalText = (max, message) =>
  z
    .string()
    .trim()
    .max(max, message)
    .transform((value) => value || null)
    .nullable()
    .optional()

/**
 * A date of birth.
 *
 * Bounded at both ends. The future is obviously wrong; 120 years is the sanity
 * bound. The 16-year floor is the one worth naming — it is not a legal ruling,
 * it catches the far more common case of somebody typing this year by mistake.
 */
const dateOfBirth = z.coerce
  .date()
  .refine((value) => value <= new Date(), { message: 'A date of birth cannot be in the future.' })
  .refine(
    (value) => {
      const age = (Date.now() - value.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
      return age >= 16 && age <= 120
    },
    { message: 'Check that date — it does not look like a date of birth.' },
  )
  .nullable()
  .optional()

/** `PATCH /profile` and the admin equivalent. */
export const profileUpdateSchema = z
  .object({
    displayName: optionalText(128, 'That name is too long.'),
    phone: phone.nullable().optional(),
    employeeId: optionalText(64, 'That employee ID is too long.'),
    department: optionalText(128, 'That department name is too long.'),
    designation: optionalText(128, 'That designation is too long.'),

    dateOfBirth,
    gender: z.enum(GENDER_VALUES).nullable().optional(),

    address: z
      .object({
        line1: optionalText(256, 'That address line is too long.'),
        line2: optionalText(256, 'That address line is too long.'),
        city: optionalText(128, 'That city name is too long.'),
        state: optionalText(128, 'That state name is too long.'),
        country: optionalText(128, 'That country name is too long.'),
        postalCode: optionalText(32, 'That postal code is too long.'),
      })
      .optional(),

    emergencyContact: z
      .object({
        name: optionalText(128, 'That name is too long.'),
        phone: phone.nullable().optional(),
        relationship: optionalText(64, 'That relationship is too long.'),
      })
      .optional(),
  })
  /**
   * An emergency contact is a name *and* a number or neither.
   *
   * A name with no number is not a contact — it is the illusion of one, and the
   * moment it matters somebody will be looking at it wondering who to call.
   */
  .refine(
    (value) =>
      !value.emergencyContact ||
      Boolean(value.emergencyContact.name) === Boolean(value.emergencyContact.phone),
    {
      message: 'An emergency contact needs both a name and a number.',
      path: ['emergencyContact', 'phone'],
    },
  )

/** `POST /profile/documents` — metadata arrives as headers beside the raw body. */
export const documentUploadSchema = z.object({
  title: z.string().trim().min(1, 'Give the document a title.').max(160, 'That title is too long.'),
  category: z.enum(DOCUMENT_CATEGORY_VALUES, {
    message: `Choose a category: ${DOCUMENT_CATEGORY_VALUES.join(', ')}.`,
  }),
  description: optionalText(512, 'That description is too long.'),
})

/** `PATCH /profile/documents/:id` — metadata only; bytes are optional. */
export const documentUpdateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  category: z.enum(DOCUMENT_CATEGORY_VALUES).optional(),
  description: optionalText(512, 'That description is too long.'),
})

/** `PATCH /admin/users/:id/documents/:documentId/verify|reject` */
export const documentDecisionSchema = z.object({
  remarks: optionalText(512, 'Those remarks are too long.'),
})

export const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'That is not a valid id.')

export default {
  documentDecisionSchema,
  documentUpdateSchema,
  documentUploadSchema,
  objectIdSchema,
  profileUpdateSchema,
}

/**
 * Body for `PUT /v1/account/signature`.
 *
 * Sanitised in the schema rather than the handler, so the value the controller
 * receives is already safe and there is no path where a future caller forgets.
 * The same `sanitizeEmailHtml` the send pipeline uses — a second policy for
 * signatures would be a second thing to keep in step.
 *
 * An empty string is legal: clearing the signature is an ordinary thing to do.
 */
export const signatureSchema = z.object({
  signatureHtml: z
    .string()
    .max(20_000, 'A signature cannot exceed 20,000 characters.')
    .transform(sanitizeEmailHtml),
})
