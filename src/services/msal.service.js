/**
 * Microsoft identity platform (MSAL) service.
 *
 * Owns every interaction with Entra ID and the lifecycle of the encrypted token
 * cache. Callers ask for "a valid access token for this account" and this module
 * decides whether the cached one is usable or a refresh is required.
 *
 * ## Cache strategy
 *
 * A `ConfidentialClientApplication` is created per operation and seeded with the
 * account's decrypted cache, rather than kept as a long-lived singleton. That is
 * a deliberate trade: constructing a client costs a little, but a shared
 * in-memory cache across all users would leak one user's tokens into another
 * user's request context, and MSAL's cache is not partitioned by user.
 *
 * After any operation that mutates the cache, the serialised blob is re-encrypted
 * and written back — which is what keeps Entra ID's refresh-token rotation
 * working.
 */

import { ConfidentialClientApplication, LogLevel } from '@azure/msal-node'

import { config } from '../config/index.js'
import { ERROR_CODES } from '../constants/errorCodes.js'
import { HTTP_STATUS } from '../constants/httpStatus.js'
import { OutlookAccount } from '../models/outlookAccount.model.js'
import { ApiError } from '../utils/ApiError.js'
import { decryptSecret, encryptSecret } from '../utils/crypto.js'
import { createContextLogger } from '../utils/logger.js'

const log = createContextLogger('msal')

/**
 * Errors from Entra ID that mean the grant is gone for good.
 *
 * These must not be retried: the user revoked consent, changed their password,
 * or an administrator removed the grant. The only fix is to sign in again, so the
 * connection is marked disconnected and the UI prompts for reconnection.
 * Treating them as transient would produce an infinite refresh loop.
 */
const UNRECOVERABLE_ERROR_CODES = new Set([
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'login_required',
  'token_expired',
])

/** Guards every entry point so a missing Azure config fails descriptively. */
function assertConfigured() {
  if (!config.microsoft.enabled) {
    throw new ApiError(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      'Microsoft authentication is not configured on this server. ' +
        'Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID, ' +
        'MICROSOFT_REDIRECT_URI, SESSION_SECRET and TOKEN_ENCRYPTION_KEY in backend/.env.',
      { code: ERROR_CODES.SERVICE_UNAVAILABLE },
    )
  }
}

/**
 * Builds a confidential client, optionally seeded with an existing cache.
 *
 * @param {?string} serialisedCache Decrypted MSAL cache blob.
 * @returns {ConfidentialClientApplication}
 */
function createClient(serialisedCache = null) {
  assertConfigured()

  const client = new ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      authority: config.microsoft.authority,
      clientSecret: config.microsoft.clientSecret,
    },
    system: {
      loggerOptions: {
        /**
         * MSAL logs can contain tokens and personal data. PII is disabled
         * unconditionally, and output is routed through the application logger
         * at debug level so it is silent in production.
         */
        piiLoggingEnabled: false,
        logLevel: LogLevel.Warning,
        loggerCallback(level, message, containsPii) {
          if (containsPii) return
          if (level === LogLevel.Error) log.error(message)
          else if (level === LogLevel.Warning) log.warn(message)
        },
      },
    },
  })

  if (serialisedCache) {
    client.getTokenCache().deserialize(serialisedCache)
  }

  return client
}

/** Scopes valid in a token request — MSAL rejects reserved OIDC scopes here. */
function resourceScopes() {
  const reserved = new Set(config.microsoft.reservedScopes)
  return config.microsoft.scopes.filter((scope) => !reserved.has(scope))
}

/**
 * Builds the Microsoft authorization URL.
 *
 * `redirectUri` is a parameter rather than always the configured value, because
 * this server now runs two different Microsoft flows — signing in, and
 * authorising a mailbox — and they may land on different callbacks. Defaulting
 * to the configured URI keeps every existing caller behaving exactly as before.
 *
 * Whatever is passed here **must** also be passed to `redeemAuthorizationCode`:
 * OAuth requires both halves to present the same `redirect_uri`, and Entra ID
 * rejects the code if they differ.
 *
 * @param {{ state: string, codeChallenge: string, redirectUri?: string }} params
 * @returns {Promise<string>}
 */
