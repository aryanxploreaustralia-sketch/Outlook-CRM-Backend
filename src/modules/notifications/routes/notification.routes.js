/**
 * Notification centre routes.
 *
 * Mounted at `${API_PREFIX}/v1/notifications`, replacing the three routes the
 * conversations module served. The replacement is compatible: `GET /`,
 * `POST /:id/read` and `POST /read-all` keep their paths and their response
 * shapes, so the existing bell needs no change to keep working.
 *
 * ## Authentication only, no permission
 *
 * A notification belongs to one person and every query is scoped to them, so
 * there is nothing here a signed-in user is not entitled to see — their own.
 * Requiring a permission would mean an account could exist that cannot read its
 * own bell, which is not a state anybody wants to administer.
 */

import { Router } from 'express'

import { requireAuth } from '../../../middlewares/authenticate.js'
import * as controller from '../controllers/notification.controller.js'

const router = Router()

router.use(requireAuth)

/** Literal paths first, so neither can be swallowed by the `:id` parameter. */
router.get('/unread', controller.unread)
router.post('/read-all', controller.markAllRead)

router.get('/', controller.list)
router.post('/:id/read', controller.markRead)
router.delete('/:id', controller.dismiss)

export default router
