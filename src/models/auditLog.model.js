/**
 * A record of a privileged, destructive or otherwise consequential action.
 *
 * Separate from `ConversationActivity`, which is the *business* timeline a
 * salesperson reads. This is the operational one: who did what, when, from
 * where, and whether it worked. The two answer different questions and mixing
 * them would bury a role change among a thousand "reply received" entries.
 *
 * Append-only by convention — nothing in the codebase updates or deletes an
 * entry, and a reset script that cleared them would defeat the point of having
 * them. The one exception is retention, which drops whole documents older than
 * the configured window and never edits one.
 *
 * ## Phase 14.7 extended this schema; it did not replace it
 *
 * The collection already carried six actions before this phase. Every new field
 * below is additive with a default chosen so a document written earlier reads
 * back unchanged: `category` and `result` are derived on read when absent,
 * `metadata` defaults to null, and the entity references default to null. The
 * pre-existing action strings (`leads.bulk_delete`, the four `scheduler.*`,
 * `reply_sync.run_now`) are declared in the registry with exactly their old
 * values, so nothing already written became unfilterable.
 *
 * `action` is deliberately **not** a schema enum any more. It was one, and an
 * enum here means adding an event to the registry is a schema migration — and,
 * worse, that a `record()` call for an event somebody forgot to add fails
 * validation and silently writes nothing. The registry is the gate now, and it
 * refuses at the call site where the mistake is visible.
 *
 * ## What is never stored
 *
 * No access token, refresh token, client secret, password or cookie. `metadata`
 * is scrubbed by `redactMetadata()` in the audit service before it reaches this
 * model — the scrub is upstream so that no call site can bypass it by writing
 * to the collection directly.
 */

import mongoose from 'mongoose'

import { config } from '../config/index.js'
import {
  AUDIT_ACTION_INDEX,
  AUDIT_ACTION_LABELS,
  AUDIT_CATEGORY,
  AUDIT_CATEGORY_VALUES,
  AUDIT_ENTITY_VALUES,
  AUDIT_RESULT,
  AUDIT_RESULT_VALUES,
  AUDIT_SEVERITY,
  AUDIT_SEVERITY_VALUES,
} from '../constants/auditEvents.js'

const { Schema } = mongoose

/**
 * Re-exported so the four call sites that predate Phase 14.7 keep resolving
 * their imports from here. They are the registry's values, not a second copy.
 */
export { AUDIT_ACTION_LABELS }
export const AUDIT_ACTION = Object.freeze(
  Object.fromEntries(
    Object.entries(AUDIT_ACTION_INDEX).map(([action]) => [
      action.toUpperCase().replaceAll('.', '_'),
      action,
    ]),
  ),
)

