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
import { PERMISSION_VALUES } from '../../../constants/permissions.js'
import { CAMPAIGN_STATUS_VALUES } from '../../campaigns/constants/campaignConstants.js'
import { LEAD_STAGE_VALUES, MARKET_VALUES } from '../../leads/constants/leadConstants.js'
import { AUTO_MAIL_STATUS_VALUES } from '../../leads/constants/syncConstants.js'
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
  /** Restrict to one person's campaigns. Used by the admin user profile. */
  owner: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  /*
   * `limit` defaults to 200, the ceiling this endpoint already applied, so an
   * existing caller that sends neither parameter gets exactly what it got
   * before.
   */
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(200),
})

/**
 * A repeatable enum filter, accepted as one value or a comma-separated list.
 *
 * `stage=query` and `stage=query,active` both parse, to an array either way, so
 * the service has one shape to handle and builds `$in` unconditionally. The
 * console's dropdowns send a single value today; the wire format is what would
 * have had to change to allow more than one, and changing it later would mean
 * versioning the endpoint.
 *
 * Unknown members are rejected rather than dropped. Silently ignoring a typo
 * would widen the result set — the reader would see rows their filter excluded
 * and have no way to tell why.
 */
const enumList = (values) =>
  z
    .string()
    .transform((raw) => raw.split(',').map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1))
    .optional()

/** `YYYY-MM-DD`, matching the `<input type="date">` the console sends. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()

/**
 * An IANA timezone name the caller's browser reported.
 *
 * Validated by asking `Intl` to use it, because an unrecognised name reaches
 * MongoDB's `$dateToString` and throws there instead — a 500 for what is a bad
 * request. Falls back to UTC rather than rejecting: a calendar that renders in
 * the wrong timezone is a nuisance, one that refuses to render is a fault.
 */
const timezone = z
  .string()
  .trim()
  .max(64)
  .optional()
  .transform((value) => {
    if (!value) return 'UTC'
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: value })
      return value
    } catch {
      return 'UTC'
    }
  })

/** A required `YYYY-MM-DD`, for the calendar's own bounds. */
const requiredIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * `GET /admin/calendar` — per-day counts across a visible range.
 *
 * The span is capped so one request cannot ask the database to group a decade.
 * 62 days covers the widest thing the month grid ever shows (a six-week grid
 * spilling into both neighbouring months) with room to spare.
 */
export const adminCalendarQuerySchema = z
  .object({ from: requiredIsoDate, to: requiredIsoDate, tz: timezone })
  .refine((value) => value.from <= value.to, { message: '`from` must not be after `to`.' })
  .refine(
    (value) => (Date.parse(value.to) - Date.parse(value.from)) / 86400000 <= 62,
    { message: 'A calendar range may not exceed 62 days.' },
  )
  /*
   * `tz` on the wire, `timezone` in the service.
   *
   * Renamed here rather than at the call site so the service cannot be handed
   * an object that merely looks right: it reads `timezone`, and a parsed query
   * carrying only `tz` would silently fall back to UTC and group every task on
   * the wrong day for anyone east or west of Greenwich.
   */
  .transform(({ from, to, tz }) => ({ from, to, timezone: tz }))

/** `GET /admin/calendar/:date` — one day, in detail. */
export const adminCalendarDaySchema = z
  .object({ date: requiredIsoDate, tz: timezone })
  .transform(({ date, tz }) => ({ date, timezone: tz }))

export const adminLeadQuerySchema = z.object({
  search: searchTerm,
  stage: enumList(LEAD_STAGE_VALUES),
  /** Destination market, from the workbook's own AU/NZ split. */
  market: enumList(MARKET_VALUES),
  /** The automatic introduction email's state — the `Introduction` column. */
  introduction: enumList(AUTO_MAIL_STATUS_VALUES),
  /** The two conditions the monitor exists to surface, as one-click filters. */
  attention: z.enum(['unassigned', 'stale']).optional(),
  /**
   * Movement, which is a different question from `attention`.
   *
   * `replied` and `awaiting` read real fields (`replyReceived`, and the
   * introduction status for "we wrote, they have not"). There is deliberately
   * no follow-up option: `Lead` records no follow-up date, and an option that
   * silently matched something else would be worse than its absence.
   */
  activity: z.enum(['recent', 'quiet', 'replied', 'awaiting']).optional(),
  /** Restrict to one person's register. Used by the admin user profile. */
  owner: z.string().regex(/^[a-f\d]{24}$/i).optional(),

  /**
   * Which date the range applies to, named explicitly.
   *
   * A range filter that does not say what it filters is a guess. `updatedAt` is
   * offered as "last activity" for the same reason the column is — it is the
   * record's last modification, which the page states rather than implies.
   */
  dateField: z.enum(['createdAt', 'quoteDate', 'updatedAt', 'travelDate']).default('travelDate'),
  preset: z.enum(DATE_PRESETS).optional(),
  from: isoDate,
  to: isoDate,

  /**
   * Row order.
   *
   * `recent` is the register's own order and the default, so every existing
   * caller is unaffected. `travel` exists because "which customers are
   * travelling soonest" cannot be answered by sorting a page in the browser:
   * the page is chosen by `createdAt` first, so the nearest departure may be
   * on a page the client never fetched.
   *
   * A whitelist rather than a field name — a caller must not be able to name
   * an arbitrary, unindexed field to sort a collection this size by.
   */
  sort: z.enum(['recent', 'travel']).default('recent'),

  /** Server-side paging. The monitor used to return a fixed newest-200 slice. */
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/**
 * Body for `PATCH /admin/roles/:role`.
 *
 * The complete permission list, not a delta. The service compares it against
 * what the role holds to derive what was granted and revoked, so the client
 * never has to describe the change — only the desired end state, which is
 * exactly what the checkboxes on screen represent.
 *
 * Membership is checked against `PERMISSION_VALUES` here and again in the
 * service. An empty list is legal: a role may hold nothing.
 */
export const adminRolePermissionsSchema = z.object({
  permissions: z.array(z.enum(PERMISSION_VALUES)).max(PERMISSION_VALUES.length),
})

export default {
  adminAnalyticsQuerySchema,
  adminCampaignQuerySchema,
  adminCalendarDaySchema,
  adminCalendarQuerySchema,
  adminLeadQuerySchema,
  adminRolePermissionsSchema,
}
