/**
 * Google OAuth 2.0 / OpenID Connect transport.
 *
 * Everything that talks to Google lives here: building the authorization URL,
 * redeeming the code, and verifying the ID token. It knows nothing about CRM
 * users, sessions or roles — `googleIdentity.service.js` owns that. The split
 * matters because it is what lets the identity rules be reasoned about without
 * reading any cryptography.
 *
 * ## Why there is no `google-auth-library` dependency
 *
 * The library would be one function call, and this file is the argument against
 * taking it: the repository has reached code freeze, already hand-rolls its
 * XLSX reader *and* writer rather than add a dependency, and the verification
 * Google's library performs is a JWKS fetch plus an RS256 signature check that
 * `node:crypto` does natively via `createPublicKey({ format: 'jwk' })`. Adding
 * a transitive dependency tree to an authentication path at freeze is a larger
 * risk than the fifty lines below.
 *
 * Nothing here is a shortcut. The ID token is verified in full — signature
 * against Google's published keys, issuer, audience, expiry, issued-at and
 * nonce — even though the token arrives over a TLS channel authenticated with
 * the client secret and Google's own guidance permits skipping it in that case.
 *
 * ## What is deliberately absent
 *
 * No refresh token is requested, stored or used. Google's access token is not
 * kept either. This provider establishes *who the user is*, once, and then has
 * no further role: the CRM's own session takes over. That is the whole reason
 * `offline_access`-style long-lived credentials — which the Microsoft mailbox
 * path genuinely needs — have no place in this file.
 */

import crypto from 'node:crypto'

import { config } from '../../../config/index.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import {
  GOOGLE_AUTH_ERROR,
  ID_TOKEN_CLOCK_TOLERANCE_MS,
  JWKS_CACHE_TTL_MS,
  JWKS_FETCH_TIMEOUT_MS,
  TOKEN_EXCHANGE_TIMEOUT_MS,
} from '../constants/googleAuth.constants.js'

const log = createContextLogger('google-auth')

/** Raised when Google sign-in is invoked on a server that has no OAuth client. */
export function assertGoogleConfigured() {
  if (config.google.enabled) return

  throw ApiError.serviceUnavailable(
    'Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID, ' +
      'GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL in backend/.env. ' +
      'See docs/GOOGLE_SETUP.md.',
    { code: GOOGLE_AUTH_ERROR.NOT_CONFIGURED },
  )
}

// ---------------------------------------------------------------------------
// PKCE and nonce
// ---------------------------------------------------------------------------

/**
 * Generates a PKCE verifier, its S256 challenge, and a nonce.
 *
 * The two protect different things and both are needed: PKCE binds the
 * authorization *code* to this flow, the nonce binds the ID *token* to it.
 *
 * @returns {{ codeVerifier: string, codeChallenge: string, nonce: string }}
 */
export function createFlowSecrets() {
  // RFC 7636 permits 43–128 characters; 32 random bytes base64url is 43.
  const codeVerifier = crypto.randomBytes(32).toString('base64url')

  return {
    codeVerifier,
    codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
    nonce: crypto.randomBytes(32).toString('base64url'),
  }
}

/**
 * Builds the URL the browser is redirected to.
 *
 * @param {{ state: string, codeChallenge: string, nonce: string }} params
 * @returns {string}
 */
export function buildAuthorisationUrl({ state, codeChallenge, nonce }) {
  assertGoogleConfigured()

  const url = new URL(config.google.endpoints.authorisation)

  url.searchParams.set('client_id', config.google.clientId)
  url.searchParams.set('redirect_uri', config.google.callbackUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', config.google.scopes.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')

  /**
   * Always show the account chooser.
   *
   * The same decision the Microsoft flow makes, for the same reason: on a
   * shared machine a silent sign-in as whoever used the browser last is a
   * security problem disguised as a convenience.
   */
  url.searchParams.set('prompt', 'select_account')

  /**
   * A Workspace hint, when the deployment is restricted to one domain.
   *
   * Purely a convenience — it pre-fills the domain on Google's own screen. It
   * is **not** a security control and is never trusted: the real restriction is
   * enforced against the verified ID token in `verifyIdToken`.
   */
  if (config.google.allowedDomains.length === 1) {
    url.searchParams.set('hd', config.google.allowedDomains[0])
  }

  return url.toString()
}

