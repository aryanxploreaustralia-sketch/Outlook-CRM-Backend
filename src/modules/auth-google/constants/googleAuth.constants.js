/**
 * Google sign-in vocabulary (Phase 13.1).
 *
 * Identity only. Nothing in this module describes a mailbox, a message or a
 * send — those belong to the Microsoft provider and always will.
 */

/**
 * Machine-readable failure reasons.
 *
 * These travel to the browser in the callback's `reason` query parameter, so
 * the login page can explain what went wrong in words a person can act on.
 * They are part of the contract with the frontend and must not be renamed once
 * published.
 */
export const GOOGLE_AUTH_ERROR = Object.freeze({
  /** No OAuth client configured on this server. */
  NOT_CONFIGURED: 'google_not_configured',

  /** Could not reach Google's token or JWKS endpoint. Transient. */
  PROVIDER_UNREACHABLE: 'google_unreachable',

  /** Google refused the authorization code — expired, reused, or mismatched. */
  CODE_REJECTED: 'google_code_rejected',
  NO_ID_TOKEN: 'google_no_id_token',

  // --- Token verification -------------------------------------------------
  MALFORMED_TOKEN: 'google_malformed_token',
  BAD_ALGORITHM: 'google_bad_algorithm',
  UNKNOWN_SIGNING_KEY: 'google_unknown_key',
  BAD_SIGNATURE: 'google_bad_signature',
  BAD_ISSUER: 'google_bad_issuer',
  BAD_AUDIENCE: 'google_bad_audience',
  TOKEN_EXPIRED: 'google_token_expired',
  TOKEN_NOT_YET_VALID: 'google_token_not_yet_valid',
  NONCE_MISMATCH: 'google_nonce_mismatch',

  // --- Policy -------------------------------------------------------------
  /** The flow row was missing, already consumed, or had expired. */
  FLOW_INVALID: 'google_flow_invalid',
  /** Google reported the address but has not verified ownership of it. */
  EMAIL_NOT_VERIFIED: 'google_email_unverified',
  /** No email claim at all — cannot key a CRM account. */
  NO_EMAIL: 'google_no_email',
  /** The address is outside GOOGLE_ALLOWED_DOMAINS. */
  DOMAIN_NOT_ALLOWED: 'google_domain_not_allowed',
  /** The matching CRM account is suspended. */
  ACCOUNT_INACTIVE: 'account_inactive',
  /** The matching CRM account is soft-deleted. */
  ACCOUNT_DELETED: 'account_deleted',
})

/**
 * How long an unfinished Google sign-in stays valid.
 *
 * Matches the Microsoft flow's ten minutes. Long enough to read a consent
 * screen and pick an account, short enough that an abandoned attempt is not a
 * standing replay target.
 */
export const GOOGLE_FLOW_TTL_MS = 10 * 60 * 1000

/**
 * Tolerance applied to `exp` and `iat`.
 *
 * Two minutes. Server clocks drift, and rejecting a token because this machine
 * is ninety seconds behind Google's would be an outage caused by NTP rather
 * than by anything a user did.
 */
export const ID_TOKEN_CLOCK_TOLERANCE_MS = 2 * 60 * 1000

/**
 * How long Google's signing keys are cached.
 *
 * One hour. Google publishes a `Cache-Control` max-age in the same region and
 * rotates keys on a far longer cycle; an unrecognised `kid` forces an immediate
 * refetch regardless, so a rotation is picked up on the first sign-in that
 * needs it rather than after this expires.
 */
export const JWKS_CACHE_TTL_MS = 60 * 60 * 1000

/** Network budgets. A sign-in must fail fast rather than hang the browser. */
export const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000
export const JWKS_FETCH_TIMEOUT_MS = 5_000

export default GOOGLE_AUTH_ERROR