export async function buildAuthorizationUrl({ state, codeChallenge, redirectUri = null }) {
  const client = createClient()

  return client.getAuthCodeUrl({
    scopes: config.microsoft.scopes,
    redirectUri: redirectUri ?? config.microsoft.redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod: 'S256',
    // Always show the account picker so a user on a shared machine is not
    // silently signed in as whoever used the browser last.
    prompt: 'select_account',
  })
}

/**
 * Redeems an authorization code for tokens.
 *
 * `redirectUri` must match the one the authorization request was built with —
 * see `buildAuthorizationUrl`. Callers that record it on their flow record pass
 * it back here; the default preserves the single-flow behaviour.
 *
 * @param {{ code: string, codeVerifier: string, redirectUri?: string }} params
 * @returns {Promise<{ result: import('@azure/msal-node').AuthenticationResult, serialisedCache: string }>}
 */
export async function redeemAuthorizationCode({ code, codeVerifier, redirectUri = null }) {
  const client = createClient()

  let result
  try {
    result = await client.acquireTokenByCode({
      code,
      codeVerifier,
      scopes: config.microsoft.scopes,
      redirectUri: redirectUri ?? config.microsoft.redirectUri,
    })
  } catch (error) {
    log.error('Authorization code redemption failed', {
      errorCode: error.errorCode,
      message: error.errorMessage ?? error.message,
    })

    throw new ApiError(
      HTTP_STATUS.UNAUTHORIZED,
      'Could not complete Microsoft sign-in. The authorization code was rejected, ' +
        'which usually means it expired or was already used. Please try again.',
      { code: ERROR_CODES.UNAUTHORIZED, cause: error },
    )
  }

  if (!result?.account) {
    throw ApiError.internal('Microsoft returned a token response without account details.')
  }

  return {
    result,
    // Serialised *after* redemption so the blob contains the refresh token.
    serialisedCache: client.getTokenCache().serialize(),
  }
}

/**
 * Marks a connection unusable so the UI can prompt the user to reconnect.
 *
 * @param {import('mongoose').Document} account
 * @param {string} reason
 */
async function markDisconnected(account, reason) {
  account.disconnectedAt = new Date()
  account.disconnectReason = reason
  await account.save()

  log.warn('Outlook connection marked as disconnected', {
    accountId: account._id.toString(),
    reason,
  })
}

/**
 * Returns a valid access token for an account, refreshing it if necessary.
 *
 * `acquireTokenSilent` handles the decision internally: it serves the cached
 * access token when still valid, and redeems the refresh token when not. That is
 * why this function does not compare expiry timestamps itself — doing so would
 * duplicate logic MSAL already owns, including its clock-skew allowance.
 *
 * @param {string} outlookAccountId
 * @returns {Promise<{ accessToken: string, expiresOn: ?Date, scopes: string[] }>}
 */