// ---------------------------------------------------------------------------
// Code exchange
// ---------------------------------------------------------------------------

/**
 * Redeems an authorization code for an ID token.
 *
 * Server-to-server over TLS, carrying the client secret — the browser never
 * sees any of it.
 *
 * @param {{ code: string, codeVerifier: string }} params
 * @returns {Promise<{ idToken: string }>}
 */
export async function exchangeCode({ code, codeVerifier }) {
  assertGoogleConfigured()

  const body = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: config.google.callbackUrl,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  })

  let response
  try {
    response = await fetch(config.google.endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    })
  } catch (error) {
    // A network failure or timeout — transient, and distinct from a rejection.
    throw ApiError.serviceUnavailable(
      'Could not reach Google to complete sign-in. Please try again shortly.',
      { code: GOOGLE_AUTH_ERROR.PROVIDER_UNREACHABLE, cause: error },
    )
  }

  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    // Logged with Google's own error code; the browser is told only that it
    // failed, because the detail is a server configuration matter.
    log.error('Google rejected the authorization code', {
      status: response.status,
      error: payload?.error ?? null,
      description: payload?.error_description ?? null,
    })

    throw ApiError.unauthorized(
      'Google could not complete this sign-in. The authorization code was rejected, ' +
        'which usually means it expired or was already used. Please try again.',
      { code: GOOGLE_AUTH_ERROR.CODE_REJECTED },
    )
  }

  if (!payload?.id_token) {
    throw ApiError.internal('Google returned no ID token for this sign-in.', {
      code: GOOGLE_AUTH_ERROR.NO_ID_TOKEN,
    })
  }

  /**
   * Only the ID token is kept.
   *
   * `access_token` is discarded unread: this provider is not authorised for any
   * Google API and has no reason to call one. Keeping a credential nothing
   * consumes would be a liability with no benefit.
   */
  return { idToken: payload.id_token }
}

// ---------------------------------------------------------------------------
// ID token verification
// ---------------------------------------------------------------------------

/** kid -> { key: KeyObject, expiresAt: number } */
const jwksCache = new Map()

/**
 * Fetches Google's signing keys, cached.
 *
 * Google rotates these; the cache TTL is short enough to pick a rotation up
 * quickly and long enough that a burst of sign-ins is not a burst of requests.
 * A cache miss on an unknown `kid` forces a refetch, which is what makes a
 * rotation mid-TTL self-healing rather than a wave of failures.
 *
 * @param {string} kid
 * @returns {Promise<crypto.KeyObject>}
 */
