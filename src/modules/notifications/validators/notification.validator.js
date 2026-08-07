/**
 * Notification query validation.
 *
 * Categories and types are validated against the model's own enums, so a filter
 * that cannot exist is a 422 rather than a silent empty list — "no results" and
 * "you asked for a category that does not exist" look identical in a dropdown,
 * and only one of them is the caller's mistake to fix.
 */

import { z } from 'zod'

import {
  NOTIFICATION_CATEGORY_VALUES,
  NOTIFICATION_TYPE_VALUES,
} from '../../../models/notification.model.js'

/** `GET /notifications` */
export const notificationListSchema = z
  .object({
    category: z.enum(NOTIFICATION_CATEGORY_VALUES).optional(),
    type: z.enum(NOTIFICATION_TYPE_VALUES).optional(),
    unreadOnly: z.coerce.boolean().optional(),
    /** Bounded: this reaches a `$text` search. */
    search: z.string().trim().min(2).max(120).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    /** The bell wants a flat list; the full page wants Today/Yesterday/… */
    grouped: z.coerce.boolean().default(false),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start of the range must not be after its end.',
    path: ['from'],
  })

export const notificationIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'That is not a valid notification id.')

export default { notificationIdSchema, notificationListSchema }
