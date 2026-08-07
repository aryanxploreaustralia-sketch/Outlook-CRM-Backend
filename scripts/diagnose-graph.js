#!/usr/bin/env node
/**
 * End-to-end diagnostic for the Microsoft Graph token path.
 *
 * Run with:  npm run diagnose:graph [-- <mailbox-email>]
 *
 * Answers the question a translated `ApiError` cannot: *why* did Graph reject
 * this token? It walks the whole chain — stored cache, MSAL account, silent
 * acquisition, token claims, and two live Graph calls — printing the raw,
 * untranslated response at every step.
 *
 * ## On secrets
 *
 * Access tokens are NOT printed. A Graph access token is a live bearer
 * credential: anything that can read this output could act as the user until it
 * expires, and terminal scrollback and CI logs are exactly where such things
 * leak from. Claims are printed in full — they are what diagnoses the problem —
 * and each token is identified by a SHA-256 fingerprint, which is sufficient to
 * prove whether two calls used the same token.
 *
 * Exit code is 0 when the mailbox can send, 1 otherwise.
 */

import crypto from 'node:crypto'

import mongoose from 'mongoose'
import { ConfidentialClientApplication } from '@azure/msal-node'

import { config } from '../src/config/index.js'
import { OutlookAccount } from '../src/models/outlookAccount.model.js'
import { decryptSecret } from '../src/utils/crypto.js'

const out = (line = '') => process.stdout.write(`${line}\n`)

const rule = (char = '─') => out(char.repeat(78))

function heading(number, title) {
  out()
  rule('━')
  out(`  ${number}. ${title}`)
  rule('━')
}

/** Marks a check as pass/fail/info without relying on colour alone. */
function verdict(ok, label, detail = '') {
  const mark = ok === null ? '  ·  ' : ok ? ' PASS' : ' FAIL'
  out(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}

/** Identifies a token without exposing it. */
const fingerprint = (token) =>
  token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 16) : '(none)'

/**
 * Decodes a JWT payload without verifying it.
 *
 * Verification is Microsoft's job and irrelevant here — the question is what
 * this token *claims*, which is what determines whether Graph will accept it.
 */
function decodeJwt(token) {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3) return null

  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
    }
  } catch {
    return null
  }
}

const asTime = (seconds) =>
  typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : '(absent)'

/** Serialises anything, including Errors, without throwing. */
function dump(value, indent = 4) {
  const pad = ' '.repeat(indent)
  try {
    const text =
      value instanceof Error
        ? JSON.stringify(
          {
            name: value.name,
            message: value.message,
            errorCode: value.errorCode,
            errorMessage: value.errorMessage,
            subError: value.subError,
            statusCode: value.statusCode ?? value.status,
            code: value.code,
            body: value.body,
            requestId: value.requestId,
            correlationId: value.correlationId,
            stack: value.stack?.split('\n').slice(0, 4),
          },
          null,
          2,
        )
        : JSON.stringify(value, null, 2)

    out(text.split('\n').map((line) => pad + line).join('\n'))
  } catch (error) {
    out(`${pad}<unserialisable: ${error.message}>`)
  }
}

/**
 * Performs a raw Graph call with `fetch`.
 *
 * Deliberately bypasses the Graph SDK. The SDK normalises the response into a
 * `GraphError` and discards the headers — including `request-id`, which is the
 * only value Microsoft support can act on. This returns everything, untouched.
 */
async function rawGraphCall(method, path, accessToken, body) {
  const clientRequestId = crypto.randomUUID()
  const url = `${config.microsoft.graph.baseUrl}/${config.microsoft.graph.apiVersion}${path}`

  const started = Date.now()

  let response
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'client-request-id': clientRequestId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    return { transportError: error, clientRequestId, url, method }
  }

  const text = await response.text()

  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* not JSON — the raw text is reported instead */
  }

  return {
    url,
    method,
    clientRequestId,
    status: response.status,
    statusText: response.statusText,
    latencyMs: Date.now() - started,
    headers: Object.fromEntries(response.headers.entries()),
    rawBody: text,
    json: parsed,
  }
}

