/**
 * Audit reads: the log, the timeline, the detail view and the export.
 *
 * Recording lives in `auditRecorder.service.js`. The two are separate files
 * because they have opposite risk profiles — recording must never throw and is
 * called from thirty production controllers, while reading is a single
 * permissioned surface that should fail loudly. Mixing them would mean the
 * swallow-everything discipline of one leaked into the other.
 */

import { config } from '../../../config/index.js'
import {
  AUDIT_ACTION_OPTIONS,
  AUDIT_CATEGORY_LABELS,
  AUDIT_CATEGORY_VALUES,
  AUDIT_ENTITY_VALUES,
  AUDIT_EVENTS,
  AUDIT_RESULT_VALUES,
  AUDIT_SEVERITY_VALUES,
} from '../../../constants/auditEvents.js'
import { auditDetailDTO, auditEntryDTO } from '../dto/audit.dto.js'
import * as repository from '../repositories/audit.repository.js'

/**
 * The log.
 *
 * The count runs beside the page rather than before it — they are independent
 * queries and the rows are what the operator is waiting for.
 *
 * `total` is omitted entirely when a search term is present. Counting a `$text`
 * match is as expensive as running it, and a total nobody scrolls to is not
 * worth doubling the cost of every keystroke. The response says so rather than
 * sending a zero that would render as "no results" above a full table.
 */
export async function listAuditLogs(query) {
  const { limit, cursor, page, ...filters } = query

  const [pageResult, total] = await Promise.all([
    repository.listAuditEntries(filters, { limit, cursor, page }),
    filters.search ? Promise.resolve(null) : repository.countAuditEntries(filters),
  ])

  return {
    items: pageResult.items.map(auditEntryDTO),

    pagination: {
      limit,
      page: page ?? 1,
      /** Feed back as `cursor` for the next page. Null when there is none. */
      nextCursor: pageResult.nextCursor,
      hasMore: pageResult.hasMore,
      total,
      totalPages: total === null ? null : Math.max(1, Math.ceil(total / limit)),
      /**
       * Stated so the console can explain a missing page count rather than
       * rendering it as zero.
       */
      totalOmitted: total === null ? 'Counting is skipped while searching.' : null,
      maxOffsetPage: repository.MAX_OFFSET_PAGE,
    },

    meta: { source: 'live', generatedAt: new Date().toISOString() },
  }
}

/**
 * One entry in full.
 *
 * Returns null rather than throwing so the controller decides the status. A
 * missing audit entry is a 404 — unlike a permission failure, which is a 403
 * and is decided by the route guard well before this runs.
 */
export async function getAuditEntry(id) {
  const entry = await repository.findAuditEntry(id)
  return entry ? auditDetailDTO(entry) : null
}

/**
 * The timeline: the same entries, grouped the way a person reads them.
 *
 * Grouped on the **server** so "Today" means the server's day — the same day
 * the `occurredAt` values were written in. Grouping in the browser would put an
 * entry written at 23:30 UTC under "Yesterday" for a reader in London and
 * "Today" for one in Sydney, from identical data.
 */
export async function getAuditTimeline(query) {
  const { limit, ...filters } = query
  const { items } = await repository.listAuditEntries(filters, { limit })

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)

  const groups = { today: [], yesterday: [], earlier: [] }

  for (const entry of items) {
    const at = new Date(entry.occurredAt)
    const bucket = at >= startOfToday ? 'today' : at >= startOfYesterday ? 'yesterday' : 'earlier'
    groups[bucket].push(auditEntryDTO(entry))
  }

  return {
    // An array rather than an object: it preserves display order, and an empty
    // group is dropped here so the console never renders a heading above
    // nothing.
    groups: [
      { key: 'today', label: 'Today', items: groups.today },
      { key: 'yesterday', label: 'Yesterday', items: groups.yesterday },
      { key: 'earlier', label: 'Earlier', items: groups.earlier },
    ].filter((group) => group.items.length > 0),

    total: items.length,
    meta: { source: 'live', generatedAt: new Date().toISOString() },
  }
}

/**
 * Filter options with counts, plus the catalogue.
 *
 * The catalogue is sent unconditionally and the counts only describe the
 * current filter. That distinction matters: a category with zero entries must
 * still appear in the dropdown, or an operator cannot select it to discover
 * that nothing happened — the absence of the option reads as the absence of the
 * feature.
 */
export async function getAuditFacets(query) {
  const facets = await repository.auditFacets(query)

  const countsFor = (rows) => Object.fromEntries(rows.map((row) => [row._id, row.count]))
  const categoryCounts = countsFor(facets.byCategory)
  const resultCounts = countsFor(facets.byResult)
  const severityCounts = countsFor(facets.bySeverity)
  const actionCounts = countsFor(facets.byAction)

  return {
    categories: AUDIT_CATEGORY_VALUES.map((value) => ({
      value,
      label: AUDIT_CATEGORY_LABELS[value] ?? value,
      count: categoryCounts[value] ?? 0,
    })),

    actions: AUDIT_ACTION_OPTIONS.map((option) => ({
      ...option,
      count: actionCounts[option.value] ?? 0,
    })),

    results: AUDIT_RESULT_VALUES.map((value) => ({ value, count: resultCounts[value] ?? 0 })),
    severities: AUDIT_SEVERITY_VALUES.map((value) => ({ value, count: severityCounts[value] ?? 0 })),
    entityTypes: AUDIT_ENTITY_VALUES.map((value) => ({ value })),

    /** Only people who actually appear in the log — a list of every user would
        offer filters that can only ever return nothing. */
    actors: facets.actors
      .filter((row) => row._id)
      .map((row) => ({
        id: String(row._id),
        email: row.email ?? null,
        role: row.role ?? null,
        count: row.count,
      })),

    meta: { source: 'live', generatedAt: new Date().toISOString() },
  }
}

/**
 * Coverage, retention and extent — the panel above the log.
 *
 * `coverage` is derived from the registry, so it cannot claim to record
 * something that was never declared. It reports what the system is *capable* of
 * recording; the facet counts report what has actually happened.
 */
export async function getAuditOverview() {
  const stats = await repository.auditStats()

  return {
    ...stats,

    retention: {
      enabled: config.audit.retentionEnabled,
      days: config.audit.retentionDays,
      note: config.audit.retentionEnabled
        ? `Entries are deleted automatically after ${config.audit.retentionDays} days by a database TTL index.`
        : 'Retention is disabled. Entries are kept indefinitely.',
      /** Configuration, not a control. There is deliberately no UI to change it. */
      configurable: 'AUDIT_RETENTION_DAYS',
    },

    coverage: {
      eventCount: Object.keys(AUDIT_EVENTS).length,
      categories: AUDIT_CATEGORY_VALUES.length,
      note: 'Events are declared in a central registry. Anything not listed there is not recorded.',
    },

    export: { limit: config.audit.exportLimit },

    meta: { source: 'live', generatedAt: new Date().toISOString() },
  }
}

/**
 * The rows for an export, honouring the current filter.
 *
 * Capped, and the cap is reported. A file that silently stops at ten thousand
 * rows is worse than one that says it did — the second can be narrowed and
 * re-run, the first gets filed as complete.
 */
export async function getAuditExport(query) {
  const { format, ...filters } = query
  const cap = config.audit.exportLimit

  const rows = await repository.listAuditForExport(filters, cap)

  return {
    format,
    items: rows.map(auditEntryDTO),
    truncated: rows.length === cap,
    limit: cap,
  }
}

export default {
  getAuditEntry,
  getAuditExport,
  getAuditFacets,
  getAuditOverview,
  getAuditTimeline,
  listAuditLogs,
}
