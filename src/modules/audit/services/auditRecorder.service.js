/**
 * The one function every module calls to record an audit entry.
 *
 * ## Why this exists rather than `AuditLog.record()` at each call site
 *
 * `AuditLog.record()` is the raw append and stays available. But a call site
 * using it directly has to assemble eleven fields — actor, actor email, actor
 * role, ip, user agent, request id, method, path, session, category, severity —
 * from the request, and thirty call sites assembling them by hand is thirty
 * chances to forget one. Worse, it is thirty places that would each have to
 * remember not to log a token.
 *
 * So there is exactly one derivation, here, and call sites pass only what they
 * alone know: which event, which target, and any safe extra detail.
 *
 * ## It never throws and never blocks the response
 *
 * A failed audit write must not fail the action it describes — the campaign has
 * already started, and turning the response into an error would tell the
 * operator it had not. Every failure path returns `null` and logs a warning.
 *
 * That guarantee is what makes it safe to add a `recordAudit()` line to a
 * production controller without re-reasoning about that route's failure modes,
 * which is the whole reason this phase could instrument existing modules
 * without redesigning them.
 *
 * ## Redaction is here, not at the call sites
 *
 * `redactMetadata()` runs on the way in, so no caller can leak a token by
 * passing the wrong object — including a future caller who has not read this
 * comment. Putting the scrub at the call sites would make it optional in
 * practice.
 */

import { AUDIT_RESULT, auditEvent } from '../../../constants/auditEvents.js'
import { AuditLog } from '../../../models/auditLog.model.js'
import { createContextLogger } from '../../../utils/logger.js'
import { notifyFromAudit } from '../../notifications/services/notifier.service.js'

const log = createContextLogger('audit')

/**
 * Keys whose values are never stored, matched case-insensitively anywhere in
 * the key name.
 *
 * A denylist rather than an allowlist because `metadata` is deliberately
 * open-ended — but the denylist is checked against the *key path*, and any
 * match replaces the value with a marker rather than dropping the key, so the
 * log still shows that a field was present.
 */
const FORBIDDEN_KEY = /token|secret|password|passwd|credential|authorization|cookie|apikey|api_key|clientsecret|refresh|bearer|otp|signature/i

/** Depth and breadth caps. A log entry is not a copy of the request body. */
const MAX_DEPTH = 4
const MAX_KEYS = 40
const MAX_ARRAY = 20
const MAX_STRING = 512

/**
 * Strips anything credential-shaped and bounds the rest.
 *
 * Exported for the probe that asserts a token cannot reach the collection —
 * that assertion is only meaningful if it can call the real function.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactMetadata(value, depth = 0) {
  if (value === null || value === undefined) return null

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()

  // Anything past the depth cap is summarised rather than walked. Without this
  // a deeply nested Mongoose document would be serialised in full.
  if (depth >= MAX_DEPTH) return '[truncated]'

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redactMetadata(item, depth + 1))
    return value.length > MAX_ARRAY ? [...items, `…${value.length - MAX_ARRAY} more`] : items
  }

  if (typeof value !== 'object') return null

  // A Mongoose document reduced to its plain form first, or the walk would
  // traverse internal state rather than the data.
  const source = typeof value.toObject === 'function' ? value.toObject() : value
  const output = {}
  let count = 0

  for (const [key, item] of Object.entries(source)) {
    if (count >= MAX_KEYS) {
      output['…'] = 'additional keys omitted'
      break
    }

    // The key is kept so the entry records that a credential field was present;
    // only the value is destroyed.
    output[key] = FORBIDDEN_KEY.test(key) ? '[redacted]' : redactMetadata(item, depth + 1)
    count += 1
  }

  return output
}

/**
 * Pulls the request-shaped fields off an Express request.
 *
 * Tolerates being given nothing: background work — the scheduler, the workbook
 * worker — has no request, and those actions still deserve a record.
 */
