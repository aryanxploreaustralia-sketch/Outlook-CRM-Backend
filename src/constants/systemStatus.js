/**
 * Status vocabularies shared by the status endpoints and the dashboard badges.
 *
 * These strings are part of the API contract. The frontend maps each value to a
 * specific badge colour, so a value must never be renamed without updating the
 * badge map — an unrecognised value falls back to a neutral "unknown" badge
 * rather than rendering nothing.
 */

/** Health of an infrastructure dependency. */
export const SERVICE_STATUS = Object.freeze({
  /** Reachable and behaving normally. */
  HEALTHY: 'healthy',
  /** Reachable but impaired — slow, throttled, or partially failing. */
  DEGRADED: 'degraded',
  /** Reachable check performed and it failed. */
  ERROR: 'error',
  /** Not reachable at all. */
  OFFLINE: 'offline',
  /** Nothing to check yet, e.g. no mailbox connected. */
  NOT_CONFIGURED: 'not_configured',
  /** Check could not be performed. */
  UNKNOWN: 'unknown',
})

/** Liveness of the API process itself. */
export const PROCESS_STATUS = Object.freeze({
  ONLINE: 'online',
  OFFLINE: 'offline',
})

/** State of the stored Microsoft mailbox connection. */
export const CONNECTION_STATUS = Object.freeze({
  /** Usable now. */
  CONNECTED: 'connected',
  /** Access token has lapsed; the next Graph call will renew it silently. */
  REFRESHING: 'refreshing',
  /** The grant itself is gone — consent revoked or password changed. */
  EXPIRED: 'expired',
  /** Signed out, or otherwise deliberately disconnected. */
  DISCONNECTED: 'disconnected',
  /** No mailbox has ever been connected. */
  NOT_CONNECTED: 'not_connected',
})

/** State of the caller's session. */
export const AUTH_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  ANONYMOUS: 'anonymous',
})

/**
 * Disconnect reasons that mean the Microsoft grant expired or was revoked, as
 * opposed to an ordinary sign-out. Used to choose between the "Expired" and
 * "Disconnected" badges, which carry different meaning for the user: one needs
 * re-consent, the other just needs signing in again.
 */
export const EXPIRY_DISCONNECT_REASONS = Object.freeze([
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'login_required',
  'token_expired',
  'token_cache_unreadable',
  'account_missing_from_cache',
])

/** How close to expiry an access token must be before it is flagged. */
export const TOKEN_EXPIRY_WARNING_MS = 5 * 60 * 1000

export default { SERVICE_STATUS, PROCESS_STATUS, CONNECTION_STATUS, AUTH_STATUS }
