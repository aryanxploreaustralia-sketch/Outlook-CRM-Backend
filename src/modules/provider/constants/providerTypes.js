/**
 * Email providers the abstraction can drive.
 *
 * Part of the API contract — `/provider/status` reports one of these and the UI
 * matches on it, so values must not be renamed once published.
 *
 * Only `microsoft-graph` and `mock` are implemented. The rest are declared
 * deliberately: naming the target set now is what forces the interface to stay
 * general, and it documents the intended shape for whoever adds them. A value
 * appearing here does **not** mean an adapter exists — `IMPLEMENTED_PROVIDERS`
 * below is the authority on that.
 */

export const PROVIDER_TYPES = Object.freeze({
  MICROSOFT_GRAPH: 'microsoft-graph',
  GMAIL: 'gmail',
  SMTP: 'smtp',
  IMAP: 'imap',
  SENDGRID: 'sendgrid',
  /** In-memory adapter used when no real provider is configured. */
  MOCK: 'mock',
})

export const PROVIDER_TYPE_VALUES = Object.freeze(Object.values(PROVIDER_TYPES))

/** Adapters that actually exist. The registry refuses anything not listed here. */
export const IMPLEMENTED_PROVIDERS = Object.freeze([
  PROVIDER_TYPES.MICROSOFT_GRAPH,
  PROVIDER_TYPES.MOCK,
])

export const PROVIDER_LABELS = Object.freeze({
  [PROVIDER_TYPES.MICROSOFT_GRAPH]: 'Microsoft Outlook',
  [PROVIDER_TYPES.GMAIL]: 'Gmail',
  [PROVIDER_TYPES.SMTP]: 'SMTP',
  [PROVIDER_TYPES.IMAP]: 'IMAP',
  [PROVIDER_TYPES.SENDGRID]: 'SendGrid',
  [PROVIDER_TYPES.MOCK]: 'Simulated mailbox',
})

/**
 * Connection states reported by `validateConnection()`.
 *
 * `DEGRADED` is distinct from `ERROR` on purpose: a mailbox whose token still
 * works but whose last sync failed is usable for sending, and collapsing the two
 * would hide that from the user.
 */
export const CONNECTION_STATUS = Object.freeze({
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  EXPIRED: 'expired',
  DEGRADED: 'degraded',
  NOT_CONFIGURED: 'not_configured',
  ERROR: 'error',
})

export const CONNECTION_STATUS_VALUES = Object.freeze(Object.values(CONNECTION_STATUS))

export default PROVIDER_TYPES
