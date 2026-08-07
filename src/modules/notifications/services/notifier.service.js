/**
 * The one function every module calls to raise a notification.
 *
 * Deliberately shaped like `recordAudit()` and for the same reasons: one
 * derivation instead of thirty, and a guarantee that it can never break the
 * operation it is describing.
 *
 * ## Audit and notification are not the same thing
 *
 * It is tempting to render the bell from the audit log — both record events,
 * both have actors and timestamps. They answer different questions and mixing
 * them produces something bad at both jobs:
 *
 *   - **Audit** is a permanent, complete, append-only record of what was done.
 *     Nobody dismisses an audit entry, and it must never be filtered by who
 *     finds it interesting.
 *   - **Notification** is a *dismissible item of work addressed to a person*.
 *     Most audit entries should notify nobody — an operator does not want a
 *     bell for every enquiry anybody edits.
 *
 * So the two are written side by side, and `notifyFromAudit()` below encodes
 * which audit events are worth somebody's attention. That mapping is the whole
 * point: without it the bell becomes a firehose and people stop reading it.
 *
 * ## Fan-out is explicit
 *
 * A notification belongs to a person, so raising one for "the administrators"
 * means writing a row each. Done here rather than at call sites so the
 * recipient rules live in one place — and so a caller cannot accidentally
 * notify the whole deployment.
 *
 * ## Never throws
 *
 * A failed bell must not fail the campaign that started. Every path returns a
 * count and logs; nothing propagates.
 */

import {
  NOTIFICATION_TYPE,
  Notification,
  categoryForType,
} from '../../../models/notification.model.js'
import { User } from '../../../models/user.model.js'
import { PERMISSIONS } from '../../../constants/permissions.js'
import { permissionsForRole } from '../../../constants/roleMatrix.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('notifier')

/**
 * Everyone who should hear about organization-level events.
 *
 * Resolved from the permission matrix rather than a role list: whoever may read
 * the audit log is, by definition, whoever is responsible for what it records.
 * Adding a role to that permission carries its notifications with it.
 */
export async function organizationAudience() {
  const candidates = await User.find({ isActive: true, isDeleted: { $ne: true } })
    .select('_id role')
    .lean()

  return candidates
    .filter((user) => permissionsForRole(user.role).has(PERMISSIONS.AUDIT_VIEW))
    .map((user) => user._id)
}

/**
 * Writes one notification per recipient.
 *
 * @param {object}   input
 * @param {string}   input.type         A `NOTIFICATION_TYPE` value.
 * @param {Array}    input.recipients   User ids. Empty is a silent no-op.
 * @param {string}   input.title
 * @param {?string}  [input.body]
 * @param {?string}  [input.link]       Client-relative path.
 * @param {string}   input.dedupeKey    Unique per recipient. See the model.
 * @param {object}   [input.target]     `{ type, id }`
 * @param {?string}  [input.actorEmail]
 * @param {object}   [input.refs]       `{ lead, company, contact, conversation }`
 * @param {?Date}    [input.occurredAt]
 * @returns {Promise<number>} How many were written.
 */
export async function notify({
  type,
  recipients = [],
  title,
  body = null,
  link = null,
  dedupeKey,
  target = {},
  actorEmail = null,
  refs = {},
  occurredAt = null,
}) {
  if (recipients.length === 0) return 0

  try {
    const category = categoryForType(type)
    const at = occurredAt ?? new Date()

    const documents = recipients.map((owner) => ({
      owner,
      type,
      category,
      title,
      body,
      link,
      // Scoped per recipient so a fan-out of five writes five rows rather than
      // colliding on one key and silently delivering to only the first.
      dedupeKey,
      entityType: target.type ?? null,
      entityId: target.id ? String(target.id) : null,
      actorEmail,
      lead: refs.lead ?? null,
      company: refs.company ?? null,
      contact: refs.contact ?? null,
      conversation: refs.conversation ?? null,
      occurredAt: at,
    }))

    /**
     * `ordered: false` so one duplicate does not abandon the rest of the batch.
     *
     * A duplicate is the *expected* outcome of re-delivery — the unique index on
     * `(owner, dedupeKey)` is what makes this idempotent — so the write is
     * allowed to partially succeed and the duplicates are counted, not raised.
     */
    const result = await Notification.insertMany(documents, { ordered: false, rawResult: true })

    return result?.insertedCount ?? documents.length
  } catch (error) {
    // A bulk write that hit only duplicates reports as an error; that is
    // success as far as this function is concerned.
    if (error?.code === 11_000 || error?.writeErrors?.every((e) => e.err?.code === 11_000)) {
      return error?.result?.nInserted ?? 0
    }

    log.warn('Notification could not be raised', { type, message: error.message })
    return 0
  }
}

