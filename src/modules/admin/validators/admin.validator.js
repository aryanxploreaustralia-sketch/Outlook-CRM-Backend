/**
 * Query validation for the read-only admin endpoints.
 *
 * The directory has its own schemas in `adminUser.validator.js`, because Phase
 * 14.3A gave it filters, a body and a path parameter that nothing else here
 * needs.
 *
 * Zod, matching the rest of the codebase, and applied to **read** endpoints —
 * which is not redundant. A query string is caller-controlled input that reaches
 * a database filter, and the two things guarded here are the two that actually
 * bite:
 *
 *  - **`limit`.** Uncapped, one request asks for every user in the deployment
 *    and the pagination stops being a bound on anything.
 *  - **`sort`.** Passed straight to Mongoose, an arbitrary string is a sort on
 *    an unindexed field, which is an in-memory sort of the whole collection.
 *    So it is an allowlist, not a string.
 *
 * The error handler already converts a `ZodError` into a 422 with field detail,
 * so nothing here formats a message.
 */

import { z } from 'zod'

import {
  ANALYTICS_GRANULARITY_VALUES,
  ANALYTICS_MAX_BUCKETS,
} from '../constants/adminConstants.js'
import { CAMPAIGN_STATUS_VALUES } from '../../campaigns/constants/campaignConstants.js'
import { LEAD_STAGE_VALUES } from '../../leads/constants/leadConstants.js'
import { DATE_PRESETS } from './adminAnalytics.validator.js'

/** Free text that reaches a regex. Bounded so a filter cannot be a novel. */
const searchTerm = z.string().trim().min(1).max(120).optional()

/**
 * Analytics window.
 *
 * `from`/`to` are validated as dates *and* as an ordered pair — a reversed range
 * produces an empty aggregation with no explanation, which reads as "there is no
 * data" rather than "you asked for a range that runs backwards".
 *
 * The span is capped against `ANALYTICS_MAX_BUCKETS` in day-equivalents, because
 * this endpoint aggregates the live collections with no snapshot table in front
 * of it. See `adminTimeseries.repository.js`.
 */
export const adminAnalyticsQuerySchema = z
  .object({
    /**
     * The shared reporting period, accepted by name.
     *
     * Added in Phase 14.6 so this endpoint answers the same window as every
     * other analytics surface. Without it, Zod would strip an unrecognised
     * `preset` and this chart would quietly describe a different period from
     * the cards above it — the exact failure the global filter exists to
     * prevent. The controller resolves it into `from`/`to`.
     */
    preset: z.enum(DATE_PRESETS).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    granularity: z.enum(ANALYTICS_GRANULARITY_VALUES).default('day'),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start of the range must not be after its end.',
    path: ['from'],
  })
  .refine(
    (value) => {
      if (!value.from || !value.to) return true

      const days = (value.to - value.from) / 86_400_000
      const perBucket = value.granularity === 'month' ? 28 : value.granularity === 'week' ? 7 : 1

      return days / perBucket <= ANALYTICS_MAX_BUCKETS
    },
    {
      message: `The requested range exceeds ${ANALYTICS_MAX_BUCKETS} buckets. Narrow the range or use a coarser granularity.`,
      path: ['to'],
    },
  )

export const adminCampaignQuerySchema = z.object({
  search: searchTerm,
  status: z.enum(CAMPAIGN_STATUS_VALUES).optional(),
})

export const adminLeadQuerySchema = z.object({
  search: searchTerm,
  stage: z.enum(LEAD_STAGE_VALUES).optional(),
  /** The two conditions the monitor exists to surface, as one-click filters. */
  attention: z.enum(['unassigned', 'stale']).optional(),
  /** Restrict to one person's register. Used by the admin user profile. */
  owner: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  /** Server-side paging. The monitor used to return a fixed newest-200 slice. */
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default {
  adminAnalyticsQuerySchema,
  adminCampaignQuerySchema,
  adminLeadQuerySchema,
}
