/**
 * The notification centre's reads.
 *
 * Raising notifications is `notifier.service.js`. The two are separate for the
 * same reason audit recording and audit reading are: one is called from thirty
 * production paths and must never throw, the other is a single surface that
 * should fail loudly.
 */

import {
  NOTIFICATION_CATEGORY_VALUES,
  NOTIFICATION_DEFINITIONS,
} from '../../../models/notification.model.js'
import { groupByRecency, notificationDTO } from '../dto/notification.dto.js'
import * as repository from '../repositories/notification.repository.js'

/** Declared once so the client's poll interval is the server's decision. */
export const POLL_INTERVAL_MS = 30_000

/**
 * A page of notifications, plus everything the bell renders around it.
 *
 * The unread count is issued alongside rather than derived from the page: the
 * badge counts the whole visible set, and a page filtered to "errors" would
 * otherwise report a badge that changed when the reader picked a filter.
 */
export async function listForUser(owner, query) {
  const { page, limit, grouped, ...filters } = query

  const [result, unread, counts] = await Promise.all([
    repository.listNotifications(owner, filters, { page, limit }),
    repository.unreadCount(owner),
    repository.categoryCounts(owner),
  ])

  const items = result.items.map(notificationDTO)

  const byCategory = Object.fromEntries(
    counts.map((row) => [row._id ?? 'information', { total: row.total, unread: row.unread }]),
  )

  return {
    items,
    /** Only when asked for: the bell wants a flat list, the page wants groups. */
    groups: grouped ? groupByRecency(items) : null,

    unreadCount: unread,

    /**
     * Every category is offered even at zero, so a reader can select one and
     * learn that nothing happened. An absent option reads as an absent feature.
     */
    categories: NOTIFICATION_CATEGORY_VALUES.map((value) => ({
      value,
      total: byCategory[value]?.total ?? 0,
      unread: byCategory[value]?.unread ?? 0,
    })),

    types: Object.entries(NOTIFICATION_DEFINITIONS).map(([value, definition]) => ({
      value,
      label: definition.label,
      category: definition.category,
    })),

    pagination: {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    },

    meta: {
      source: 'live',
      /**
       * How this data reached the client, and how stale it may be.
       *
       * Reported rather than assumed so the polling interval is decided in one
       * place. A WebSocket transport would report itself here instead, and the
       * client would stop polling without a client-side change — which is what
       * "future-ready" means in practice rather than as an intention.
       */
      transport: 'poll',
      pollIntervalMs: POLL_INTERVAL_MS,
      generatedAt: new Date().toISOString(),
    },
  }
}

/** The badge on its own — the only thing the 30-second poll needs. */
export async function unreadForUser(owner) {
  return {
    unreadCount: await repository.unreadCount(owner),
    meta: { transport: 'poll', pollIntervalMs: POLL_INTERVAL_MS },
  }
}

export async function markRead(owner, id) {
  const updated = await repository.markRead(owner, id)

  return {
    // Null when it was already read, dismissed, or is not this person's — the
    // controller turns that into a 404 rather than pretending something changed.
    notification: updated ? notificationDTO(updated.toObject()) : null,
    unreadCount: await repository.unreadCount(owner),
  }
}

export async function markAllRead(owner) {
  const result = await repository.markAllRead(owner)
  return { marked: result.modifiedCount ?? 0, unreadCount: 0 }
}

export async function dismiss(owner, id) {
  const updated = await repository.softDelete(owner, id)

  return {
    dismissed: Boolean(updated),
    id,
    unreadCount: await repository.unreadCount(owner),
  }
}

export default { dismiss, listForUser, markAllRead, markRead, unreadForUser }