/**
 * Which audit events deserve a bell, and who hears them.
 *
 * ## The mapping is the feature
 *
 * Every audit event is recorded; only these interrupt somebody. An event absent
 * from this table is a deliberate decision that nobody needs to be told in real
 * time — they can still find it in the audit log, which is complete.
 *
 * `audience: 'organization'` means everyone who can read the audit log.
 * `audience: 'subject'` means the person it was done *to* — a role change is
 * their business first.
 *
 * @type {Readonly<Record<string, { type: string, audience: string }>>}
 */
export const AUDIT_NOTIFICATIONS = Object.freeze({
  'user.invited': { type: NOTIFICATION_TYPE.USER_INVITED, audience: 'organization' },
  'role.changed': { type: NOTIFICATION_TYPE.ROLE_CHANGED, audience: 'both' },
  /**
   * Organization audience only, deliberately.
   *
   * A deleted account cannot sign in, so a notification addressed to its owner
   * would be written to a bell nobody can open. The people who need to know are
   * the administrators.
   */
  'user.deleted': { type: NOTIFICATION_TYPE.USER_DELETED, audience: 'organization' },
  'user.restored': { type: NOTIFICATION_TYPE.USER_RESTORED, audience: 'both' },
  'mailbox.connected': { type: NOTIFICATION_TYPE.MAILBOX_CONNECTED, audience: 'organization' },
  'mailbox.microsoft_connected': { type: NOTIFICATION_TYPE.MAILBOX_CONNECTED, audience: 'organization' },
  'mailbox.disconnected': { type: NOTIFICATION_TYPE.MAILBOX_DISCONNECTED, audience: 'organization' },
  'mailbox.assigned': { type: NOTIFICATION_TYPE.MAILBOX_ASSIGNED, audience: 'both' },
  'campaign.started': { type: NOTIFICATION_TYPE.CAMPAIGN_STARTED, audience: 'organization' },
  'campaign.completed': { type: NOTIFICATION_TYPE.CAMPAIGN_COMPLETED, audience: 'organization' },
  'lead.imported': { type: NOTIFICATION_TYPE.LEAD_IMPORTED, audience: 'actor' },
  'workbook.imported': { type: NOTIFICATION_TYPE.WORKBOOK_UPLOADED, audience: 'actor' },
  'workbook.send_completed': { type: NOTIFICATION_TYPE.WORKBOOK_SYNC_FINISHED, audience: 'actor' },
  'template.activated': { type: NOTIFICATION_TYPE.TEMPLATE_UPDATED, audience: 'organization' },
  'organization.updated': { type: NOTIFICATION_TYPE.ORGANIZATION_UPDATED, audience: 'organization' },
  'system.error': { type: NOTIFICATION_TYPE.SYSTEM_WARNING, audience: 'organization' },
})

/**
 * Where a notification of a given type should send the reader.
 *
 * Client-relative paths, resolved here so the mapping lives beside the types
 * rather than in a switch inside a React component.
 */
