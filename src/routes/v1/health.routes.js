/**
 * Health routes.
 */

import { Router } from 'express'

import { getHealth } from '../../controllers/health.controller.js'

const router = Router()

/**
 * GET /api/v1/health
 * Liveness and dependency status. Excluded from rate limiting so monitoring
 * probes can poll it freely.
 */
router.get('/', getHealth)

export default router