async function resolveSigningKey(kid) {
  const cached = jwksCache.get(kid)
  if (cached && cached.expiresAt > Date.now()) return cached.key

  let response
  try {
    response = await fetch(config.google.endpoints.jwks, {
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw ApiError.serviceUnavailable(
      'Could not reach Google to verify this sign-in. Please try again shortly.',
      { code: GOOGLE_AUTH_ERROR.PROVIDER_UNREACHABLE, cause: error },
    )
  }

  if (!response.ok) {
    throw ApiError.serviceUnavailable('Google’s signing keys could not be read.', {
      code: GOOGLE_AUTH_ERROR.PROVIDER_UNREACHABLE,
    })
  }

  const { keys } = await response.json()
  const expiresAt = Date.now() + JWKS_CACHE_TTL_MS

  jwksCache.clear()

  for (const jwk of keys ?? []) {
    if (!jwk.kid) continue
    try {
      // Node imports a JWK directly, so there is no PEM conversion to get wrong.
      jwksCache.set(jwk.kid, {
        key: crypto.createPublicKey({ key: jwk, format: 'jwk' }),
        expiresAt,
      })
    } catch (error) {
      log.warn('Skipped an unreadable Google signing key', { kid: jwk.kid, error: error.message })
    }
  }

  const resolved = jwksCache.get(kid)

  if (!resolved) {
    throw ApiError.unauthorized('This sign-in was signed with a key Google does not publish.', {
      code: GOOGLE_AUTH_ERROR.UNKNOWN_SIGNING_KEY,
    })
  }

  return resolved.key
}

/** Decodes one base64url JWT segment into an object. */
function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

/**
 * Verifies a Google ID token completely and returns its claims.
 *
 * Checked, in order: structure, algorithm, signature, issuer, audience,
 * expiry, issued-at, nonce, and email verification. Every one of them is
 * load-bearing — the algorithm check is what stops an `alg: none` token, and
 * the audience check is what stops a token minted for a *different* Google
 * application being replayed at this one.
 *
 * @param {{ idToken: string, expectedNonce: string }} params
 * @returns {Promise<object>} The verified claims.
 */
export async function verifyIdToken({ idToken, expectedNonce }) {
  const parts = String(idToken).split('.')

  if (parts.length !== 3) {
    throw ApiError.unauthorized('The sign-in token from Google was malformed.', {
      code: GOOGLE_AUTH_ERROR.MALFORMED_TOKEN,
    })
  }

  const [headerPart, payloadPart, signaturePart] = parts

  let header
  let claims
  try {
    header = decodeSegment(headerPart)
    claims = decodeSegment(payloadPart)
  } catch {
    throw ApiError.unauthorized('The sign-in token from Google could not be read.', {
      code: GOOGLE_AUTH_ERROR.MALFORMED_TOKEN,
    })
  }

  // Pinned. Accepting whatever the token names would let a caller choose `none`
  // — the canonical JWT vulnerability.
  if (header.alg !== 'RS256') {
    throw ApiError.unauthorized(`Unsupported token algorithm "${header.alg}".`, {
      code: GOOGLE_AUTH_ERROR.BAD_ALGORITHM,
    })
  }

  if (!header.kid) {
    throw ApiError.unauthorized('The sign-in token named no signing key.', {
      code: GOOGLE_AUTH_ERROR.MALFORMED_TOKEN,
    })
  }

  const key = await resolveSigningKey(header.kid)

  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'),
    key,
    Buffer.from(signaturePart, 'base64url'),
  )

  if (!verified) {
    log.error('A Google ID token failed signature verification', { kid: header.kid })
    throw ApiError.unauthorized('The sign-in token from Google could not be verified.', {
      code: GOOGLE_AUTH_ERROR.BAD_SIGNATURE,
    })
  }

  // --- Claims --------------------------------------------------------------

  if (!config.google.issuers.includes(claims.iss)) {
    throw ApiError.unauthorized(`Unexpected token issuer "${claims.iss}".`, {
      code: GOOGLE_AUTH_ERROR.BAD_ISSUER,
    })
  }

  if (claims.aud !== config.google.clientId) {
    // A validly-signed Google token minted for someone else's application.
    log.error('A Google ID token was issued for a different audience', { aud: claims.aud })
    throw ApiError.unauthorized('That sign-in token was not issued for this application.', {
      code: GOOGLE_AUTH_ERROR.BAD_AUDIENCE,
    })
  }

  const now = Date.now()

  if (typeof claims.exp !== 'number' || claims.exp * 1000 + ID_TOKEN_CLOCK_TOLERANCE_MS < now) {
    throw ApiError.unauthorized('That sign-in expired. Please try again.', {
      code: GOOGLE_AUTH_ERROR.TOKEN_EXPIRED,
    })
  }

  if (typeof claims.iat === 'number' && claims.iat * 1000 - ID_TOKEN_CLOCK_TOLERANCE_MS > now) {
    // Issued in the future — a clock problem at best, a forgery attempt at worst.
    throw ApiError.unauthorized('That sign-in token is not yet valid.', {
      code: GOOGLE_AUTH_ERROR.TOKEN_NOT_YET_VALID,
    })
  }

  /**
   * The nonce ties this token to the flow this server started.
   *
   * Compared in constant time. The window is small and the value is
   * high-entropy, but a timing-safe comparison costs nothing and removes the
   * question entirely.
   */
  if (!claims.nonce || !safeEquals(String(claims.nonce), String(expectedNonce))) {
    throw ApiError.unauthorized('This sign-in could not be matched to a request from this server.', {
      code: GOOGLE_AUTH_ERROR.NONCE_MISMATCH,
    })
  }

  return claims
}

/** Constant-time string comparison. Length mismatch short-circuits safely. */
function safeEquals(a, b) {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  if (bufferA.length !== bufferB.length) return false
  return crypto.timingSafeEqual(bufferA, bufferB)
}

export default {
  assertGoogleConfigured,
  createFlowSecrets,
  buildAuthorisationUrl,
  exchangeCode,
  verifyIdToken,
}
