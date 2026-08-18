/**
 * Admin module vocabulary.
 *
 * Part of the API contract — the admin console matches on these strings — so
 * they must not be renamed once published.
 */

/**
 * Component health, as reported by `/admin/system-health`.
 *
 * Four states rather than a boolean, because "reachable but slow" and "not
 * reachable" call for different responses and a boolean cannot tell them apart.
 * `UNKNOWN` is honest rather than optimistic: a probe that could not run has not
 * proved anything, and reporting it as healthy is how an outage goes unnoticed.
 */
export const HEALTH_STATE = Object.freeze({
  HEALTHY: 'healthy',
  WARNING: 'warning',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown',
})

export const HEALTH_STATE_LABELS = Object.freeze({
  [HEALTH_STATE.HEALTHY]: 'Healthy',
  [HEALTH_STATE.WARNING]: 'Warning',
  [HEALTH_STATE.OFFLINE]: 'Offline',
  [HEALTH_STATE.UNKNOWN]: 'Unknown',
})

/**
 * Rank used to roll component states up into one platform state.
 *
 * The worst component wins. A platform reporting "healthy" while one dependency
 * is offline is a platform whose summary nobody can trust.
 */
export const HEALTH_SEVERITY = Object.freeze({
  [HEALTH_STATE.HEALTHY]: 0,
  [HEALTH_STATE.UNKNOWN]: 1,
  [HEALTH_STATE.WARNING]: 2,
  [HEALTH_STATE.OFFLINE]: 3,
})

/** Account states the admin console can display, derived from `User`. */
export const ADMIN_USER_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
})

export const ADMIN_USER_STATUS_LABELS = Object.freeze({
  [ADMIN_USER_STATUS.ACTIVE]: 'Active',
  [ADMIN_USER_STATUS.SUSPENDED]: 'Suspended',
})

/** Time buckets `/admin/analytics` can group by. */
export const ANALYTICS_GRANULARITY = Object.freeze({
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
})

export const ANALYTICS_GRANULARITY_VALUES = Object.freeze(Object.values(ANALYTICS_GRANULARITY))

/**
 * Bucket ceiling.
 *
 * An unbounded range is an unbounded aggregation, and these run against the
 * live collections with no snapshot table in front of them. Ninety-two buckets
 * covers a quarter of days, eighteen months of weeks, or seven years of months —
 * beyond which the chart is unreadable long before the query is slow.
 */
export const ANALYTICS_MAX_BUCKETS = 92

/** Default window per granularity, in buckets, when the caller names no range. */
export const ANALYTICS_DEFAULT_BUCKETS = Object.freeze({
  [ANALYTICS_GRANULARITY.DAY]: 30,
  [ANALYTICS_GRANULARITY.WEEK]: 12,
  [ANALYTICS_GRANULARITY.MONTH]: 12,
})

/** A user who has signed in within this many days counts as active. */
export const ACTIVE_USER_WINDOW_DAYS = 7

/** An enquiry with no recorded activity for this long is flagged as stale. */
export const STALE_LEAD_DAYS = 30

/**
 * An enquiry touched within this many days counts as recently active.
 *
 * Deliberately shorter than `STALE_LEAD_DAYS`, and deliberately not equal to it.
 * Staleness answers "has this been abandoned", which is a month-scale question;
 * the monitor's activity filter answers "is this moving", which is a week-scale
 * one. Sharing a single threshold would make "recently active" mean "not yet
 * abandoned" — true of almost every row, and so of no use as a filter.
 */
export const ACTIVE_LEAD_DAYS = 7

/** Page size ceiling for every admin list endpoint. */
export const ADMIN_MAX_PAGE_SIZE = 100

/** Default page size for every admin list endpoint. */
export const ADMIN_DEFAULT_PAGE_SIZE = 25

export default HEALTH_STATE
