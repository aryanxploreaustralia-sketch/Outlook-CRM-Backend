/**
 * Analytics query validation.
 *
 * The global date range is the important one. Every analytics widget on the
 * console shares it, so a malformed or reversed range would not break one chart
 * - it would break the page, and each chart would fail differently.
 *
 * A reversed range is rejected rather than silently swapped: it returns nothing,
 * and "no data" is indistinguishable from "you asked backwards" unless somebody
 * says so.
 */

import { z } from 'zod'

import { ROLE_VALUES } from '../../../constants/roles.js'
import { ADMIN_DEFAULT_PAGE_SIZE, ADMIN_MAX_PAGE_SIZE } from '../constants/adminConstants.js'

/** Named ranges the console offers, resolved server-side so every widget agrees. */
export const DATE_PRESETS = Object.freeze([
  'today',
  'yesterday',
  'last7',
  /** Added for the lead monitor: a fortnight, and the two week-boundary ranges. */
  'last14',
  'last30',
  /** Added in 17.3: a quarter, which the performance filters offer. */
  'last90',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'all',
])

/**
 * Resolves a preset, or an explicit pair, into a concrete window.
 *
 * Resolved on the server so "last 7 days" means the same thing to every widget
 * and does not shift when a browser in another timezone computes it.
 *
 * `all` returns an open window - `undefined` bounds, which the repository omits
 * from its `$match` entirely rather than matching against a sentinel date.
 */
export function resolveRange({ preset, from, to }) {
  if (from || to) {
    const start = from ? new Date(from) : undefined
    const end = to ? new Date(to) : new Date()
    if (start) start.setUTCHours(0, 0, 0, 0)
    end.setUTCHours(23, 59, 59, 999)
    return { from: start, to: end, preset: 'custom' }
  }

  const now = new Date()
  const end = new Date(now)
  end.setUTCHours(23, 59, 59, 999)

  const startOfDay = (date) => {
    const value = new Date(date)
    value.setUTCHours(0, 0, 0, 0)
    return value
  }

  switch (preset) {
    case 'today':
      return { from: startOfDay(now), to: end, preset }
    case 'yesterday': {
      const start = startOfDay(now)
      start.setUTCDate(start.getUTCDate() - 1)
      const finish = new Date(start)
      finish.setUTCHours(23, 59, 59, 999)
      return { from: start, to: finish, preset }
    }
    case 'last7': {
      const start = startOfDay(now)
      start.setUTCDate(start.getUTCDate() - 6)
      return { from: start, to: end, preset }
    }
    case 'last14': {
      const start = startOfDay(now)
      start.setUTCDate(start.getUTCDate() - 13)
      return { from: start, to: end, preset }
    }
    /*
     * Weeks start Monday.
     *
     * `getUTCDay()` calls Sunday 0, so the offset is shifted by 6 before the
     * modulo — otherwise Sunday would open a new week rather than close one,
     * and "this week" on a Sunday would report a single day.
     */
    case 'thisWeek': {
      const start = startOfDay(now)
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
      return { from: start, to: end, preset }
    }
    case 'lastWeek': {
      const start = startOfDay(now)
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7) - 7)
      const finish = new Date(start)
      finish.setUTCDate(finish.getUTCDate() + 6)
      finish.setUTCHours(23, 59, 59, 999)
      return { from: start, to: finish, preset }
    }
    case 'last90': {
      const start = startOfDay(now)
      start.setUTCDate(start.getUTCDate() - 89)
      return { from: start, to: end, preset }
    }
    case 'thisMonth': {
      const start = startOfDay(now)
      start.setUTCDate(1)
      return { from: start, to: end, preset }
    }
    case 'lastMonth': {
      const start = startOfDay(now)
      start.setUTCDate(1)
      start.setUTCMonth(start.getUTCMonth() - 1)
      const finish = startOfDay(now)
      finish.setUTCDate(0)
      finish.setUTCHours(23, 59, 59, 999)
      return { from: start, to: finish, preset }
    }
    case 'thisYear': {
      const start = startOfDay(now)
      start.setUTCMonth(0, 1)
      return { from: start, to: end, preset }
    }
    case 'all':
      // Unbounded. The repository omits the date clause rather than matching
      // against an arbitrary epoch.
      return { from: undefined, to: undefined, preset }
    case 'last30':
    default: {
      const start = startOfDay(now)
      start.setUTCDate(start.getUTCDate() - 29)
      return { from: start, to: end, preset: 'last30' }
    }
  }
}

const rangeShape = {
  preset: z.enum(DATE_PRESETS).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}

const orderedRange = (schema) =>
  schema.refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The start of the range must not be after its end.',
    path: ['from'],
  })

/** `GET /admin/analytics/team` */
export const teamQuerySchema = orderedRange(
  z.object({
    ...rangeShape,
    search: z.string().trim().min(1).max(120).optional(),
    role: z.enum(ROLE_VALUES).optional(),
    sort: z.enum(['score', 'emails', 'replies', 'leads', 'name', 'activity']).default('score'),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(ADMIN_MAX_PAGE_SIZE).default(ADMIN_DEFAULT_PAGE_SIZE),
  }),
)

/** `GET /admin/analytics/users/:id` */
export const userTrendQuerySchema = orderedRange(
  z.object({
    ...rangeShape,
    /** Bucket size. Named `unit` to match `$dateTrunc`. */
    unit: z.enum(['day', 'week', 'month', 'year']).default('day'),
  }),
)

/** Shared by the mailbox, lead and activity endpoints. */
export const rangeQuerySchema = orderedRange(z.object(rangeShape))

export const activityQuerySchema = orderedRange(
  z.object({
    ...rangeShape,
    limit: z.coerce.number().int().min(1).max(100).default(40),
  }),
)

/** `GET /admin/users/:id/performance` and `GET /profile/performance` (17.3). */
export const performanceQuerySchema = orderedRange(
  z.object({
    ...rangeShape,
    /** How many audit entries the activity timeline shows. */
    timelineLimit: z.coerce.number().int().min(1).max(100).default(20),
  }),
)

/**
 * `GET /admin/performance/compare` (17.3).
 *
 * Two to four people. One is not a comparison, and beyond four the table stops
 * fitting on a screen at any font size worth reading — at which point the
 * leaderboard is the right tool.
 */
export const performanceCompareQuerySchema = orderedRange(
  z.object({
    ...rangeShape,
    users: z
      .string()
      .trim()
      .min(1)
      .transform((value) => [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))])
      .pipe(
        z
          .array(z.string().regex(/^[a-f\d]{24}$/i, 'Each id must be a MongoDB ObjectId.'))
          .min(2, 'Choose at least two people to compare.')
          .max(4, 'Compare at most four people at once.'),
      ),
  }),
)

export default {
  activityQuerySchema,
  performanceCompareQuerySchema,
  performanceQuerySchema,
  rangeQuerySchema,
  teamQuerySchema,
  userTrendQuerySchema,
}
