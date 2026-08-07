/**
 * Root API router.
 *
 * Mounted by `app.js` at `config.server.apiPrefix` (default `/api`), so the
 * health endpoint resolves to `/api/v1/health`.
 */

import { Router } from 'express'

import { config } from '../config/index.js'
import { sendSuccess } from '../utils/ApiResponse.js'
import v1Routes from './v1/index.js'

const router = Router()

/**
 * GET /api
 * Discovery document. Hitting the API root returns the available versions
 * rather than a bare 404, which is a small kindness to anyone exploring it.
 */
router.get('/', (req, res) =>
  sendSuccess(res, {
    message: `${config.app.name} is running.`,
    data: {
      service: config.app.name,
      version: config.app.version,
      environment: config.app.env,
      versions: {
        v1: `${config.server.apiPrefix}/v1`,
      },
      endpoints: {
        health: `${config.server.apiPrefix}/v1/health`,
        auth: {
          login: `${config.server.apiPrefix}/v1/auth/login`,
          callback: `${config.server.apiPrefix}/v1/auth/callback`,
          logout: `${config.server.apiPrefix}/v1/auth/logout`,
          profile: `${config.server.apiPrefix}/v1/auth/profile`,
          status: `${config.server.apiPrefix}/v1/auth/status`,
        },
        dashboard: `${config.server.apiPrefix}/v1/dashboard`,
        account: {
          profile: `${config.server.apiPrefix}/v1/account`,
          status: `${config.server.apiPrefix}/v1/account/status`,
        },
        mail: {
          send: `${config.server.apiPrefix}/v1/mail/send`,
          draft: `${config.server.apiPrefix}/v1/mail/draft`,
          history: `${config.server.apiPrefix}/v1/mail/history`,
          detail: `${config.server.apiPrefix}/v1/mail/:id`,
        },
        provider: {
          status: `${config.server.apiPrefix}/v1/provider/status`,
          validate: `${config.server.apiPrefix}/v1/provider/validate`,
          folders: `${config.server.apiPrefix}/v1/provider/folders`,
          connect: `${config.server.apiPrefix}/v1/provider/connect`,
          disconnect: `${config.server.apiPrefix}/v1/provider/disconnect`,
          sync: `${config.server.apiPrefix}/v1/provider/sync`,
          history: `${config.server.apiPrefix}/v1/provider/history`,
        },
      },
      features: {
        microsoftAuth: config.microsoft.enabled,
      },
    },
  }),
)

router.use('/v1', v1Routes)

export default router