export function linkFor(type, target = {}) {
  const id = target.id ? String(target.id) : null

  switch (type) {
    case NOTIFICATION_TYPE.USER_INVITED:
    case NOTIFICATION_TYPE.ROLE_CHANGED:
    case NOTIFICATION_TYPE.USER_DELETED:
    case NOTIFICATION_TYPE.USER_RESTORED:
      return id ? `/admin/users/${id}` : '/admin/users'
    case NOTIFICATION_TYPE.MAILBOX_CONNECTED:
    case NOTIFICATION_TYPE.MAILBOX_DISCONNECTED:
    case NOTIFICATION_TYPE.MAILBOX_ASSIGNED:
      return '/admin/mailboxes'
    case NOTIFICATION_TYPE.CAMPAIGN_STARTED:
    case NOTIFICATION_TYPE.CAMPAIGN_COMPLETED:
    case NOTIFICATION_TYPE.CAMPAIGN_FAILED:
      return '/admin/campaigns'
    case NOTIFICATION_TYPE.LEAD_ASSIGNED:
      return id ? `/leads/${id}` : '/leads'
    case NOTIFICATION_TYPE.LEAD_IMPORTED:
    case NOTIFICATION_TYPE.WORKBOOK_UPLOADED:
    case NOTIFICATION_TYPE.WORKBOOK_SYNC_FINISHED:
      return '/leads'
    case NOTIFICATION_TYPE.TEMPLATE_UPDATED:
      return '/templates'
    case NOTIFICATION_TYPE.ORGANIZATION_UPDATED:
      return '/admin/organization'
    case NOTIFICATION_TYPE.PERMISSION_DENIED:
    case NOTIFICATION_TYPE.SYSTEM_WARNING:
      return '/admin/audit'
    case NOTIFICATION_TYPE.ANALYTICS_READY:
      return '/admin/analytics'

    /*
     * Phase 18. Both land on the CRM's own pages rather than the console: the
     * recipient of a task notification is the person doing the work, and they
     * may not hold admin access at all.
     */
    case NOTIFICATION_TYPE.TASK_ASSIGNED:
    case NOTIFICATION_TYPE.TASK_UPDATED:
    case NOTIFICATION_TYPE.TASK_COMPLETED:
    case NOTIFICATION_TYPE.TASK_OVERDUE:
    case NOTIFICATION_TYPE.TASK_COMMENTED:
      return id ? `/tasks?task=${id}` : '/tasks'
    case NOTIFICATION_TYPE.GOAL_ASSIGNED:
    case NOTIFICATION_TYPE.GOAL_ACHIEVED:
      return '/tasks?view=goals'
    default:
      return null
  }
}

/**
 * Raises the notification an audit entry deserves, if any.
 *
 * Called by `recordAudit()` immediately after a successful write, so no module
 * has to remember to do both. An event with no mapping produces nothing, which
 * is the common case and is meant to be.
 *
 * @param {object} entry The stored audit document.
 * @returns {Promise<number>}
 */
export async function notifyFromAudit(entry) {
  try {
    const mapping = AUDIT_NOTIFICATIONS[entry?.action]
    if (!mapping) return 0

    const actor = entry.actor ? String(entry.actor) : null
    const subject = entry.performedFor ? String(entry.performedFor) : null

    let recipients = []

    if (mapping.audience === 'actor') {
      recipients = actor ? [actor] : []
    } else if (mapping.audience === 'subject') {
      recipients = subject ? [subject] : []
    } else {
      const organization = (await organizationAudience()).map(String)

      recipients = mapping.audience === 'both' && subject
        ? [...new Set([...organization, subject])]
        : organization

      /**
       * The actor does not need telling what they just did.
       *
       * Excluded only for organization fan-out — an `actor` audience is
       * deliberately about telling somebody their own long-running job
       * finished, which they do want.
       */
      if (actor) recipients = recipients.filter((id) => id !== actor)
    }

    if (recipients.length === 0) return 0

    return await notify({
      type: mapping.type,
      recipients,
      title: entry.summary,
      body: entry.actorEmail ? `by ${entry.actorEmail}` : null,
      link: linkFor(mapping.type, { id: entry.entityId }),
      // The audit entry's own id: one entry can raise at most one notification
      // per recipient, however many times delivery is retried.
      dedupeKey: `audit:${entry._id}`,
      target: { type: entry.entityType, id: entry.entityId },
      actorEmail: entry.actorEmail ?? null,
      occurredAt: entry.occurredAt,
    })
  } catch (error) {
    log.warn('Audit-driven notification failed', { message: error.message })
    return 0
  }
}

export default { notify, notifyFromAudit, organizationAudience }
