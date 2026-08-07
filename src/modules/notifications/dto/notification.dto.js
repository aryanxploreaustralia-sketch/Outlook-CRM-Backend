/**
 * Notifications, shaped for the bell.
 *
 * Reads go through `.lean()`, so the model's `toPublicJSON` is unavailable and
 * the same derivation lives here. The two are kept in step by both reading
 * `NOTIFICATION_DEFINITIONS` rather than either restating the labels.
 *
 * `category` falls back to the type's definition when the stored value is
 * absent — the forty-six documents written before Phase 15.1 have no category
 * column, and this is what makes them render identically to new ones instead of
 * appearing as an uncategorised block.
 */

import { NOTIFICATION_DEFINITIONS, categoryForType } from '../../../models/notification.model.js'

/** One row. */
export function notificationDTO(entry) {
  if (!entry) return null

  const definition = NOTIFICATION_DEFINITIONS[entry.type] ?? null

  return {
    id: String(entry._id),
    type: entry.type,
    typeLabel: definition?.label ?? entry.type,
    category: entry.category ?? categoryForType(entry.type),

    title: entry.title,
    body: entry.body ?? null,

    /**
     * Client-relative, always. The model refuses to store anything else, so a
     * notification can never navigate a reader off this application.
     */
    link: entry.link ?? null,

    target: { type: entry.entityType ?? null, id: entry.entityId ?? null },
    actorEmail: entry.actorEmail ?? null,

    /** Retained for the conversation notifications that predate this module. */
    lead: entry.lead ? String(entry.lead) : null,
    leadReference: entry.leadReference ?? null,
    senderEmail: entry.senderEmail ?? null,
    subject: entry.subject ?? null,

    isRead: Boolean(entry.isRead),
    readAt: entry.readAt ?? null,
    occurredAt: entry.occurredAt ?? entry.createdAt ?? null,
  }
}

/**
 * Groups a page the way a person reads it: Today, Yesterday, Last week, Earlier.
 *
 * Grouped on the **server** so "today" means the server's day — the same day
 * the timestamps were written in. Grouping in the browser would file an item
 * written at 23:30 UTC under a different heading for a reader in Sydney than
 * for one in London, from identical data.
 */
export function groupByRecency(items) {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)

  const startOfLastWeek = new Date(startOfToday)
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7)

  const buckets = { today: [], yesterday: [], lastWeek: [], earlier: [] }

  for (const item of items) {
    const at = new Date(item.occurredAt)

    const key =
      at >= startOfToday ? 'today'
      : at >= startOfYesterday ? 'yesterday'
      : at >= startOfLastWeek ? 'lastWeek'
      : 'earlier'

    buckets[key].push(item)
  }

  // An array, so display order is preserved; empty groups are dropped so the
  // bell never renders a heading above nothing.
  return [
    { key: 'today', label: 'Today', items: buckets.today },
    { key: 'yesterday', label: 'Yesterday', items: buckets.yesterday },
    { key: 'lastWeek', label: 'Last week', items: buckets.lastWeek },
    { key: 'earlier', label: 'Earlier', items: buckets.earlier },
  ].filter((group) => group.items.length > 0)
}

export default { groupByRecency, notificationDTO }
