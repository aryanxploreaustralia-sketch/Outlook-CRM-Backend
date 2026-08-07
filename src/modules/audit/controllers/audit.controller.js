/**
 * Audit controllers.
 *
 * Read-only. There is no create endpoint and no delete endpoint, deliberately:
 * an audit log an operator can write to by hand is not evidence, and one they
 * can delete from is not a log. Entries arrive only through `recordAudit()`
 * from inside the modules that perform the actions, and leave only through the
 * retention TTL.
 */

import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { ApiError } from '../../../utils/ApiError.js'
import { resolveRange } from '../../admin/validators/adminAnalytics.validator.js'
import { describeDevice } from '../dto/audit.dto.js'
import {
  getAuditEntry,
  getAuditExport,
  getAuditFacets,
  getAuditOverview,
  getAuditTimeline,
  listAuditLogs,
} from '../services/audit.service.js'
import {
  auditExportQuerySchema,
  auditFacetQuerySchema,
  auditIdSchema,
  auditListQuerySchema,
  auditTimelineQuerySchema,
} from '../validators/audit.validator.js'

/**
 * Folds the shared date presets into concrete bounds.
 *
 * The audit page uses the same `preset` vocabulary as every analytics surface,
 * so "last 7 days" means one thing across the console. Explicit `from`/`to`
 * win, matching `resolveRange`'s own precedence.
 */
function withRange(query) {
  const range = resolveRange(query)
  return { ...query, from: range.from, to: range.to, preset: range.preset }
}

/** GET /api/v1/audit/logs */
export const getAuditLogs = asyncHandler(async (req, res) => {
  const query = withRange(auditListQuerySchema.parse(req.query))

  return sendSuccess(res, {
    message: 'Audit log loaded.',
    data: {
      ...(await listAuditLogs(query)),
      range: { preset: query.preset, from: query.from ?? null, to: query.to ?? null },
    },
  })
})

/** GET /api/v1/audit/logs/:id */
export const getAuditLogDetail = asyncHandler(async (req, res) => {
  const entry = await getAuditEntry(auditIdSchema.parse(req.params.id))

  // 404 because the entry genuinely does not exist. A caller without
  // `audit.view` never reaches this line — the route guard answered 403 first,
  // which is the distinction the whole permission engine rests on.
  if (!entry) throw ApiError.notFound('That audit entry does not exist.')

  return sendSuccess(res, { message: 'Audit entry loaded.', data: entry })
})

/** GET /api/v1/audit/timeline */
export const getAuditActivityTimeline = asyncHandler(async (req, res) => {
  const query = withRange(auditTimelineQuerySchema.parse(req.query))

  return sendSuccess(res, {
    message: 'Activity timeline loaded.',
    data: {
      ...(await getAuditTimeline(query)),
      range: { preset: query.preset, from: query.from ?? null, to: query.to ?? null },
    },
  })
})

/** GET /api/v1/audit/facets — filter options with counts for the current filter. */
export const getAuditFilterFacets = asyncHandler(async (req, res) => {
  const query = withRange(auditFacetQuerySchema.parse(req.query))

  return sendSuccess(res, { message: 'Audit filters loaded.', data: await getAuditFacets(query) })
})

/** GET /api/v1/audit/overview — extent, retention and coverage. */
export const getAuditSummary = asyncHandler(async (_req, res) =>
  sendSuccess(res, { message: 'Audit overview loaded.', data: await getAuditOverview() }),
)

/**
 * GET /api/v1/audit/export
 *
 * Streams a file rather than returning the envelope, because the browser
 * downloads this rather than rendering it.
 *
 * CSV is generated here, on the server, unlike the analytics exports which the
 * console writes from data it already holds. The difference is that the console
 * never holds the whole audit log — it holds one page — so an export that
 * respects the filter has to be built where the query runs.
 */
export const exportAuditLogs = asyncHandler(async (req, res) => {
  const query = withRange(auditExportQuerySchema.parse(req.query))
  const { format, items, truncated, limit } = await getAuditExport(query)

  const stamp = new Date().toISOString().slice(0, 10)
  const filename = `audit-log_${stamp}.${format}`

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

    return res.send(
      JSON.stringify({ exportedAt: new Date().toISOString(), truncated, limit, items }, null, 2),
    )
  }

  const columns = [
    ['Time', (row) => row.occurredAt],
    ['User', (row) => row.actor.email],
    ['Role', (row) => row.actor.role],
    ['Category', (row) => row.categoryLabel],
    ['Action', (row) => row.actionLabel],
    ['Target type', (row) => row.target.type],
    ['Target', (row) => row.target.name ?? row.target.id],
    ['Result', (row) => row.result],
    ['Reason', (row) => row.resultReason],
    ['Affected', (row) => row.affectedCount],
    ['IP', (row) => row.ip],
    ['Device', (row) => row.device],
    ['Summary', (row) => row.summary],
  ]

  /**
   * Escaping, twice over.
   *
   * Quoting handles commas and newlines. The leading apostrophe handles the
   * other thing: Excel executes a cell beginning `=`, `+`, `-` or `@`, and this
   * file contains attacker-influenced text — a user agent, an entity name — so
   * an unescaped export is a live formula-injection vector.
   */
  const cell = (value) => {
    if (value === null || value === undefined) return ''
    let text = String(value)
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }

  const csv = [
    columns.map(([header]) => cell(header)).join(','),
    ...items.map((row) => columns.map(([, read]) => cell(read(row))).join(',')),
  ].join('\r\n')

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  // Reported in a header as well as the body, so a truncated export is visible
  // to a script that only reads headers.
  res.setHeader('X-Audit-Export-Truncated', String(truncated))

  // The BOM is what makes Excel read this as UTF-8 rather than the system
  // codepage, which otherwise mangles every non-ASCII name in the log.
  return res.send(`﻿${csv}`)
})

export default {
  describeDevice,
  exportAuditLogs,
  getAuditActivityTimeline,
  getAuditFilterFacets,
  getAuditLogDetail,
  getAuditLogs,
  getAuditSummary,
}
