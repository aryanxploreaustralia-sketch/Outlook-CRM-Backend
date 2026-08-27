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
 * The connection state of the *workspace*, not of one sign-in.
 *
 * ## The defect this exists for
 *
 * `getConnectionStatus` above answers "is this stored Outlook account healthy?".
 * That was the whole question while Microsoft sign-in was the only way in,
 * because signing in and connecting a mailbox were one act — so the session
 * always carried the account and reading it was reading the workspace.
 *
 * Google sign-in separated the two. A Google session legitimately has
 * `session.outlookAccount === null`, so every caller that derived the badge from
 * it reported "Not connected" for a workspace with healthy mailboxes attached.
 * `/auth/status` and `requireMailbox` were moved onto `Mailbox` in Phase 13.2;
 * `/dashboard` and `/account` were not, and kept reading the session. This is
 * the same correction, applied to the three that were missed.
 *
 * ## Why the session account is still consulted
 *
 * Last, and only as a fallback. A Microsoft-authenticated installation whose
 * mailboxes have not been materialised into `Mailbox` rows yet has nothing else
 * to report from, and must keep reporting exactly what it always did. Where
 * both exist the mailbox wins, because the mailbox is what actually sends.
 *
 * ## Multiple mailboxes
 *
 * One sendable mailbox is enough to be connected, and so are five. The count is
 * reported alongside rather than folded into the status, so a caller that wants
 * to say "Connected · 2 accounts" can, and one that does not is unaffected.
 *
 * @param {object}   params
 * @param {object}   params.user            The authenticated user's `_id`.
 * @param {?object} [params.sessionAccount] `req.auth.outlookAccount`, or null.
 * @returns {Promise<object>} The same shape `getConnectionStatus` returns, plus
 *   `mailboxCount` and `connectedMailboxCount`.
 */
export async function resolveConnectionStatus({ user, sessionAccount = null }) {
  /*
   * Imported here rather than at module scope.
   *
   * `status.service` is imported by the health endpoint, which must answer
   * before the provider module's own imports are worth paying for — and a
   * static edge from here into the provider repository would make this file
   * depend on the mailbox model to report that the database is up.
   */
  const { listMailboxes } = await import(
    '../modules/provider/repositories/mailbox.repository.js'
  )

  let mailboxes = []
  try {
    mailboxes = await listMailboxes({ user })
  } catch (error) {
    /*
     * An unreadable mailbox collection is not proof of no mailbox.
     *
     * Falling through to the session account is the honest answer here: it
     * reports what we can still see rather than asserting "not connected",
     * which is a claim this failure does not support.
     */
    log.warn('Could not read mailboxes for connection status', { error: error.message })
    return { ...getConnectionStatus(sessionAccount), mailboxCount: null, connectedMailboxCount: null }
  }

  const counts = {
    mailboxCount: mailboxes.length,
    connectedMailboxCount: mailboxes.filter(
      (mailbox) => mailbox.status === CONNECTION_STATUS.CONNECTED && !mailbox.disconnectedAt,
    ).length,
  }

  // Nothing to report from — the session account is all there is.
  if (mailboxes.length === 0) {
    return { ...getConnectionStatus(sessionAccount), ...counts }
  }

  /*
   * The mailbox this workspace would actually send through.
   *
   * `listMailboxes` already returns the user's default first, then the
   * connector's legacy flag, then newest — so the first sendable entry is the
   * one `findDefaultMailbox` would resolve to. Describing a different mailbox
   * from the one that sends is how a badge and a send path come to disagree.
   */
  const representative =
    mailboxes.find(
      (mailbox) => mailbox.status === CONNECTION_STATUS.CONNECTED && !mailbox.disconnectedAt,
    ) ?? mailboxes[0]

  /*
   * `tokenExpiry` is deliberately unknown on this path.
   *
   * A `Mailbox` row holds no token — the credential lives on the account it was
   * materialised from. `buildTokenExpiry(null)` reports nulls, which renders as
   * a plain "Connected"; inventing an expiry to fill the field would put a
   * "renewing soon" caption on a mailbox whose token we never looked at.
   */
  return {
    status: representative.status,
    connected: counts.connectedMailboxCount > 0,
    email: representative.emailAddress ?? null,
    scopes: sessionAccount?.scopes ?? [],
    connectedAt: representative.connectedAt ?? null,
    disconnectedAt: representative.disconnectedAt ?? null,
    disconnectReason: representative.statusReason ?? null,
    tokenExpiry: buildTokenExpiry(null),
    ...counts,
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
  resolveConnectionStatus,
  getAuthenticationStatus,
  buildTokenExpiry,
  probeGraph,
}
