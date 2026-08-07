/**
 * Audit summary, read-only.
 *
 * ## This phase does not build audit logging
 *
 * `AuditLog` already exists and already records six actions — a bulk lead
 * deletion, four scheduler decisions, and a manual reply sync. This service
 * reads those and nothing else.
 *
 * It does not add a recording call anywhere. Extending the action catalogue and
 * instrumenting the ~30 call sites that should write to it is Phase 14.7, and
 * doing it here would mean touching the lead, campaign, template, mailbox and
 * scheduler modules — every one of which this phase must leave alone.
 *
 * ## The empty case is a real answer, not an error
 *
 * A deployment where nobody has yet done anything audit-worthy has an empty
 * collection. That is not a fault and must not render as one: the response
 * carries `available: false` with a reason, so the console can say "no entries
 * yet" rather than showing a spinner forever or an error screen for a system
 * that is working correctly.
 */

import mongoose from 'mongoose'

import { AUDIT_ACTION_LABELS, AuditLog } from '../../../models/auditLog.model.js'

/** How many recent entries the summary carries. The full log is a later phase. */
const RECENT_LIMIT = 20

/**
 * Whether the collection has ever been written to.
 *
 * Distinguishes "audit logging exists but nothing has happened" from "audit
 * logging is not available", which are different sentences to show a user.
 * `estimatedDocumentCount` reads collection metadata rather than scanning.
 */
async function collectionExists() {
  try {
    const names = await mongoose.connection.db.listCollections({ name: 'auditlogs' }).toArray()
    return names.length > 0
  } catch {
    // A database that cannot be interrogated is reported as unavailable rather
    // than as empty — the two would look identical to the caller otherwise.
    return null
  }
}

/**
 * Builds the audit summary.
 *
 * @returns {Promise<object>}
 */
export async function buildAdminAuditSummary() {
  const exists = await collectionExists()

  if (exists === null) {
    return {
      available: false,
      reason: 'unavailable',
      message: 'Audit records could not be read. The database may be unreachable.',
      total: 0,
      recent: [],
      byAction: [],
    }
  }

  if (exists === false) {
    return {
      available: false,
      reason: 'not_recorded',
      message:
        'No audit records exist yet. Recording currently covers bulk lead deletion, scheduler changes and manual reply syncs; full coverage arrives in a later phase.',
      total: 0,
      recent: [],
      byAction: [],
    }
  }

  const since30d = new Date(Date.now() - 30 * 86_400_000)

  const [total, last30d, recent, byAction] = await Promise.all([
    AuditLog.countDocuments({}),
    AuditLog.countDocuments({ occurredAt: { $gte: since30d } }),
    AuditLog.find({}).sort({ occurredAt: -1 }).limit(RECENT_LIMIT).lean(),
    AuditLog.aggregate([
      { $group: { _id: '$action', count: { $sum: 1 }, lastAt: { $max: '$occurredAt' } } },
      { $sort: { count: -1 } },
    ]),
  ])

  if (total === 0) {
    return {
      available: false,
      reason: 'empty',
      message:
        'Audit recording is active, but nothing audit-worthy has happened yet. Bulk deletions, scheduler changes and manual reply syncs will appear here.',
      total: 0,
      recent: [],
      byAction: [],
    }
  }

  return {
    available: true,
    reason: null,
    message: null,
    total,
    last30d,

    recent: recent.map((entry) => ({
      id: String(entry._id),
      action: entry.action,
      actionLabel: AUDIT_ACTION_LABELS[entry.action] ?? entry.action,
      summary: entry.summary,
      affectedCount: entry.affectedCount ?? 0,
      actorEmail: entry.actorEmail ?? null,
      actorRole: entry.actorRole ?? null,
      ip: entry.ip ?? null,
      occurredAt: entry.occurredAt,
    })),

    byAction: byAction.map((row) => ({
      action: row._id,
      actionLabel: AUDIT_ACTION_LABELS[row._id] ?? row._id,
      count: row.count,
      lastAt: row.lastAt,
    })),

    /**
     * Stated in the payload so the console can show what is and is not covered.
     * A log that silently omits role changes reads as a log that says none
     * happened.
     */
    coverage: {
      recordedActions: Object.keys(AUDIT_ACTION_LABELS),
      note: 'Coverage is limited to the actions listed. Full audit instrumentation is a later phase.',
    },
  }
}

export default { buildAdminAuditSummary }
