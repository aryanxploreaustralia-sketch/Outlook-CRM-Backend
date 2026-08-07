/**
 * Audit entries, shaped for the console.
 *
 * The model has a `toPublicJSON`, but reads go through `.lean()` — a hydrated
 * Mongoose document per row is the difference between a page of 100 rows costing
 * one allocation each and costing eleven. So the same derivation lives here, in
 * plain-object form, and the two are kept in step by both reading the registry
 * rather than either restating the labels.
 *
 * ## Derived on read, not stored twice
 *
 * `categoryLabel`, `actionLabel` and `severity` come from the registry at
 * serialisation time. Entries written before Phase 14.7 have no `category`
 * column at all, and this is what makes them render identically to new ones
 * instead of appearing as a block of blanks at the bottom of the log.
 */

import {
  AUDIT_ACTION_INDEX,
  AUDIT_CATEGORY,
  AUDIT_CATEGORY_LABELS,
  AUDIT_RESULT,
  AUDIT_SEVERITY,
} from '../../../constants/auditEvents.js'

/**
 * A very small user-agent reading.
 *
 * Deliberately not a parser library: the log needs "Chrome on Windows" to make
 * a table column legible, and a full UA database is 500 KB to render a string
 * nobody sorts by. Anything unrecognised is reported honestly as "Unknown
 * device" rather than guessed.
 */
export function describeDevice(userAgent) {
  if (!userAgent) return null

  const ua = String(userAgent)

  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) && !/Chrome/.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /node|axios|curl|PostmanRuntime/i.test(ua) ? 'API client'
    : null

  const platform =
    /Windows NT/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : null

  if (!browser && !platform) return 'Unknown device'
  if (browser && platform) return `${browser} on ${platform}`

  return browser ?? platform
}

/**
 * One row.
 *
 * @param {object} entry A lean document.
 */
export function auditEntryDTO(entry) {
  if (!entry) return null

  const definition = AUDIT_ACTION_INDEX[entry.action] ?? null
  const category = entry.category ?? definition?.category ?? AUDIT_CATEGORY.SYSTEM

  return {
    id: String(entry._id),

    // --- When ---
    occurredAt: entry.occurredAt ?? entry.createdAt ?? null,

    // --- Who ---
    actor: {
      id: entry.actor ? String(entry.actor) : null,
      email: entry.actorEmail ?? null,
      /** The role held **at the time**, not today's. See the model's note. */
      role: entry.actorRole ?? null,
    },

    // --- What ---
    action: entry.action,
    actionLabel: definition?.label ?? entry.action,
    category,
    categoryLabel: AUDIT_CATEGORY_LABELS[category] ?? category,
    severity: entry.severity ?? definition?.severity ?? AUDIT_SEVERITY.NOTICE,
    summary: entry.summary,

    // --- Target ---
    target: {
      type: entry.entityType ?? null,
      id: entry.entityId ?? null,
      name: entry.entityName ?? null,
    },

    performedFor: entry.performedFor
      ? { id: String(entry.performedFor), email: entry.performedForEmail ?? null }
      : null,

    /** Cross-references, so the console can offer "show related". */
    refs: {
      mailboxId: entry.mailboxId ? String(entry.mailboxId) : null,
      campaignId: entry.campaignId ? String(entry.campaignId) : null,
      leadId: entry.leadId ? String(entry.leadId) : null,
    },

    // --- Result ---
    result: entry.result ?? AUDIT_RESULT.SUCCESS,
    resultReason: entry.resultReason ?? null,
    affectedCount: entry.affectedCount ?? 0,
    durationMs: entry.durationMs ?? null,

    // --- Where ---
    ip: entry.ip ?? null,
    device: describeDevice(entry.userAgent),
    /** Kept in full for the detail view; the table shows `device`. */
    userAgent: entry.userAgent ?? null,
  }
}

/**
 * The detail view: everything the row has, plus the request context.
 *
 * `metadata` falls back to the legacy `detail` column so an entry written
 * before Phase 14.7 still opens with its payload visible.
 */
export function auditDetailDTO(entry) {
  if (!entry) return null

  return {
    ...auditEntryDTO(entry),

    request: {
      method: entry.method ?? null,
      path: entry.path ?? null,
      requestId: entry.requestId ?? null,
      sessionId: entry.sessionId ? String(entry.sessionId) : null,
    },

    metadata: entry.metadata ?? entry.detail ?? null,

    /**
     * Whether this entry predates the extended schema. Surfaced so the console
     * can say "recorded before extended fields were captured" instead of
     * rendering a screen of empty rows that reads like data loss.
     */
    isLegacyEntry: !entry.category,
  }
}

export default { auditDetailDTO, auditEntryDTO, describeDevice }