/** Prints a raw Graph result in full, with the identifiers called out. */
function reportGraphCall(label, result) {
  out()
  out(`  ${label}`)
  rule()

  if (result.transportError) {
    out('    TRANSPORT FAILURE — the request never reached Graph.')
    dump(result.transportError)
    return
  }

  out(`    ${result.method} ${result.url}`)
  out(`    status            : ${result.status} ${result.statusText}`)
  out(`    latency           : ${result.latencyMs}ms`)
  out(`    client-request-id : ${result.clientRequestId}`)
  out(`    request-id        : ${result.headers['request-id'] ?? '(absent)'}`)
  out(`    x-ms-ags-diagnostic: ${result.headers['x-ms-ags-diagnostic'] ?? '(absent)'}`)
  out(`    www-authenticate  : ${result.headers['www-authenticate'] ?? '(absent)'}`)

  out()
  out('    --- response headers (complete) ---')
  dump(result.headers, 4)

  out()
  out('    --- response body (raw, untranslated) ---')
  if (result.rawBody === '') {
    out('    (empty body — expected for a 202 Accepted from sendMail)')
  } else {
    dump(result.json ?? result.rawBody, 4)
  }

  const graphError = result.json?.error
  if (graphError) {
    out()
    out('    --- error detail ---')
    out(`    error.code       : ${graphError.code ?? '(absent)'}`)
    out(`    error.message    : ${graphError.message ?? '(absent)'}`)
    out(`    innerError       :`)
    dump(graphError.innerError ?? null, 6)
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const requestedEmail = process.argv[2] ?? null

  out()
  rule('═')
  out('  MICROSOFT GRAPH TOKEN DIAGNOSTIC')
  rule('═')
  out(`  generated : ${new Date().toISOString()}`)
  out(`  authority : ${config.microsoft.authority}`)
  out(`  clientId  : ${config.microsoft.clientId}`)
  out(`  tenantId  : ${config.microsoft.tenantId}`)
  out(`  graph     : ${config.microsoft.graph.baseUrl}/${config.microsoft.graph.apiVersion}`)
  out(`  scopes    : ${config.microsoft.scopes.join(' ')}`)

  if (!config.microsoft.enabled) {
    out()
    out('  Microsoft authentication is not configured. Nothing to diagnose.')
    return 1
  }

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 5000 })

  // -------------------------------------------------------------------------
  heading(5, 'STORED ACCOUNT OBJECT')

  const query = requestedEmail ? { email: requestedEmail.toLowerCase() } : {}
  const account = await OutlookAccount.findOne(query)
    .sort({ connectedAt: -1 })
    .select('+tokenCache')

  if (!account) {
    out(
      requestedEmail
        ? `  No Outlook account stored for "${requestedEmail}".`
        : '  No Outlook account is stored. Sign in through the app first.',
    )
    return 1
  }

  out(`  _id                  : ${account._id}`)
  out(`  homeAccountId        : ${account.homeAccountId}`)
  out(`  username (email)     : ${account.email}`)
  out(`  tenantId (from hAId) : ${account.homeAccountId?.split('.')[1] ?? '(unparseable)'}`)
  out(`  scopes (granted)     : ${account.scopes?.join(' ') || '(none recorded)'}`)
  out(`  accessTokenExpiresAt : ${account.accessTokenExpiresAt?.toISOString() ?? '(null)'}`)
  out(`  connectedAt          : ${account.connectedAt?.toISOString() ?? '(null)'}`)
  out(`  disconnectedAt       : ${account.disconnectedAt?.toISOString() ?? '(null)'}`)
  out(`  disconnectReason     : ${account.disconnectReason ?? '(null)'}`)

  verdict(
    account.disconnectedAt === null,
    'connection is not latched-disconnected',
    account.disconnectedAt ? `latched: ${account.disconnectReason}` : '',
  )

  const grantedScopes = (account.scopes ?? []).map((s) => s.toLowerCase())
  verdict(
    grantedScopes.some((s) => s.endsWith('mail.send')),
    'Mail.Send present in the scopes Entra ID actually granted',
    grantedScopes.length ? '' : 'no scopes recorded — sign in again',
  )

  // -------------------------------------------------------------------------
  heading(1, 'DECRYPTED MSAL TOKEN CACHE')

  let serialisedCache
  try {
    serialisedCache = decryptSecret(account.tokenCache, config.security.tokenEncryptionKey)
    verdict(true, 'token cache decrypted', `${serialisedCache.length} bytes`)
  } catch (error) {
    verdict(false, 'token cache could not be decrypted')
    dump(error)
    out('\n  TOKEN_ENCRYPTION_KEY has changed since this cache was written.')
    return 1
  }

  const cache = JSON.parse(serialisedCache)
  const sections = ['Account', 'AccessToken', 'RefreshToken', 'IdToken', 'AppMetadata']
  for (const key of sections) {
    const entries = Object.keys(cache[key] ?? {})
    out(`  ${key.padEnd(13)}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
  }

  // The cached access token's own metadata explains whether MSAL *should* have
  // considered it usable.
  for (const [key, entry] of Object.entries(cache.AccessToken ?? {})) {
    out()
    out(`  AccessToken[${key}]`)
    out(`    target      : ${entry.target}`)
    out(`    expires_on  : ${asTime(Number(entry.expires_on))}`)
    out(`    cached_at   : ${asTime(Number(entry.cached_at))}`)
    const expired = Number(entry.expires_on) * 1000 <= Date.now()
    out(`    expired now : ${expired ? 'YES' : 'no'}`)
  }

  verdict(
    Object.keys(cache.RefreshToken ?? {}).length > 0,
    'a refresh token is present in the cache',
    'without one, silent renewal is impossible',
  )

  // -------------------------------------------------------------------------
  heading(6, 'acquireTokenSilent()')

  const client = new ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      authority: config.microsoft.authority,
      clientSecret: config.microsoft.clientSecret,
    },
  })

  client.getTokenCache().deserialize(serialisedCache)
  const tokenCache = client.getTokenCache()

  const msalAccount = await tokenCache.getAccountByHomeId(account.homeAccountId)

  if (!msalAccount) {
    verdict(false, 'MSAL account found in cache', `homeAccountId ${account.homeAccountId}`)
    out('\n  The cache does not contain this account. Re-authentication required.')
    return 1
  }

  verdict(true, 'MSAL account found in cache')
  out(`    homeAccountId    : ${msalAccount.homeAccountId}`)
  out(`    username         : ${msalAccount.username}`)
  out(`    localAccountId   : ${msalAccount.localAccountId}`)
  out(`    tenantId         : ${msalAccount.tenantId}`)
  out(`    environment      : ${msalAccount.environment}`)
  out(`    idTokenClaims.tid: ${msalAccount.idTokenClaims?.tid ?? '(absent)'}`)
  out(`    idTokenClaims.aud: ${msalAccount.idTokenClaims?.aud ?? '(absent)'}`)

  // Mirrors msal.service.js exactly: reserved OIDC scopes are invalid in a
  // silent request, so the same filter must apply here or the diagnostic would
  // be testing a different call than production makes.
  const reserved = new Set(config.microsoft.reservedScopes)
  const resourceScopes = config.microsoft.scopes.filter((scope) => !reserved.has(scope))
  out()
  out(`  requesting scopes  : ${resourceScopes.join(' ')}`)

  let silentResult = null
  try {
    silentResult = await client.acquireTokenSilent({
      account: msalAccount,
      scopes: resourceScopes,
    })
    verdict(true, 'acquireTokenSilent succeeded')
  } catch (error) {
    verdict(false, 'acquireTokenSilent threw')
    out('\n    --- complete exception ---')
    dump(error)
    out('\n  Sending cannot work until this is resolved.')
    return 1
  }

  // -------------------------------------------------------------------------
  heading(3, 'TOKEN SOURCE (cache vs refresh)')

  out(`  fromCache        : ${silentResult.fromCache}`)
  out(`  source           : ${silentResult.fromCache ? 'CACHE (no network call)' : 'REFRESH TOKEN (network round trip to Entra ID)'}`)
  out(`  tokenType        : ${silentResult.tokenType}`)
  out(`  expiresOn        : ${silentResult.expiresOn?.toISOString() ?? '(none)'}`)
  out(`  extExpiresOn     : ${silentResult.extExpiresOn?.toISOString() ?? '(none)'}`)
  out(`  scopes returned  : ${(silentResult.scopes ?? []).join(' ')}`)
  out(`  correlationId    : ${silentResult.correlationId ?? '(none)'}`)
  out(`  token fingerprint: ${fingerprint(silentResult.accessToken)}`)

  // -------------------------------------------------------------------------
  heading(4, 'FORCED REFRESH')

  out('  Re-requesting with forceRefresh:true to exercise the refresh path')
  out('  explicitly, and to prove the client receives the NEW token (task 7).')
  out()

  let refreshedResult = null
  try {
    refreshedResult = await client.acquireTokenSilent({
      account: msalAccount,
      scopes: resourceScopes,
      forceRefresh: true,
    })
    verdict(true, 'forced refresh succeeded')
    out(`    fromCache        : ${refreshedResult.fromCache} (false proves the network path ran)`)
    out(`    expiresOn        : ${refreshedResult.expiresOn?.toISOString()}`)
    out(`    token fingerprint: ${fingerprint(refreshedResult.accessToken)}`)
    verdict(
      refreshedResult.accessToken !== silentResult.accessToken,
      'refresh produced a DIFFERENT token than the cached one',
      refreshedResult.accessToken === silentResult.accessToken
        ? 'identical — Entra ID returned the same token'
        : '',
    )
  } catch (error) {
    verdict(false, 'forced refresh threw — the refresh token is not usable')
    out('\n    --- complete exception ---')
    dump(error)
  }

  const activeToken = refreshedResult?.accessToken ?? silentResult.accessToken

  // -------------------------------------------------------------------------
  heading(2, 'ACCESS TOKEN CLAIMS')

  const decoded = decodeJwt(activeToken)

  if (!decoded) {
    verdict(false, 'access token is a decodable JWT')
    out('  The token is opaque or malformed. Graph tokens are normally readable JWTs.')
  } else {
    out('  --- header ---')
    dump(decoded.header, 4)

    const claims = decoded.payload
    out()
    out('  --- claims required by the brief ---')
    out(`  aud   : ${claims.aud ?? '(absent)'}`)
    out(`  iss   : ${claims.iss ?? '(absent)'}`)
    out(`  tid   : ${claims.tid ?? '(absent)'}`)
    out(`  scp   : ${claims.scp ?? '(absent)'}`)
    out(`  roles : ${claims.roles ? JSON.stringify(claims.roles) : '(absent — expected for delegated flow)'}`)
    out(`  exp   : ${claims.exp} → ${asTime(claims.exp)}`)
    out(`  iat   : ${claims.iat} → ${asTime(claims.iat)}`)

    out()
    out('  --- additional claims worth seeing ---')
    out(`  appid : ${claims.appid ?? claims.azp ?? '(absent)'}`)
    out(`  ver   : ${claims.ver ?? '(absent)'}`)
    out(`  upn   : ${claims.upn ?? '(absent)'}`)
    out(`  nbf   : ${asTime(claims.nbf)}`)
    out(`  idtyp : ${claims.idtyp ?? '(absent)'}`)

    out()
    out('  --- verification ---')

    const audience = String(claims.aud ?? '')
    const audienceOk =
      audience === 'https://graph.microsoft.com' ||
      audience === '00000003-0000-0000-c000-000000000000'
    verdict(
      audienceOk,
      'aud is Microsoft Graph',
      audienceOk ? audience : `got "${audience}" — this token is for a DIFFERENT resource`,
    )

    const scopeList = String(claims.scp ?? '').split(/\s+/).filter(Boolean)
    const hasMailSend = scopeList.some((s) => s.toLowerCase() === 'mail.send')
    verdict(
      hasMailSend,
      'Mail.Send present in scp',
      hasMailSend ? '' : `scp contains: ${scopeList.join(', ') || '(nothing)'}`,
    )

    verdict(
      claims.tid === config.microsoft.tenantId ||
      config.microsoft.tenantId === 'common' ||
      config.microsoft.tenantId === 'organizations',
      'tid matches the configured tenant',
      claims.tid !== config.microsoft.tenantId ? `token tid=${claims.tid}` : '',
    )

    const secondsLeft = (claims.exp ?? 0) - Math.floor(Date.now() / 1000)
    verdict(
      secondsLeft > 0,
      'token is not expired',
      secondsLeft > 0 ? `${Math.floor(secondsLeft / 60)} minutes remaining` : `expired ${-secondsLeft}s ago`,
    )

    const appidOk = (claims.appid ?? claims.azp) === config.microsoft.clientId
    verdict(appidOk, 'appid matches MICROSOFT_CLIENT_ID', appidOk ? '' : 'token issued to a different app')
  }

  // -------------------------------------------------------------------------
  heading(8, 'LIVE GRAPH CALLS — GET /me vs POST /me/sendMail')

  out(`  Both calls use the same token: ${fingerprint(activeToken)}`)
  out('  Any difference in outcome is therefore about the OPERATION, not the token.')

  const meResult = await rawGraphCall('GET', '/me', activeToken)
  reportGraphCall('CALL A — GET /me', meResult)

  const selfAddress =
    meResult.json?.mail ?? meResult.json?.userPrincipalName ?? account.email ?? null

  out()
  out(`  Send target: ${selfAddress ?? '(unknown)'} (sending to self — safe to repeat)`)

  const sendResult = await rawGraphCall('POST', '/me/sendMail', activeToken, {
    message: {
      subject: `Graph diagnostic ${new Date().toISOString()}`,
      body: { contentType: 'HTML', content: '<p>Diagnostic probe. Safe to delete.</p>' },
      toRecipients: [{ emailAddress: { address: selfAddress } }],
    },
    saveToSentItems: false,
  })
  reportGraphCall('CALL B — POST /me/sendMail', sendResult)

  // -------------------------------------------------------------------------
  heading('8b', 'MAILBOX EXISTENCE PROBE')

  out('  A valid token that reads /me but cannot send points at the mailbox,')
  out('  not the token: /me is Entra ID directory data and exists for every')
  out('  identity, whereas /me/sendMail needs an Exchange Online mailbox behind')
  out('  it. These probes separate the two.')

  const identity = await rawGraphCall(
    'GET',
    '/me?$select=id,displayName,mail,userPrincipalName,userType,proxyAddresses,accountEnabled',
    activeToken,
  )

  out()
  out('  --- identity ---')
  if (identity.status === 200) {
    const me = identity.json ?? {}
    out(`    userType         : ${me.userType ?? '(not returned)'}`)
    out(`    mail             : ${me.mail ?? 'null  ← no primary SMTP address'}`)
    out(`    userPrincipalName: ${me.userPrincipalName}`)
    out(`    proxyAddresses   : ${JSON.stringify(me.proxyAddresses ?? [])}`)

    const upn = String(me.userPrincipalName ?? '')
    const isGuest = me.userType === 'Guest' || upn.includes('#EXT#')
    verdict(
      !isGuest,
      'account is a member of this tenant (not a guest)',
      isGuest ? 'GUEST / #EXT# — external identities have no mailbox in this tenant' : '',
    )
    verdict(
      Boolean(me.mail),
      'account has a primary SMTP address',
      me.mail ? '' : 'mail is null — nothing to send from',
    )
  } else {
    out(`    probe failed with ${identity.status}`)
    dump(identity.json ?? identity.rawBody, 4)
  }

  for (const [label, path] of [
    ['mailbox settings', '/me/mailboxSettings'],
    ['message list', '/me/messages?$top=1&$select=id'],
    ['mail folders', '/me/mailFolders?$top=1&$select=id'],
  ]) {
    const probe = await rawGraphCall('GET', path, activeToken)
    const code = probe.json?.error?.code ?? null

    out()
    out(`  --- ${label} (${path}) ---`)
    out(`    status : ${probe.status}`)
    out(`    code   : ${code ?? '(none)'}`)
    if (probe.status !== 200) {
      out(`    body   : ${probe.rawBody === '' ? '(empty)' : probe.rawBody.slice(0, 400)}`)
    } else {
      out('    result : reachable')
    }
  }

  // -------------------------------------------------------------------------
  heading(9, 'VERDICT')

  const meOk = meResult.status === 200
  const sendOk = sendResult.status === 202

  verdict(meOk, `GET /me returned ${meResult.status}`)
  verdict(sendOk, `POST /me/sendMail returned ${sendResult.status}`, sendOk ? '' : 'expected 202')
  verdict(true, 'both calls used an identical token', fingerprint(activeToken))

  const sendError = sendResult.json?.error

  if (sendOk) {
    out()
    out('  The mailbox CAN send. If the application still fails, the fault is')
    out('  between the app and this path — not in the token or the mailbox.')
  } else if (sendResult.status === 401 && !sendError && meOk) {
    // The signature of "no mailbox": directory data reads fine, every Exchange
    // endpoint returns 401 with nothing in the body.
    out()
    out('  ROOT CAUSE: this account has no Exchange Online mailbox.')
    out()
    out('  The evidence, in order:')
    out('    · the access token is valid — correct aud, Mail.Send in scp, unexpired;')
    out('    · the SAME token reads GET /me successfully (200);')
    out('    · every Exchange endpoint returns 401 with an EMPTY body and no')
    out('      www-authenticate header — not how a rejected token is reported;')
    out('    · /me returns mail: null and no proxyAddresses.')
    out()
    out('  A rejected token produces a JSON body with an error code. A bodyless')
    out('  401 from Exchange means it would not route to a mailbox, because the')
    out('  identity does not have one. Re-authenticating cannot fix this.')
    out()
    out('  FIX: sign in with an account that owns a Microsoft 365 mailbox —')
    out('  a licensed member user, not a guest/#EXT# identity.')
  } else if (sendError) {
    out()
    out(`  Graph error code: ${sendError.code}`)
    out()

    const guidance = {
      InvalidAuthenticationToken:
        'The token was rejected outright. Check `aud` above — if it is not\n' +
        '  https://graph.microsoft.com the token was minted for another resource.',
      ErrorAccessDenied:
        'The token is valid but lacks Mail.Send, or the mailbox denies SendAs.\n' +
        '  Compare the `scp` claim above against the granted permissions.',
      ErrorSendAsDenied:
        'The account may not send as this address. An administrator controls this.',
      MailboxNotEnabledForRESTAPI:
        'This mailbox is not a Microsoft 365 mailbox that Graph can send from.\n' +
        '  Personal outlook.com accounts and on-premises mailboxes hit this.',
      ErrorInvalidUser: 'The mailbox does not exist or is not licensed.',
      ErrorItemNotFound: 'Mailbox provisioning is incomplete.',
      ErrorInvalidRecipients: 'One or more recipient addresses were rejected.',
    }[sendError.code]

    out(`  ${guidance ?? 'No specific guidance for this code — the raw body above is authoritative.'}`)
  }

  return sendOk ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  out('\n  DIAGNOSTIC ITSELF FAILED — this is a bug in the tool, not your setup:')
  dump(error, 2)
} finally {
  out()
  rule('═')
  await mongoose.disconnect().catch(() => { })
}

process.exit(exitCode)
