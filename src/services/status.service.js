/**
 * System and connection status.
 *
 * Single source of truth for "is everything working?". All three dashboard
 * endpoints read from here, so `/dashboard` and `/account/status` can never
 * disagree about whether the database is up — which they would if each computed
 * it independently.
 */

import { config } from '../config/index.js'
import {
  AUTH_STATUS,
  CONNECTION_STATUS,
  EXPIRY_DISCONNECT_REASONS,
  PROCESS_STATUS,
  SERVICE_STATUS,
  TOKEN_EXPIRY_WARNING_MS,
} from '../constants/systemStatus.js'
import { getDatabaseStatus } from '../config/database.js'
import { createContextLogger } from '../utils/logger.js'

const log = createContextLogger('status')

/** How long a Graph probe may take before it is treated as degraded. */
const GRAPH_PROBE_TIMEOUT_MS = 5000

/**
 * Liveness of this API process.
 *
 * Trivially `online` — code that can answer the question is by definition
 * running. Included so the dashboard reports every tier uniformly rather than
 * leaving one blank.
 */
export function getBackendStatus() {
  return {
    status: PROCESS_STATUS.ONLINE,
    service: config.app.name,
    version: config.app.version,
    environment: config.app.env,
    uptimeSeconds: Number(process.uptime().toFixed(2)),
  }
}

/** Health of the MongoDB connection. */
export function getDatabaseHealth() {
  const database = getDatabaseStatus()

  return {
    status: database.healthy ? SERVICE_STATUS.HEALTHY : SERVICE_STATUS.ERROR,
    state: database.status,
    name: database.name,
    host: database.host,
  }
}

/**
 * Derives the connection state of a stored Outlook account.
 *
 * The distinction between `expired` and `disconnected` matters to the user:
 * expired needs re-consent at Microsoft, disconnected just needs signing in
 * again. Collapsing them into one state would produce misleading guidance.
 *
 * @param {?object} account An OutlookAccount document, or null.
 */
export function getConnectionStatus(account) {
  if (!account) {
    return {
      status: CONNECTION_STATUS.NOT_CONNECTED,
      connected: false,
      email: null,
      scopes: [],
      connectedAt: null,
      disconnectedAt: null,
      disconnectReason: null,
      tokenExpiry: buildTokenExpiry(null),
    }
  }

  const tokenExpiry = buildTokenExpiry(account.accessTokenExpiresAt ?? null)

  let status
  if (account.disconnectedAt) {
    status = EXPIRY_DISCONNECT_REASONS.includes(account.disconnectReason)
      ? CONNECTION_STATUS.EXPIRED
      : CONNECTION_STATUS.DISCONNECTED
  } else if (tokenExpiry.isExpired) {
    // The grant is intact, so the next Graph call renews the access token
    // silently. Reporting this as "expired" would alarm the user unnecessarily.
    status = CONNECTION_STATUS.REFRESHING
  } else {
    status = CONNECTION_STATUS.CONNECTED
  }

  return {
    status,
    connected: !account.disconnectedAt,
    email: account.email ?? null,
    scopes: account.scopes ?? [],
    connectedAt: account.connectedAt ?? null,
    disconnectedAt: account.disconnectedAt ?? null,
    disconnectReason: account.disconnectReason ?? null,
    tokenExpiry,
  }
}

/**
 * Describes an access-token expiry.
 *
 * Only timestamps and derived booleans are returned — never a token value.
 *
 * @param {?Date} expiresAt
 */
export function buildTokenExpiry(expiresAt) {
  if (!expiresAt) {
    return { expiresAt: null, expiresInSeconds: null, isExpired: null, isExpiringSoon: null }
  }

  const remainingMs = new Date(expiresAt).getTime() - Date.now()

  return {
    expiresAt,
    expiresInSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
    isExpired: remainingMs <= 0,
    isExpiringSoon: remainingMs > 0 && remainingMs <= TOKEN_EXPIRY_WARNING_MS,
  }
}

/**
 * Describes the caller's session.
 *
 * @param {?object} session A Session document, or null.
 */
export function getAuthenticationStatus(session) {
  if (!session) {
    return {
      status: AUTH_STATUS.ANONYMOUS,
      authenticated: false,
      sessionExpiresAt: null,
      lastAuthenticatedAt: null,
    }
  }

  const isExpired = session.expiresAt.getTime() <= Date.now()

  return {
    status: isExpired ? AUTH_STATUS.EXPIRED : AUTH_STATUS.ACTIVE,
    authenticated: !isExpired,
    sessionExpiresAt: session.expiresAt,
    // When this session was established, i.e. when the user last authenticated
    // with Microsoft — distinct from the user's `lastLoginAt`, which survives
    // across sessions.
    lastAuthenticatedAt: session.createdAt ?? null,
  }
}

/**
 * Probes Microsoft Graph reachability.
 *
 * A real request is made rather than merely checking that a token exists,
 * because a cached token proves nothing about whether Graph is answering. The
 * probe is `GET /me?$select=id`, the cheapest authenticated call available.
 *
 * Never throws: an unreachable dependency is a status to report, not an error
 * that should fail the status endpoint itself.
 *
 * @param {?string} outlookAccountId
 * @returns {Promise<object>}
 */
export async function probeGraph(outlookAccountId) {
  const checkedAt = new Date().toISOString()

  if (!config.microsoft.enabled) {
    return {
      status: SERVICE_STATUS.NOT_CONFIGURED,
      checkedAt,
      latencyMs: null,
      detail: 'Microsoft authentication is not configured on this server.',
    }
  }

  if (!outlookAccountId) {
    return {
      status: SERVICE_STATUS.NOT_CONFIGURED,
      checkedAt,
      latencyMs: null,
      detail: 'No Outlook account is connected.',
    }
  }

  const startedAt = process.hrtime.bigint()

  try {
    // Imported lazily to keep this module usable in contexts where the Graph
    // SDK is not needed, and to avoid a circular import through msal.service.
    const { createGraphClient } = await import('./graph.service.js')
    const client = createGraphClient(outlookAccountId)

    // The Graph SDK has no per-request timeout, so one is imposed here. Without
    // it a hung dependency would hold the dashboard request open indefinitely.
    await Promise.race([
      client.api('/me').select('id').get(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Graph probe timed out')), GRAPH_PROBE_TIMEOUT_MS),
      ),
    ])

    const latencyMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n)

    return {
      status: SERVICE_STATUS.HEALTHY,
      checkedAt,
      latencyMs,
      detail: null,
    }
  } catch (error) {
    const latencyMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n)

    // Logged with detail server-side; the response carries only a safe summary.
    log.warn('Microsoft Graph probe failed', {
      accountId: outlookAccountId,
      message: error.message,
      statusCode: error.statusCode ?? null,
    })

    const isAuthFailure = error.statusCode === 401 || error.statusCode === 403

    return {
      status: isAuthFailure ? SERVICE_STATUS.ERROR : SERVICE_STATUS.DEGRADED,
      checkedAt,
      latencyMs,
      detail: isAuthFailure
        ? 'Microsoft rejected the stored credentials. Reconnect the account.'
        : 'Microsoft Graph did not respond successfully.',
    }
  }
}

export default {
  getBackendStatus,
  getDatabaseHealth,
  getConnectionStatus,
  getAuthenticationStatus,
  buildTokenExpiry,
  probeGraph,
}
