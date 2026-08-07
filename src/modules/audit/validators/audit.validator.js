/**
 * Audit query validation.
 *
 * Every filter the console offers is validated against the registry, not
 * against free text. A category or action that cannot exist is rejected with a
 * 422 rather than silently matching nothing — "no results" and "you asked for a
 * category that does not exist" look identical in a table, and only one of them
 * is the operator's mistake to fix.
 *
 * The date range reuses `resolveRange` from the analytics validator rather than
 * defining a second set of presets. Two implementations of "last 7 days" is how
 * the audit page and the analytics page end up disagreeing about which week
 * they are showing.
 */

import { z } from 'zod'

import {
  AUDIT_ACTION_VALUES,
  AUDIT_CATEGORY_VALUES,
  AUDIT_ENTITY_VALUES,
  AUDIT_RESULT_VALUES,
  AUDIT_SEVERITY_VALUES,
} from '../../../constants/auditEvents.js'
import { DATE_PRESETS } from '../../admin/validators/adminAnalytics.validator.js'

/** Page size. Capped because the export endpoint exists for bulk reads. */
const MAX_LIMIT = 100

const objectIdish = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, { message: 'Expected a 24-character identifier.' })

const filterShape = {
  preset: z.enum(DATE_PRESETS).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),

  category: z.enum(AUDIT_CATEGORY_VALUES).optional(),
  action: z.enum(AUDIT_ACTION_VALUES).optional(),
  result: z.enum(AUDIT_RESULT_VALUES).optional(),
  severity: z.enum(AUDIT_SEVERITY_VALUES).optional(),
  entityType: z.enum(AUDIT_ENTITY_VALUES).optional(),
  entityId: z.string().trim().min(1).max(64).optional(),

  actor: objectIdish.optional(),
  performedFor: objectIdish.optional(),
  mailboxId: objectIdish.optional(),
  campaignId: objectIdish.optional(),
  leadId: objectIdish.optional(),

  /**
   * Bounded. This reaches a `$text` search, and an unbounded term is a cheap
   * way to make the text index do pointless work on every keystroke.
   */
  search: z.string().trim().min(2).max(120).optional(),
}

/** A reversed range returns nothing, which reads as "no activity". Rejected. */
const ordered = (schema) =>
  schema.refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start of the range must not be after its end.',
    path: ['from'],
  })

/** `GET /audit/logs` */
export const auditListQuerySchema = ordered(
  z.object({
    ...filterShape,
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(25),
    /** Keyset cursor. Opaque to the client — `<epochMs>_<objectId>`. */
    cursor: z.string().trim().max(64).optional(),
    page: z.coerce.number().int().min(1).max(200).optional(),
  }),
)

/** `GET /audit/facets` — the filter option counts. */
export const auditFacetQuerySchema = ordered(z.object(filterShape))

/** `GET /audit/export` */
export const auditExportQuerySchema = ordered(
  z.object({
    ...filterShape,
    format: z.enum(['csv', 'json']).default('csv'),
  }),
)

/** `GET /audit/timeline` — the grouped activity feed. */
export const auditTimelineQuerySchema = ordered(
  z.object({
    ...filterShape,
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  }),
)

export const auditIdSchema = objectIdish

export default {
  auditExportQuerySchema,
  auditFacetQuerySchema,
  auditIdSchema,
  auditListQuerySchema,
  auditTimelineQuerySchema,
}
