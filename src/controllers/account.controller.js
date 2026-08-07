/**
 * Account controller.
 */

import { buildAccountProfile, buildAccountStatus } from '../services/account.service.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { sendSuccess } from '../utils/ApiResponse.js'

/**
 * GET /api/v1/account
 *
 * The user's profile, the attached Microsoft account, their role and provider.
 * Requires authentication.
 */
export const getAccount = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Account retrieved successfully.',
    data: await buildAccountProfile(req.auth),
  }),
)

/**
 * GET /api/v1/account/status
 *
 * Health of every tier plus authentication and token-expiry detail.
 *
 * Performs a live Microsoft Graph probe by default, which costs one round trip.
 * `?probe=false` skips it for callers that only need the local tiers, so a
 * frequent poll does not have to spend Graph throttling budget.
 *
 * Requires authentication.
 */
export const getAccountStatus = asyncHandler(async (req, res) => {
  const probeGraphApi = req.query.probe !== 'false'

  const data = await buildAccountStatus(req.auth, { probeGraphApi })

  // Status responses describe a single instant and must never be cached, or the
  // dashboard would show a stale "healthy" after a dependency failed.
  res.set('Cache-Control', 'no-store')

  return sendSuccess(res, {
    message: 'Status retrieved successfully.',
    data,
  })
})

export default { getAccount, getAccountStatus }
