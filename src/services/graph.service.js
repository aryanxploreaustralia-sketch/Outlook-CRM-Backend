/**
 * Microsoft Graph service.
 *
 * The single place Graph is called from. Isolating it here means the rest of the
 * application deals in domain terms ("fetch this user's profile") rather than in
 * URLs and HTTP status codes, and it keeps Graph mockable in tests.
 *
 * The client is built per request with an `authProvider` that delegates to the
 * MSAL service. Because that provider is invoked at call time, a token that
 * expired since the last request is refreshed transparently — no caller ever
 * sees a 401 from Graph and has to retry.
 *
 * Node 22 provides a global `fetch`, so the `isomorphic-fetch` polyfill the Graph
 * SDK historically required is unnecessary here.
 */

import { Client } from '@microsoft/microsoft-graph-client'

import { config } from '../config/index.js'
import { HTTP_STATUS } from '../constants/httpStatus.js'
import { ApiError } from '../utils/ApiError.js'
import { createContextLogger } from '../utils/logger.js'
import { getAccessToken } from './msal.service.js'

const log = createContextLogger('graph')

/**
 * Fields requested from `/me`.
 *
 * Graph returns a broad default set; selecting explicitly keeps responses small
 * and makes it obvious exactly which personal data this application reads.
 */
const PROFILE_FIELDS = [
  'id',
  'displayName',
  'givenName',
  'surname',
  'mail',
  'userPrincipalName',
  'jobTitle',
  'officeLocation',
  'preferredLanguage',
]

/**
 * Creates a Graph client bound to one Outlook connection.
 *
 * @param {string} outlookAccountId
 * @param {{ onAuthError?: (error: unknown) => void }} [hooks]
 * @returns {import('@microsoft/microsoft-graph-client').Client}
 */
export function createGraphClient(outlookAccountId, { onAuthError } = {}) {
  return Client.init({
    defaultVersion: config.microsoft.graph.apiVersion,
    // The SDK retries 429 and 5xx responses with the backoff Graph asks for in
    // its Retry-After header, which is required to stay within throttling limits.
    debugLogging: false,
    authProvider: (done) => {
      getAccessToken(outlookAccountId)
        .then(({ accessToken }) => done(null, accessToken))
        .catch((error) => {
          onAuthError?.(error)
          done(error, null)
        })
    },
  })
}

/**
 * Runs one Graph operation, normalising whatever it throws.
 *
 * Exists because of a specific SDK behaviour: when `authProvider` rejects, the
 * client does **not** propagate that error. It swallows it and raises its own
 * `GraphError` with `statusCode: -1` and the original stringified into `body`.
 * The consequence is that a revoked-consent 401 — the single most common real
 * failure — arrives here indistinguishable from a transport fault, and would be
 * reported as "Graph is unavailable, try again shortly": advice that can never
 * work, for a condition only re-authentication fixes.
 *
 * Capturing the auth error as it happens is the only reliable way to keep it.
 *
 * @template T
 * @param {string} outlookAccountId
 * @param {string} operation Human-readable description used in logs.
 * @param {(client: import('@microsoft/microsoft-graph-client').Client) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function callGraph(outlookAccountId, operation, run) {
  let authError = null

  const client = createGraphClient(outlookAccountId, {
    onAuthError: (error) => {
      authError = error
    },
  })

  try {
    return await run(client)
  } catch (error) {
    // The captured auth error takes precedence: it is the real cause, and the
    // SDK's wrapper carries none of its status or code.
    throw translateGraphError(authError ?? error, operation)
  }
}

/**
 * Parses a Graph error body, which the SDK delivers as an object on some paths
 * and as a JSON string on others. Never throws — a diagnostic helper that can
 * fail while reporting a failure is worse than useless.
 *
 * @param {unknown} body
 * @returns {?object}
 */
function parseGraphBody(body) {
  if (body && typeof body === 'object') return body
  if (typeof body !== 'string' || !body.trim().startsWith('{')) return null

  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * Extracts the parts of a Graph failure worth recording.
 *
 * The SDK's error shape varies by failure mode — a transport failure has no
 * `statusCode` at all, while an OData error nests its code under `body`. This
 * flattens all of them into one shape so callers, and the `Mail.error`
 * subdocument, never have to probe.
 *
 * @param {unknown} error
 * @returns {{ statusCode: ?number, code: ?string, message: string }}
 */
export function describeGraphError(error) {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      // Graph's own code where `translateGraphError` captured it. Recording
      // `ErrorSendAsDenied` rather than a flat `FORBIDDEN` is the difference
      // between a diagnosable history entry and a shrug.
      code: error.details?.graphErrorCode ?? error.code,
      message: error.message,
      graphRequestId: error.details?.graphRequestId ?? null,
    }
  }

  const body = parseGraphBody(error?.body)

  return {
    statusCode: error?.statusCode ?? error?.status ?? null,
    code: error?.code ?? body?.error?.code ?? null,
    message: error?.message ?? body?.error?.message ?? String(error),
    graphRequestId: error?.requestId ?? body?.error?.innerError?.['request-id'] ?? null,
  }
}