const auditLogSchema = new Schema(
  {
    /**
     * Whose data was affected.
     *
     * Retained from the original schema. Not a tenant — there is no
     * `Organization` in this product — but the closest thing to one, and the
     * field the per-workspace log view has always sorted on.
     */
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * Who performed it.
     *
     * Held separately from `owner` so an admin acting on somebody else's data
     * is recorded as themselves rather than as the data's owner. This is the
     * "WHO" the whole log exists to answer, and it is never derived.
     */
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * The actor's email and role **at the time of the action**.
     *
     * Denormalised on purpose. A join would report today's role, so a log of
     * "manager suspended an account" would silently become "viewer suspended an
     * account" the moment that person was demoted — rewriting history through a
     * join is exactly the failure an audit log must not have.
     */
    actorEmail: { type: String, trim: true, default: null },
    actorRole: { type: String, trim: true, default: null },

    /** Who it was done *to*, when that is a person. Null otherwise. */
    performedFor: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    performedForEmail: { type: String, trim: true, default: null },

    /**
     * The stored action, e.g. `user.invited`. Validated against the registry by
     * the service, not by a schema enum — see the note at the top of this file.
     */
    action: { type: String, required: true, index: true, trim: true },

    /** Registry category. Denormalised so a category filter needs no lookup. */
    category: {
      type: String,
      enum: AUDIT_CATEGORY_VALUES,
      default: AUDIT_CATEGORY.SYSTEM,
      index: true,
    },

    severity: {
      type: String,
      enum: AUDIT_SEVERITY_VALUES,
      default: AUDIT_SEVERITY.NOTICE,
      index: true,
    },

    /** Whether it worked. A log that only records successes is not an audit. */
    result: {
      type: String,
      enum: AUDIT_RESULT_VALUES,
      default: AUDIT_RESULT.SUCCESS,
      index: true,
    },

    /** Why, when `result` is not success. Never a stack trace. */
    resultReason: { type: String, trim: true, default: null, maxlength: 512 },

    // --- The target ---------------------------------------------------------

    /** What kind of thing was acted on. */
    entityType: { type: String, enum: [...AUDIT_ENTITY_VALUES, null], default: null, index: true },

    /**
     * Which one. Deliberately a string, not an ObjectId: some targets are not
     * documents (`scheduler`, `system`) and a typed ref would reject them.
     */
    entityId: { type: String, trim: true, default: null, index: true },

    /**
     * A human name for the target, captured at the time.
     *
     * Denormalised for the same reason as `actorRole`, plus one more: the
     * target of a deletion no longer exists, so a join would render the most
     * important rows in the log as blanks.
     */
    entityName: { type: String, trim: true, default: null, maxlength: 256 },

    /**
     * Cross-references, for "show me everything that touched this mailbox".
     *
     * Denormalised alongside `entityId` rather than replacing it: a campaign
     * event has an `entityId` *and* a `mailboxId`, and collapsing the two would
     * lose one of them.
     */
    mailboxId: { type: Schema.Types.ObjectId, ref: 'Mailbox', default: null, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },

    // --- The request --------------------------------------------------------

    /** One line for a human reading the log. Always present. */
    summary: { type: String, required: true, trim: true, maxlength: 512 },

    /** How many documents the action removed or changed. */
    affectedCount: { type: Number, default: 0, min: 0 },

    /**
     * Safe, scrubbed detail. Bounded because a log entry that carries a whole
     * request body stops being a log and becomes a second copy of the database.
     */
    metadata: { type: Schema.Types.Mixed, default: null },

    /** Retained from the original schema; the four pre-14.7 call sites write it. */
    detail: { type: Schema.Types.Mixed, default: null },

    durationMs: { type: Number, default: null },

    /** Where it came from. */
    ip: { type: String, trim: true, default: null },
    userAgent: { type: String, trim: true, default: null, maxlength: 512 },
    requestId: { type: String, trim: true, default: null },
    method: { type: String, trim: true, default: null, maxlength: 10 },
    path: { type: String, trim: true, default: null, maxlength: 512 },

    /**
     * The session, so "everything done in one sitting" is answerable.
     *
     * The session's id, never its token. A token here would turn the audit log
     * into a credential store — the one thing it must never be.
     */
    sessionId: { type: Schema.Types.ObjectId, ref: 'Session', default: null, index: true },

    /**
     * When it happened.
     *
     * Deliberately **without** `index: true`. The indexes on this field are
     * declared explicitly below, and a field-level `index: true` creates
     * `occurredAt_1` — the same key pattern as the retention TTL index, which
     * MongoDB then refuses to create, silently. The result is a deployment that
     * believes it has retention and does not. Declared in one place only.
     */
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false },
)

// --- Indexes ----------------------------------------------------------------
//
// Each one exists for a query the console actually issues. Compounds are
// ordered equality-then-sort, so the sort is served by the index rather than
// by an in-memory sort that fails past 32 MB on a large collection.

/** The default log view: newest first. */
auditLogSchema.index({ occurredAt: -1 })

/** Per-workspace view, retained from the original schema. */
auditLogSchema.index({ owner: 1, occurredAt: -1 })

/** "What has this person done" — the User 360 activity section. */
auditLogSchema.index({ actor: 1, occurredAt: -1 })

/** "What was done to this person." */
auditLogSchema.index({ performedFor: 1, occurredAt: -1 })

/** The console's two headline filters. */
auditLogSchema.index({ category: 1, occurredAt: -1 })
auditLogSchema.index({ action: 1, occurredAt: -1 })

/** "Everything that touched this record" — the entity drill-down. */
auditLogSchema.index({ entityType: 1, entityId: 1, occurredAt: -1 })

/** The per-page recent-event strips. */
auditLogSchema.index({ mailboxId: 1, occurredAt: -1 })
auditLogSchema.index({ campaignId: 1, occurredAt: -1 })
auditLogSchema.index({ leadId: 1, occurredAt: -1 })

/** "Show me only what failed." */
auditLogSchema.index({ result: 1, occurredAt: -1 })