function requestContext(req) {
  if (!req) return {}

  return {
    ip: req.ip ?? null,
    // Bounded here as well as in the schema: a hostile user agent header is a
    // cheap way to bloat a collection.
    userAgent: (req.get?.('user-agent') ?? null)?.slice(0, 512) ?? null,
    requestId: req.id ?? null,
    method: req.method ?? null,
    path: (req.originalUrl ?? req.url ?? null)?.slice(0, 512) ?? null,
    sessionId: req.auth?.session?._id ?? null,
  }
}

/**
 * Records one audit entry.
 *
 * @param {object}  input
 * @param {string}  input.event        A key from `AUDIT_EVENTS`. Never a literal.
 * @param {object}  [input.req]        The Express request, when there is one.
 * @param {object}  [input.actor]      The acting user. Defaults to `req.auth.user`.
 * @param {string}  input.summary      One line a human can read.
 * @param {object}  [input.target]     `{ id, name, type }` — what was acted on.
 * @param {object}  [input.performedFor] The user this was done to, if any.
 * @param {string}  [input.result]     Defaults to success.
 * @param {string}  [input.resultReason]
 * @param {object}  [input.metadata]   Scrubbed before storage.
 * @param {number}  [input.affectedCount]
 * @param {number}  [input.durationMs]
 * @param {object}  [input.refs]       `{ mailboxId, campaignId, leadId }`.
 * @param {object}  [input.owner]      Whose data. Defaults to the actor.
 * @returns {Promise<object|null>} The entry, or null if it could not be written.
 */
export async function recordAudit({
  event,
  req,
  actor,
  summary,
  target,
  performedFor,
  result = AUDIT_RESULT.SUCCESS,
  resultReason = null,
  metadata,
  affectedCount = 0,
  durationMs = null,
  refs = {},
  owner,
}) {
  try {
    // Throws on an unregistered key. Deliberately *inside* the try: a typo
    // should not take down the route it was added to, but it must be loud in
    // the log rather than silently writing an unfilterable entry.
    const definition = auditEvent(event)

    const who = actor ?? req?.auth?.user ?? null

    if (!who?._id) {
      // Nothing to attribute the action to. Recording it as anonymous would put
      // an entry in the log that answers "what" but not "who", which is the one
      // question the log exists for.
      log.warn(`Audit event "${event}" skipped: no actor could be resolved`)
      return null
    }

    const entry = await AuditLog.record({
      owner: owner ?? who._id,
      actor: who._id,
      actorEmail: who.email ?? null,
      actorRole: who.role ?? null,

      performedFor: performedFor?._id ?? performedFor?.id ?? null,
      performedForEmail: performedFor?.email ?? null,

      action: definition.action,
      category: definition.category,
      severity: definition.severity,
      result,
      resultReason,

      entityType: target?.type ?? definition.entityType ?? null,
      entityId: target?.id ? String(target.id) : null,
      entityName: target?.name ?? null,

      mailboxId: refs.mailboxId ?? null,
      campaignId: refs.campaignId ?? null,
      leadId: refs.leadId ?? null,

      summary,
      affectedCount,
      metadata: metadata === undefined ? null : redactMetadata(metadata),
      durationMs,

      ...requestContext(req),
      occurredAt: new Date(),
    })

    /**
     * Phase 15.1: the bell, raised from the same call.
     *
     * Here rather than at the thirty call sites, so no module has to remember
     * to do both — and so which events are worth interrupting somebody over is
     * decided in one table (`AUDIT_NOTIFICATIONS`) instead of thirty times.
     *
     * Deliberately **not awaited**. A notification is a courtesy; the audit
     * entry is the record. Making the caller wait for a fan-out across every
     * administrator would add latency to the action being audited, and a
     * failure here must not delay a response that has already succeeded.
     * `notifyFromAudit` catches everything internally, so the floating promise
     * cannot produce an unhandled rejection.
     */
    if (entry) void notifyFromAudit(entry)

    return entry
  } catch (error) {
    // The last line of defence. `AuditLog.record()` already swallows write
    // errors; this catches everything before it — an unknown event key, a
    // malformed target — so no shape of caller mistake can break a route.
    log.warn('Audit entry could not be recorded', { event, message: error.message })
    return null
  }
}

export default recordAudit