/**
 * Translates a Graph SDK error into an `ApiError`.
 *
 * An `ApiError` raised by the auth layer inside `authProvider` is passed through
 * untouched, so a revoked-consent message is not masked by a generic one.
 *
 * @param {unknown} error
 * @param {string} operation Human-readable description for the log.
 * @returns {ApiError}
 */
function translateGraphError(error, operation) {
  if (error instanceof ApiError) return error

  const status = error?.statusCode ?? error?.status ?? null

  /**
   * Everything Graph told us, flattened.
   *
   * The summary that used to be logged here — status, code, message — was not
   * enough to diagnose a real failure. `request-id` is the only identifier
   * Microsoft support can act on, and `innerError` routinely carries the actual
   * reason while the outer `message` stays generic. Both were being discarded.
   *
   * The Graph SDK parses an OData error body into `error.body`, but only
   * sometimes: on some paths it arrives as a JSON *string*. It is parsed here so
   * the log has structure either way.
   */
  // Falls back to the raw value when it is not parseable JSON — an unparsed
  // body in the log is still better than no body.
  const body = parseGraphBody(error?.body) ?? error?.body ?? null
  const odata = body?.error ?? null

  log.error(`Microsoft Graph request failed: ${operation}`, {
    status,
    statusText: error?.statusText ?? null,
    code: error?.code ?? odata?.code ?? null,
    message: error?.message ?? String(error),
    graphErrorCode: odata?.code ?? null,
    graphErrorMessage: odata?.message ?? null,
    innerError: odata?.innerError ?? null,
    // Both correlation ids: `request-id` is Graph's, `client-request-id` is ours.
    requestId: error?.requestId ?? odata?.innerError?.['request-id'] ?? null,
    clientRequestId: odata?.innerError?.['client-request-id'] ?? null,
    graphDate: odata?.innerError?.date ?? null,
    headers: error?.headers ?? null,
    // The complete body, last so it never pushes the identifiers out of view in
    // a truncated log line.
    body,
  })

  // 400 is the interesting one for mail: Graph uses it for a malformed message
  // — a bad recipient, an attachment it will not accept — and that is the user's
  // input, not a server fault. Passing its message through is what makes the
  // failure actionable; the generic 503 below would hide the only useful detail.
  if (status === 400) {
    return ApiError.badRequest(
      error?.body?.error?.message ??
        error?.message ??
        'Microsoft Graph rejected the request as malformed.',
      { cause: error },
    )
  }

  if (status === 404) {
    return ApiError.notFound('The requested Microsoft Graph resource no longer exists.', {
      cause: error,
    })
  }

  if (status === 413) {
    return ApiError.badRequest(
      'The message is too large for Microsoft Graph to accept. Reduce the attachment size.',
      { cause: error },
    )
  }

  /**
   * Identifiers echoed back to the caller.
   *
   * Returned in the error envelope on purpose: without `graphRequestId` there is
   * no way to correlate a user's report with Microsoft's own logs, and asking
   * them to reproduce it while somebody tails the server is a poor substitute.
   * None of these values are sensitive — they are opaque correlation ids.
   */
  const diagnostics = {
    graphErrorCode: odata?.code ?? null,
    graphRequestId: error?.requestId ?? odata?.innerError?.['request-id'] ?? null,
    graphStatus: status,
  }

  if (status === 401) {
    /**
     * A 401 from Graph means one of two completely different things, and the
     * body is what separates them.
     *
     * **With** an OData error body (`InvalidAuthenticationToken`,
     * `CompactToken parsing failed`) the token really was rejected, and
     * re-authenticating is the fix.
     *
     * **Without** one — a bodyless 401, no `www-authenticate` header — the token
     * was fine and Exchange refused to route to a mailbox, because the identity
     * does not have one. Guest/`#EXT#` accounts and unlicensed users hit this on
     * every Exchange endpoint while `/me` keeps returning 200, since that is
     * Entra ID directory data rather than mailbox data.
     *
     * Telling the second group to "reconnect your account" sends them round a
     * loop that cannot terminate: the sign-in will succeed every time and the
     * mailbox will still not exist.
     */
    if (!odata) {
      return ApiError.forbidden(
        'Microsoft accepted the sign-in but this account has no Exchange Online mailbox, ' +
          'so it cannot send mail. This is normal for guest (#EXT#) accounts and for users ' +
          'without a licence that includes Exchange Online. Signing in again will not help — ' +
          'use an account that has a Microsoft 365 mailbox.',
        { cause: error, details: { ...diagnostics, likelyCause: 'no_exchange_mailbox' } },
      )
    }

    return ApiError.unauthorized(
      `Microsoft rejected the access token (${odata.code}: ${odata.message ?? 'no detail'}). ` +
        'Please reconnect your account.',
      { cause: error, details: diagnostics },
    )
  }

  if (status === 403) {
    return ApiError.forbidden(
      odata?.code
        ? `Microsoft denied this operation (${odata.code}: ${odata.message ?? 'no detail'}). ` +
          'This usually means a required permission was not granted — reconnect your account.'
        : 'Your Microsoft account has not granted the permissions this action requires. ' +
          'Reconnect your account to grant them.',
      { cause: error, details: diagnostics },
    )
  }

  if (status === 429) {
    return ApiError.tooManyRequests(
      'Microsoft Graph is throttling requests. Please try again shortly.',
      { cause: error },
    )
  }

  return ApiError.serviceUnavailable(
    'Microsoft Graph is currently unavailable. Please try again shortly.',
    { cause: error },
  )
}

