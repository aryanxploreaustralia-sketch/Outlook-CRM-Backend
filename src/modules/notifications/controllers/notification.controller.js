/**
 * Notification centre controllers.
 *
 * Every handler is scoped to `req.auth.user._id`, and no parameter can widen
 * that. The access model is ownership, enforced inside the query rather than by
 * a guard somebody could omit — see the repository.
 */

import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { ApiError } from '../../../utils/ApiError.js'
import * as service from '../services/notification.service.js'
import {
  notificationIdSchema,
  notificationListSchema,
} from '../validators/notification.validator.js'

/**
 * GET /api/v1/notifications
 *
 * Backward compatible with the endpoint the conversations module served before
 * Phase 15.1: the response still carries `items` and `unreadCount` at the same
 * paths, so the existing bell keeps working untouched. Everything else is
 * additive.
 */
export const list = asyncHandler(async (req, res) => {
  const query = notificationListSchema.parse(req.query)

  return sendSuccess(res, {
    message: 'Notifications loaded.',
    data: await service.listForUser(req.auth.user._id, query),
  })
})

/** GET /api/v1/notifications/unread — just the badge, for the poll. */
export const unread = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Unread count loaded.',
    data: await service.unreadForUser(req.auth.user._id),
  }),
)

/** POST /api/v1/notifications/:id/read */
export const markRead = asyncHandler(async (req, res) => {
  const id = notificationIdSchema.parse(req.params.id)
  const result = await service.markRead(req.auth.user._id, id)

  /**
   * Null means already read, dismissed, or not theirs.
   *
   * 404 rather than 403 for the last case, deliberately: within this person's
   * scope the row genuinely does not exist, and a 403 would confirm that
   * somebody else's does.
   */
  if (!result.notification) throw ApiError.notFound('That notification could not be found.')

  return sendSuccess(res, { message: 'Marked as read.', data: result })
})

/** POST /api/v1/notifications/read-all */
export const markAllRead = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'All notifications marked as read.',
    data: await service.markAllRead(req.auth.user._id),
  }),
)

/** DELETE /api/v1/notifications/:id — dismisses it. Soft, see the repository. */
export const dismiss = asyncHandler(async (req, res) => {
  const id = notificationIdSchema.parse(req.params.id)
  const result = await service.dismiss(req.auth.user._id, id)

  if (!result.dismissed) throw ApiError.notFound('That notification could not be found.')

  return sendSuccess(res, { message: 'Notification dismissed.', data: result })
})

export default { dismiss, list, markAllRead, markRead, unread }