export async function getAccessToken(outlookAccountId) {
  assertConfigured()

  // `tokenCache` is `select: false`, so it must be requested explicitly.
  const account = await OutlookAccount.findById(outlookAccountId).select('+tokenCache')

  if (!account) {
    throw ApiError.notFound('No Outlook connection found for this session.')
  }

  if (account.disconnectedAt) {
    throw ApiError.unauthorized(
      `The Outlook connection is no longer valid (${account.disconnectReason ?? 'disconnected'}). ` +
        'Please reconnect your Microsoft account.',
    )
  }

  let serialisedCache
  try {
    serialisedCache = decryptSecret(account.tokenCache, config.security.tokenEncryptionKey)
  } catch (error) {
    // A decryption failure means the key changed or the record was tampered
    // with. Either way the cache is unusable and re-authentication is required.
    log.error('Failed to decrypt stored token cache', {
      accountId: account._id.toString(),
      message: error.message,
    })
    await markDisconnected(account, 'token_cache_unreadable')

    throw ApiError.unauthorized(
      'Stored Microsoft credentials could not be read. Please reconnect your account.',
      { cause: error },
    )
  }

  const client = createClient(serialisedCache)
  const cache = client.getTokenCache()
  const msalAccount = await cache.getAccountByHomeId(account.homeAccountId)

  if (!msalAccount) {
    await markDisconnected(account, 'account_missing_from_cache')
    throw ApiError.unauthorized(
      'The stored Microsoft session is incomplete. Please reconnect your account.',
    )
  }

  let result
  try {
    result = await client.acquireTokenSilent({
      account: msalAccount,
      scopes: resourceScopes(),
    })
  } catch (error) {
    const errorCode = error.errorCode ?? 'unknown_error'

    if (UNRECOVERABLE_ERROR_CODES.has(errorCode)) {
      await markDisconnected(account, errorCode)
      throw ApiError.unauthorized(
        'Your Microsoft session has expired or access was revoked. Please sign in again.',
        { cause: error },
      )
    }

    // Anything else — network failure, Entra ID outage, throttling — is
    // transient. The connection stays intact so the next request can succeed.
    log.error('Silent token acquisition failed', {
      accountId: account._id.toString(),
      errorCode,
      message: error.errorMessage ?? error.message,
    })

    throw ApiError.serviceUnavailable(
      'Could not reach Microsoft to refresh your access token. Please try again shortly.',
      { cause: error },
    )
  }

  // Persist the cache whenever MSAL may have rotated the refresh token.
  const updatedCache = cache.serialize()
  if (updatedCache !== serialisedCache) {
    account.tokenCache = encryptSecret(updatedCache, config.security.tokenEncryptionKey)
    log.debug('Token cache rotated and re-encrypted', { accountId: account._id.toString() })
  }

  account.accessTokenExpiresAt = result.expiresOn ?? null
  if (Array.isArray(result.scopes) && result.scopes.length > 0) {
    account.scopes = result.scopes
  }
  await account.save()

  return {
    accessToken: result.accessToken,
    expiresOn: result.expiresOn ?? null,
    scopes: result.scopes ?? [],
  }
}

/**
 * Removes an account from the cached MSAL state.
 *
 * Called on logout so the stored cache cannot be reused even if the encrypted
 * blob is somehow recovered later.
 *
 * @param {import('mongoose').Document} account An account with `tokenCache` selected.
 */
export async function purgeCachedAccount(account) {
  try {
    const serialisedCache = decryptSecret(account.tokenCache, config.security.tokenEncryptionKey)
    const client = createClient(serialisedCache)
    const cache = client.getTokenCache()
    const msalAccount = await cache.getAccountByHomeId(account.homeAccountId)

    if (msalAccount) {
      await cache.removeAccount(msalAccount)
    }

    return encryptSecret(cache.serialize(), config.security.tokenEncryptionKey)
  } catch (error) {
    // Logout must never fail because of cleanup. The session is deleted
    // regardless, which is what actually ends the user's access.
    log.warn('Could not purge MSAL cache during logout', { message: error.message })
    return null
  }
}

/**
 * Builds the Entra ID sign-out URL.
 *
 * Ending only the local session leaves the user still signed in at Microsoft, so
 * the next sign-in attempt completes silently — surprising on a shared machine.
 *
 * @param {string} postLogoutRedirectUri
 * @returns {?string}
 */
export function buildLogoutUrl(postLogoutRedirectUri) {
  if (!config.microsoft.enabled) return null

  const url = new URL(`${config.microsoft.authority}/oauth2/v2.0/logout`)
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri)
  return url.toString()
}

export default {
  buildAuthorizationUrl,
  redeemAuthorizationCode,
  getAccessToken,
  purgeCachedAccount,
  buildLogoutUrl,
}