/**
 * Fetches the signed-in user's profile from `/me`.
 *
 * @param {string} outlookAccountId
 * @returns {Promise<object>} The raw Graph user resource, limited to PROFILE_FIELDS.
 */
export async function fetchUserProfile(outlookAccountId) {
  return callGraph(outlookAccountId, 'GET /me', (client) =>
    client.api('/me').select(PROFILE_FIELDS.join(',')).get(),
  )
}

/**
 * Verifies the mailbox is actually reachable with the granted permissions.
 *
 * A successful token acquisition only proves the *token* is valid; it does not
 * prove the mailbox can be read. Requesting a single message header is the
 * cheapest call that proves the Mail scopes work end to end, which is what
 * "Outlook connected" needs to mean before Phase 3 relies on it.
 *
 * @param {string} outlookAccountId
 * @returns {Promise<{ reachable: boolean, reason: ?string }>}
 */
export async function verifyMailboxAccess(outlookAccountId) {
  try {
    await callGraph(outlookAccountId, 'GET /me/messages', (client) =>
      client.api('/me/messages').select('id').top(1).get(),
    )
    return { reachable: true, reason: null }
  } catch (error) {
    // Reported rather than thrown: this is a probe, and "not reachable" is a
    // valid answer the status card renders.
    return { reachable: false, reason: error.message }
  }
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/**
 * Sends a message through `POST /me/sendMail`.
 *
 * Graph answers **202 Accepted with an empty body**. That is the whole reason
 * this function cannot return a message id: acceptance means the message was
 * queued for delivery, not that it was delivered, and no identifier is issued
 * at that point. The `client-request-id` returned instead is the correlation
 * handle Microsoft support uses to trace a specific call.
 *
 * `saveToSentItems` is left at Graph's default of true so sent mail appears in
 * the user's own Outlook, which is what someone auditing their mailbox expects.
 *
 * @param {string} outlookAccountId
 * @param {object} message A Graph `message` resource.
 * @param {string} clientRequestId Correlation id echoed into Graph's logs.
 * @returns {Promise<{ clientRequestId: string }>}
 */
export async function sendMailMessage(outlookAccountId, message, clientRequestId) {
  await callGraph(outlookAccountId, 'POST /me/sendMail', (client) =>
    client
      .api('/me/sendMail')
      .header('client-request-id', clientRequestId)
      .post({ message, saveToSentItems: true }),
  )

  return { clientRequestId }
}

/**
 * Creates a draft in the user's mailbox via `POST /me/messages`.
 *
 * Unlike `sendMail` this returns the created resource, so a draft is the one
 * path that yields a real `graphMessageId`. Saving drafts to the mailbox rather
 * than only to Mongo means the user can open and finish one in Outlook — which
 * is what makes it a draft rather than a private scratch copy.
 *
 * @param {string} outlookAccountId
 * @param {object} message A Graph `message` resource.
 * @param {string} clientRequestId
 * @returns {Promise<{ id: ?string, webLink: ?string, clientRequestId: string }>}
 */
export async function createDraftMessage(outlookAccountId, message, clientRequestId) {
  const created = await callGraph(outlookAccountId, 'POST /me/messages', (client) =>
    client.api('/me/messages').header('client-request-id', clientRequestId).post(message),
  )

  return {
    id: created?.id ?? null,
    webLink: created?.webLink ?? null,
    clientRequestId,
  }
}

/**
 * Deletes a message from the mailbox.
 *
 * Used when a locally-stored draft is discarded, so the copy in Outlook goes
 * with it. A 404 is swallowed: the user may have already deleted it there, and
 * failing the request over an object that is gone anyway serves nobody.
 *
 * @param {string} outlookAccountId
 * @param {string} graphMessageId
 * @returns {Promise<boolean>} True when a message was actually removed.
 */
export async function deleteMailMessage(outlookAccountId, graphMessageId) {
  try {
    await callGraph(outlookAccountId, `DELETE /me/messages/${graphMessageId}`, (client) =>
      client.api(`/me/messages/${graphMessageId}`).delete(),
    )
    return true
  } catch (error) {
    // `callGraph` has already normalised this, so the check is on the translated
    // status rather than the SDK's raw shape.
    if (error.statusCode === HTTP_STATUS.NOT_FOUND) return false
    throw error
  }
}

export default {
  createGraphClient,
  fetchUserProfile,
  verifyMailboxAccess,
  sendMailMessage,
  createDraftMessage,
  deleteMailMessage,
  describeGraphError,
}