/**
 * Retention, as a TTL index.
 *
 * MongoDB's background TTL monitor does the deleting, so expiry keeps working
 * whether or not this process is running and there is no sweep job to schedule,
 * monitor or accidentally run twice. It deletes whole documents and never edits
 * one, which preserves the append-only guarantee.
 *
 * `expireAfterSeconds: 0` on a date field would expire everything immediately,
 * so retention-disabled is expressed by **not creating the index at all**
 * rather than by a zero. A deployment that later turns retention off must drop
 * `audit_retention_ttl` by hand — noted here because a stale TTL index quietly
 * deleting records under a legal hold is the worst failure this file can have.
 */
if (config.audit.retentionEnabled) {
  auditLogSchema.index(
    { occurredAt: 1 },
    { name: 'audit_retention_ttl', expireAfterSeconds: config.audit.retentionDays * 86_400 },
  )
}

/**
 * Upgrading a deployment that ran before this index existed
 *
 * A collection created by the pre-14.7 schema already has a plain `occurredAt_1`
 * index. MongoDB will not create a second index with the same key pattern, so
 * the TTL above is **silently ignored** until the old one is dropped —
 * retention appears configured and does nothing. Run
 * `node scripts/audit-retention-index.js` once to fix it; the script reports
 * whether it had anything to do.
 */

/**
 * Free-text search over the three fields a person would actually search.
 *
 * A text index rather than a regex scan: `summary` is unbounded free text and a
 * `$regex` over a million rows is a collection scan on every keystroke.
 */
auditLogSchema.index(
  { summary: 'text', entityName: 'text', actorEmail: 'text' },
  { name: 'audit_search', weights: { summary: 3, entityName: 2, actorEmail: 1 } },
)

/**
 * Derives the display shape.
 *
 * `category`, `severity` and `result` fall back to the registry when a document
 * predates them, so an entry written before Phase 14.7 renders with the same
 * labels as one written after it.
 */
auditLogSchema.methods.toPublicJSON = function toPublicJSON() {
  const definition = AUDIT_ACTION_INDEX[this.action] ?? null

  return {
    id: this._id.toString(),
    action: this.action,
    actionLabel: AUDIT_ACTION_LABELS[this.action] ?? this.action,
    category: this.category ?? definition?.category ?? AUDIT_CATEGORY.SYSTEM,
    severity: this.severity ?? definition?.severity ?? AUDIT_SEVERITY.NOTICE,
    result: this.result ?? AUDIT_RESULT.SUCCESS,
    resultReason: this.resultReason ?? null,
    summary: this.summary,
    affectedCount: this.affectedCount ?? 0,
    metadata: this.metadata ?? this.detail ?? null,
    durationMs: this.durationMs ?? null,
    actor: this.actor?.toString() ?? null,
    actorEmail: this.actorEmail,
    actorRole: this.actorRole,
    performedFor: this.performedFor?.toString() ?? null,
    performedForEmail: this.performedForEmail ?? null,
    entityType: this.entityType ?? null,
    entityId: this.entityId ?? null,
    entityName: this.entityName ?? null,
    mailboxId: this.mailboxId?.toString() ?? null,
    campaignId: this.campaignId?.toString() ?? null,
    leadId: this.leadId?.toString() ?? null,
    ip: this.ip,
    userAgent: this.userAgent ?? null,
    requestId: this.requestId,
    method: this.method ?? null,
    path: this.path ?? null,
    sessionId: this.sessionId?.toString() ?? null,
    occurredAt: this.occurredAt,
  }
}

/**
 * Appends an entry.
 *
 * **Never throws.** An audit write that failed the operation it was describing
 * would be worse than the missing record — the deletion has already happened,
 * and turning the response into an error would tell the user it had not. This
 * guarantee is what makes it safe to add a `recordAudit()` call to a controller
 * without re-reasoning about that route's failure modes.
 *
 * Prefer `recordAudit()` in the audit service over calling this directly: it
 * resolves the event from the registry, derives the request fields and scrubs
 * the metadata. This stays public for the four call sites that predate it and
 * for the service itself.
 */
auditLogSchema.statics.record = async function record(entry) {
  try {
    return await this.create(entry)
  } catch {
    return null
  }
}

export const AuditLog = mongoose.model('AuditLog', auditLogSchema)

export default AuditLog
