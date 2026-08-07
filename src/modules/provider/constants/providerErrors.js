/**
 * Provider-independent failure vocabulary.
 *
 * Every adapter translates its own errors into these codes, which is what lets
 * the sync engine decide what to do without knowing which provider it is
 * talking to. Graph's `MailboxNotEnabledForRESTAPI`, an IMAP `NO` response and
 * a Gmail 404 all mean the same thing to the retry logic.
 */

export const PROVIDER_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  NOT_CONNECTED: 'PROVIDER_NOT_CONNECTED',
  UNAVAILABLE: 'PROVIDER_UNAVAILABLE',

  TOKEN_EXPIRED: 'PROVIDER_TOKEN_EXPIRED',
  TOKEN_REFRESH_FAILED: 'PROVIDER_TOKEN_REFRESH_FAILED',
  CONSENT_REQUIRED: 'PROVIDER_CONSENT_REQUIRED',

  MAILBOX_UNAVAILABLE: 'PROVIDER_MAILBOX_UNAVAILABLE',
  INSUFFICIENT_PERMISSIONS: 'PROVIDER_INSUFFICIENT_PERMISSIONS',

  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  NETWORK_FAILURE: 'PROVIDER_NETWORK_FAILURE',
  TIMEOUT: 'PROVIDER_TIMEOUT',

  /** A stored delta token was rejected; the folder needs a full resync. */
  DELTA_TOKEN_EXPIRED: 'PROVIDER_DELTA_TOKEN_EXPIRED',

  NOT_FOUND: 'PROVIDER_RESOURCE_NOT_FOUND',
  INVALID_REQUEST: 'PROVIDER_INVALID_REQUEST',
  UNSUPPORTED: 'PROVIDER_UNSUPPORTED_OPERATION',
  UNKNOWN: 'PROVIDER_UNKNOWN_ERROR',
})

/**
 * Failures worth retrying.
 *
 * The distinction is the whole point: retrying a rate limit succeeds once the
 * window passes, whereas retrying a revoked consent burns quota forever and
 * never succeeds. Anything not listed here is treated as permanent.
 */
export const RETRYABLE_ERROR_CODES = Object.freeze(
  new Set([
    PROVIDER_ERROR_CODES.RATE_LIMITED,
    PROVIDER_ERROR_CODES.NETWORK_FAILURE,
    PROVIDER_ERROR_CODES.TIMEOUT,
    PROVIDER_ERROR_CODES.UNAVAILABLE,
  ]),
)

/**
 * Failures that mean the connection is unusable until the user re-authenticates.
 *
 * The sync engine marks the mailbox disconnected on these rather than retrying,
 * so the UI can prompt instead of looping.
 */
export const FATAL_ERROR_CODES = Object.freeze(
  new Set([
    PROVIDER_ERROR_CODES.CONSENT_REQUIRED,
    PROVIDER_ERROR_CODES.TOKEN_REFRESH_FAILED,
    PROVIDER_ERROR_CODES.MAILBOX_UNAVAILABLE,
    PROVIDER_ERROR_CODES.INSUFFICIENT_PERMISSIONS,
  ]),
)

/**
 * A failure raised by a provider adapter.
 *
 * Carries the provider-independent `code` the engine branches on, plus the
 * untranslated provider detail so a log line can still name the original fault.
 */
export class ProviderError extends Error {
  /**
   * @param {string} code One of PROVIDER_ERROR_CODES.
   * @param {string} message Human-readable, safe to surface.
   * @param {object} [options]
   * @param {string} [options.provider]
   * @param {?string} [options.providerCode] The adapter's own untranslated code.
   * @param {?number} [options.statusCode] Upstream HTTP status, when there was one.
   * @param {?number} [options.retryAfterMs] Honoured by the retry helper.
   * @param {Error} [options.cause]
   * @param {?object} [options.details]
   */
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause })

    this.name = 'ProviderError'
    this.code = code
    this.provider = options.provider ?? null
    this.providerCode = options.providerCode ?? null
    this.statusCode = options.statusCode ?? null
    this.retryAfterMs = options.retryAfterMs ?? null
    this.details = options.details ?? null

    Error.captureStackTrace(this, ProviderError)
  }

  get isRetryable() {
    return RETRYABLE_ERROR_CODES.has(this.code)
  }

  get isFatal() {
    return FATAL_ERROR_CODES.has(this.code)
  }

  /** Shape written to `SyncHistory.errors` and returned in API responses. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      provider: this.provider,
      providerCode: this.providerCode,
      statusCode: this.statusCode,
      retryable: this.isRetryable,
      fatal: this.isFatal,
    }
  }
}

export default PROVIDER_ERROR_CODES
