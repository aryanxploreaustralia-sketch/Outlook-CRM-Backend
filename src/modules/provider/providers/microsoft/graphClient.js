/**
 * Low-level Graph access for the Microsoft adapter.
 *
 * Wraps the Phase 2 `graph.service` client factory — deliberately reused rather
 * than reimplemented, so MSAL token acquisition, refresh-on-demand and the
 * auth-error capture fixed in Phase 4 all continue to apply here, with one
 * implementation rather than two that can drift.
 *
 * Its own job is translation: Graph's failures become `ProviderError`s carrying
 * a provider-independent code, which is what lets the sync engine decide
 * whether to retry, resync or give up without knowing what Graph is.
 */

import { createGraphClient } from '../../../../services/graph.service.js'
import { ApiError } from '../../../../utils/ApiError.js'
import { PROVIDER_ERROR_CODES, ProviderError } from '../../constants/providerErrors.js'
import { PROVIDER_TYPES } from '../../constants/providerTypes.js'

/** Parses a Graph error body, which arrives as an object or a JSON string. */
function parseBody(body) {
  if (body && typeof body === 'object') return body
  if (typeof body !== 'string' || !body.trim().startsWith('{')) return null

  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/** Reads `Retry-After` (seconds) into milliseconds. */
function retryAfterMs(error) {
  const header = error?.headers?.['retry-after'] ?? error?.headers?.['Retry-After']
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

/**
 * Graph failure → `ProviderError`.
 *
 * The mapping choices that matter:
 *
 * - **410 Gone** is not an error. Graph returns it when a delta token has
 *   expired, and the correct response is a full resync — so it becomes
 *   `DELTA_TOKEN_EXPIRED`, which the engine handles as a normal event.
 * - **A bodyless 401** means Exchange declined to route to a mailbox, not that
 *   the token was rejected. Phase 5 inherits this distinction from the Phase 4
 *   investigation: a guest identity reads `/me` fine and 401s on every mailbox
 *   endpoint. Mapping it to `TOKEN_EXPIRED` would send the user round a
 *   reconnect loop that cannot terminate.
 * - **429 and 503** are retryable; everything else is not.
 *
 * @param {unknown} error
 * @param {string} operation
 * @returns {ProviderError}
 */
export function toProviderError(error, operation) {
  if (error instanceof ProviderError) return error

  const status = error?.statusCode ?? error?.status ?? null
  const body = parseBody(error?.body)
  const odata = body?.error ?? null
  const providerCode = odata?.code ?? error?.code ?? null

  const base = {
    provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
    providerCode,
    statusCode: status,
    cause: error instanceof Error ? error : undefined,
    details: { operation },
  }

  // An ApiError arriving here came from the MSAL layer inside `authProvider`,
  // which `createGraphClient` surfaces. Its meaning is already decided.
  if (error instanceof ApiError) {
    const code =
      error.statusCode === 403
        ? PROVIDER_ERROR_CODES.MAILBOX_UNAVAILABLE
        : PROVIDER_ERROR_CODES.CONSENT_REQUIRED

    return new ProviderError(code, error.message, { ...base, statusCode: error.statusCode })
  }

  if (status === 410) {
    return new ProviderError(
      PROVIDER_ERROR_CODES.DELTA_TOKEN_EXPIRED,
      'The synchronisation token has expired; a full resync is required.',
      base,
    )
  }

  if (status === 429) {
    return new ProviderError(
      PROVIDER_ERROR_CODES.RATE_LIMITED,
      'Microsoft Graph is throttling requests.',
      { ...base, retryAfterMs: retryAfterMs(error) ?? 20_000 },
    )
  }

  if (status === 401) {
    if (!odata) {
      return new ProviderError(
        PROVIDER_ERROR_CODES.MAILBOX_UNAVAILABLE,
        'This account has no Exchange Online mailbox, so mail operations are unavailable. ' +
          'Signing in again will not change that — a licensed Microsoft 365 mailbox is required.',
        base,
      )
    }

    return new ProviderError(
      PROVIDER_ERROR_CODES.TOKEN_EXPIRED,
      `Microsoft rejected the access token (${providerCode}).`,
      base,
    )
  }

  if (status === 403) {
    const isMailboxFault =
      providerCode === 'MailboxNotEnabledForRESTAPI' || providerCode === 'ErrorSendAsDenied'

    return new ProviderError(
      isMailboxFault
        ? PROVIDER_ERROR_CODES.MAILBOX_UNAVAILABLE
        : PROVIDER_ERROR_CODES.INSUFFICIENT_PERMISSIONS,
      odata?.message ?? 'Microsoft denied this operation.',
      base,
    )
  }

  if (status === 404) {
    return new ProviderError(
      PROVIDER_ERROR_CODES.NOT_FOUND,
      odata?.message ?? 'The requested Microsoft Graph resource does not exist.',
      base,
    )
  }

  if (status === 400) {
    return new ProviderError(
      PROVIDER_ERROR_CODES.INVALID_REQUEST,
      odata?.message ?? 'Microsoft Graph rejected the request as malformed.',
      base,
    )
  }

  if (status >= 500 || status === null) {
    // A null status means the request never landed — DNS, TLS or socket failure.
    return new ProviderError(
      status === null ? PROVIDER_ERROR_CODES.NETWORK_FAILURE : PROVIDER_ERROR_CODES.UNAVAILABLE,
      status === null
        ? 'Could not reach Microsoft Graph.'
        : 'Microsoft Graph is temporarily unavailable.',
      base,
    )
  }

  return new ProviderError(
    PROVIDER_ERROR_CODES.UNKNOWN,
    odata?.message ?? error?.message ?? 'Microsoft Graph returned an unexpected error.',
    base,
  )
}

/**
 * Runs one Graph operation with error translation.
 *
 * @template T
 * @param {string} outlookAccountId
 * @param {string} operation Description used in errors and logs.
 * @param {(client: import('@microsoft/microsoft-graph-client').Client) => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function callGraph(outlookAccountId, operation, run) {
  // Captured because the Graph SDK swallows an authProvider rejection and
  // re-raises an opaque GraphError with statusCode -1 — see graph.service.js.
  let authError = null

  const client = createGraphClient(outlookAccountId, {
    onAuthError: (error) => {
      authError = error
    },
  })

  try {
    return await run(client)
  } catch (error) {
    throw toProviderError(authError ?? error, operation)
  }
}

export default { callGraph, toProviderError }
