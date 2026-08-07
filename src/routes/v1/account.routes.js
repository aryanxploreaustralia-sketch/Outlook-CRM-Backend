/**
 * Account routes.
 *
 * Mounted at `${API_PREFIX}/v1/account`.
 */

import { Router } from 'express'

import { getAccount, getAccountStatus } from '../../controllers/account.controller.js'
import { requireAuth } from '../../middlewares/authenticate.js'

const router = Router()

// Applied to the whole router so no future route here can be left unprotected.
router.use(requireAuth)

router.get('/', getAccount)
router.get('/status', getAccountStatus)

export default router
