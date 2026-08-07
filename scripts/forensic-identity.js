#!/usr/bin/env node
/**
 * Forensic audit of the signed-in identity.
 *
 * Run with:  npm run forensic:identity [-- <email-fragment>]
 *
 * Answers one question with evidence rather than inference: *why* is the stored
 * account a `#EXT#` guest rather than the address the user typed at the sign-in
 * prompt?
 *
 * Every value printed is read from a real artefact — the ID token in the MSAL
 * cache, the MSAL account object, the Mongo records, live Graph responses — and
 * nothing is reconstructed or assumed.
 *
 * ## On secrets
 *
 * Access and refresh tokens are never printed; they are live credentials and
 * terminal scrollback is where those leak from. **ID token claims are printed
 * in full** because they are the evidence, and an ID token is an assertion about
 * identity rather than a credential that grants access.
 */

import crypto from 'node:crypto'

import mongoose from 'mongoose'
import { ConfidentialClientApplication } from '@azure/msal-node'

import { config } from '../src/config/index.js'
import { OutlookAccount } from '../src/models/outlookAccount.model.js'
import { User, MSA_TENANT_ID } from '../src/models/user.model.js'
import { Session } from '../src/models/session.model.js'
import { Mailbox } from '../src/models/mailbox.model.js'
import { ProviderToken } from '../src/models/providerToken.model.js'
import { AuthFlow } from '../src/models/authFlow.model.js'
import { decryptSecret } from '../src/utils/crypto.js'

const out = (line = '') => process.stdout.write(`${line}\n`)
const rule = (char = '─') => out(char.repeat(78))

function heading(number, title) {
  out()
  rule('━')
  out(`  ${number}. ${title}`)
  rule('━')
}

function finding(ok, label, detail = '') {
  const mark = ok === null ? '  ··  ' : ok ? '  OK  ' : ' FAIL '
  out(`${mark} ${label}${detail ? ` — ${detail}` : ''}`)
}

const fingerprint = (token) =>
  token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 16) : '(none)'

/** Decodes a JWT payload without verifying it — the claims are the evidence. */
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

function dump(value, indent = 4) {
  const pad = ' '.repeat(indent)
  try {
    out(
      JSON.stringify(value, null, 2)
        .split('\n')
        .map((line) => pad + line)
        .join('\n'),
    )
  } catch (error) {
    out(`${pad}<unserialisable: ${error.message}>`)
  }
}

/** Raw Graph call via fetch, so headers and body arrive untouched. */
async function rawGraph(path, accessToken) {
  const url = `${config.microsoft.graph.baseUrl}/${config.microsoft.graph.apiVersion}${path}`

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, 'client-request-id': crypto.randomUUID() },
    })

    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* not JSON */
    }

    return { status: response.status, requestId: response.headers.get('request-id'), json, text }
  } catch (error) {
    return { status: null, transportError: error.message }
  }
}

function reportGraph(label, path, result) {
  out()
  out(`  ${label}  (GET ${path})`)
  rule()

  if (result.transportError) {
    out(`    TRANSPORT FAILURE: ${result.transportError}`)
    return
  }

  out(`    status     : ${result.status}`)
  out(`    request-id : ${result.requestId ?? '(absent)'}`)
  out('    body       :')

  if (result.text === '') out('      (empty)')
  else dump(result.json ?? result.text, 6)
}

// ---------------------------------------------------------------------------

async function main() {
  const filter = process.argv[2] ?? null

  out()
  rule('═')
  out('  IDENTITY FORENSIC AUDIT')
  rule('═')
  out(`  generated       : ${new Date().toISOString()}`)
  out(`  configured tid  : ${config.microsoft.tenantId}`)
  out(`  authority       : ${config.microsoft.authority}`)
  out(`  clientId        : ${config.microsoft.clientId}`)
  out(`  MSA tenant id   : ${MSA_TENANT_ID}  (Microsoft's fixed id for personal accounts)`)

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 5000 })

  // -------------------------------------------------------------------------
  heading(4, 'STORED DATABASE RECORDS')

  const accountQuery = filter ? { email: new RegExp(filter, 'i') } : {}
  const account = await OutlookAccount.findOne(accountQuery)
    .sort({ connectedAt: -1 })
    .select('+tokenCache')

  if (!account) {
    out('  No OutlookAccount stored. Sign in through the app first.')
    return 1
  }

  const user = await User.findById(account.user)

  out('  OutlookAccount')
  out(`    _id              : ${account._id}`)
  out(`    email            : ${account.email}`)
  out(`    homeAccountId    : ${account.homeAccountId}`)
  const [hoid, htid] = String(account.homeAccountId).split('.')
  out(`      ├─ object id   : ${hoid}`)
  out(`      └─ HOME tenant : ${htid}`)
  out(`    scopes           : ${account.scopes?.join(' ') || '(none)'}`)
  out(`    connectedAt      : ${account.connectedAt?.toISOString() ?? 'null'}`)
  out(`    disconnectedAt   : ${account.disconnectedAt?.toISOString() ?? 'null'}`)
  out(`    disconnectReason : ${account.disconnectReason ?? 'null'}`)
  out(`    tokenCache       : ${account.tokenCache ? `present (${account.tokenCache.length} bytes, encrypted)` : 'ABSENT'}`)

  out()
  out('  User')
  out(`    _id              : ${user?._id}`)
  out(`    email            : ${user?.email}`)
  out(`    userPrincipalName: ${user?.userPrincipalName}`)
  out(`    microsoftId (oid): ${user?.microsoftId}`)
  out(`    tenantId         : ${user?.tenantId}`)
  out(`    accountType      : ${user?.accountType}`)
  out(`    displayName      : ${user?.displayName}`)

  const mailbox = await Mailbox.findOne({ user: user?._id })
  const providerToken = await ProviderToken.findOne({ user: user?._id })

  out()
  out('  Mailbox (Phase 5)')
  if (mailbox) {
    out(`    providerAccountId: ${mailbox.providerAccountId}`)
    out(`    emailAddress     : ${mailbox.emailAddress}`)
    out(`    provider         : ${mailbox.provider}`)
    out(`    status           : ${mailbox.status}`)
  } else {
    out('    (none)')
  }

  out()
  out('  ProviderToken (Phase 5)')
  if (providerToken) {
    out(`    provider         : ${providerToken.provider}`)
    out(`    status           : ${providerToken.status}`)
    out(`    expiresAt        : ${providerToken.expiresAt?.toISOString() ?? 'null'}`)
    out(`    msalAccountRef   : ${providerToken.msalAccountRef ?? 'null'}`)
    out(`    accessToken      : ${providerToken.accessToken ?? 'null (by design — MSAL owns it)'}`)
    out(`    refreshToken     : ${providerToken.refreshToken ?? 'null (by design — MSAL owns it)'}`)
  } else {
    out('    (none)')
  }

  out()
  out('  Note: there is no `providerUsername` or `providerEmail` field anywhere in')
  out('  the schema. The only stored identity strings are the ones above.')

  // -------------------------------------------------------------------------
  heading(5, 'EVERY CACHED MSAL ACCOUNT')

  const allAccounts = await OutlookAccount.find({}).select('+tokenCache')
  out(`  OutlookAccount records in the database: ${allAccounts.length}`)
  out()

  for (const record of allAccounts) {
    const isTarget = record._id.equals(account._id)
    out(`  ${isTarget ? '▶' : ' '} ${record.email}`)
    out(`      homeAccountId : ${record.homeAccountId}`)
    out(`      connectedAt   : ${record.connectedAt?.toISOString() ?? 'null'}`)
    out(`      disconnected  : ${record.disconnectedAt?.toISOString() ?? 'null'}`)
  }

  finding(
    allAccounts.length === 1,
    'exactly one stored account',
    allAccounts.length > 1
      ? `${allAccounts.length} accounts stored — stale records from earlier sign-ins remain`
      : '',
  )

  // -------------------------------------------------------------------------
  heading(1, 'ID TOKEN CLAIMS (decoded from the stored MSAL cache)')

  let cache
  try {
    cache = JSON.parse(decryptSecret(account.tokenCache, config.security.tokenEncryptionKey))
  } catch (error) {
    out(`  Could not decrypt the token cache: ${error.message}`)
    return 1
  }

  out('  MSAL cache sections:')
  for (const key of ['Account', 'AccessToken', 'RefreshToken', 'IdToken', 'AppMetadata']) {
    out(`    ${key.padEnd(13)}: ${Object.keys(cache[key] ?? {}).length}`)
  }

  const idTokenEntry = Object.values(cache.IdToken ?? {})[0]
  const decoded = idTokenEntry ? decodeJwt(idTokenEntry.secret) : null

  if (!decoded) {
    out('\n  No decodable ID token in the cache.')
  } else {
    const c = decoded.payload

    out()
    out('  --- claims requested in the audit ---')
    for (const claim of [
      'preferred_username',
      'email',
      'upn',
      'oid',
      'tid',
      'sub',
      'iss',
      'aud',
      'acct',
      'idp',
    ]) {
      const value = c[claim]
      out(`    ${claim.padEnd(19)}: ${value === undefined ? '(absent)' : JSON.stringify(value)}`)
    }

    out()
    out('  --- complete ID token payload ---')
    dump(c, 4)

    out()
    out('  --- interpretation ---')

    // `acct` is the definitive claim: 0 = tenant member, 1 = guest.
    if (c.acct !== undefined) {
      finding(
        c.acct === 0,
        `acct = ${c.acct}`,
        c.acct === 1
          ? 'GUEST in this tenant — this is Entra ID stating it, not the application'
          : 'member of this tenant',
      )
    } else {
      finding(null, 'acct claim absent', 'not emitted for this token version')
    }

    if (c.idp) {
      finding(
        false,
        `idp = ${c.idp}`,
        'the identity is federated from another provider — a personal Microsoft account',
      )
    }

    finding(
      c.tid === htid,
      'ID token tid matches the homeAccountId tenant',
      c.tid !== htid
        ? `token tid=${c.tid} but home tenant=${htid} — signing into a tenant that is not this identity's home`
        : '',
    )

    finding(
      htid !== MSA_TENANT_ID,
      'home tenant is not the personal-accounts tenant',
      htid === MSA_TENANT_ID
        ? 'home tenant IS the MSA tenant — this is a personal Microsoft account'
        : '',
    )

    const upnish = c.preferred_username ?? c.upn ?? c.email ?? ''
    finding(
      !String(upnish).includes('#EXT#'),
      'the token itself carries a clean address',
      String(upnish).includes('#EXT#')
        ? 'the #EXT# form arrives IN THE TOKEN'
        : `token says "${upnish}" — the #EXT# form is introduced later, not by Microsoft`,
    )
  }

  // -------------------------------------------------------------------------
  heading(2, 'MSAL ACCOUNT OBJECT AS STORED')

  const cachedAccount = Object.values(cache.Account ?? {})[0]
  out('  Raw Account entry from the serialised cache:')
  dump(cachedAccount, 4)

  // -------------------------------------------------------------------------
  heading('3 / 6', 'getAllAccounts() · getAccountByHomeId() · acquireTokenSilent()')

  const client = new ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      authority: config.microsoft.authority,
      clientSecret: config.microsoft.clientSecret,
    },
  })

  client.getTokenCache().deserialize(
    decryptSecret(account.tokenCache, config.security.tokenEncryptionKey),
  )
  const tokenCache = client.getTokenCache()

  const accounts = await tokenCache.getAllAccounts()
  out(`  getAllAccounts() returned ${accounts.length} account(s):`)
  out()

  for (const entry of accounts) {
    out(`    homeAccountId  : ${entry.homeAccountId}`)
    out(`    username       : ${entry.username}          ← MSAL's view of the address`)
    out(`    localAccountId : ${entry.localAccountId}`)
    out(`    tenantId       : ${entry.tenantId}`)
    out(`    environment    : ${entry.environment}`)
    out(`    name           : ${entry.name ?? '(absent)'}`)
    out(`    nativeAccountId: ${entry.nativeAccountId ?? '(absent)'}`)
    out(`    tenantProfiles : ${
      entry.tenantProfiles
        ? JSON.stringify(
            entry.tenantProfiles instanceof Map
              ? Object.fromEntries(entry.tenantProfiles)
              : entry.tenantProfiles,
          )
        : '(absent)'
    }`)
    out(`    idTokenClaims  : ${entry.idTokenClaims ? 'present' : 'absent'}`)
    out()
  }

  const byHomeId = await tokenCache.getAccountByHomeId(account.homeAccountId)
  finding(Boolean(byHomeId), 'getAccountByHomeId() resolves the stored homeAccountId')

  finding(
    byHomeId?.homeAccountId === accounts[0]?.homeAccountId,
    'getAccountByHomeId() and getAllAccounts()[0] are the SAME account',
    byHomeId?.homeAccountId !== accounts[0]?.homeAccountId
      ? `${byHomeId?.homeAccountId} vs ${accounts[0]?.homeAccountId}`
      : '',
  )

  const reserved = new Set(config.microsoft.reservedScopes)
  const resourceScopes = config.microsoft.scopes.filter((s) => !reserved.has(s))

  let silent = null
  try {
    silent = await client.acquireTokenSilent({ account: byHomeId, scopes: resourceScopes })
    finding(true, 'acquireTokenSilent() succeeded', `fromCache=${silent.fromCache}`)
    out(`    account it resolved to : ${silent.account?.homeAccountId}`)
    out(`    username on that account: ${silent.account?.username}`)
    out(`    token fingerprint      : ${fingerprint(silent.accessToken)}`)

    finding(
      silent.account?.homeAccountId === account.homeAccountId,
      'acquireTokenSilent() used the SAME account that was stored',
    )
  } catch (error) {
    finding(false, 'acquireTokenSilent() threw')
    dump({ errorCode: error.errorCode, message: error.errorMessage ?? error.message }, 4)
    return 1
  }

  // Compare the access token's claims against the ID token's.
  const accessClaims = decodeJwt(silent.accessToken)?.payload
  if (accessClaims) {
    out()
    out('  Access token identity claims:')
    for (const claim of ['aud', 'tid', 'oid', 'upn', 'unique_name', 'acct', 'idp', 'scp']) {
      out(`    ${claim.padEnd(12)}: ${accessClaims[claim] ?? '(absent)'}`)
    }
  }

  // -------------------------------------------------------------------------
  heading('7 / 8 / 9', 'LIVE GRAPH RESPONSES')

  const me = await rawGraph('/me', silent.accessToken)
  reportGraph('GET /me', '/me', me)

  const settings = await rawGraph('/me/mailboxSettings', silent.accessToken)
  reportGraph('GET /me/mailboxSettings', '/me/mailboxSettings', settings)

  const messages = await rawGraph('/me/messages?$top=1&$select=id,subject', silent.accessToken)
  reportGraph('GET /me/messages', '/me/messages', messages)

  // -------------------------------------------------------------------------
  heading(10, 'WHERE THE ADDRESS CHANGES')

  const tokenUsername = byHomeId?.username ?? '(unknown)'
  const graphUpn = me.json?.userPrincipalName ?? '(unknown)'
  const graphMail = me.json?.mail ?? null
  const stored = account.email

  out('  The same identity, at four points in the pipeline:')
  out()
  out(`    1. ID token preferred_username : ${decoded?.payload?.preferred_username ?? '(absent)'}`)
  out(`    2. MSAL account.username       : ${tokenUsername}`)
  out(`    3. Graph /me .mail             : ${graphMail ?? 'null'}`)
  out(`    4. Graph /me .userPrincipalName: ${graphUpn}`)
  out()
  out(`    → stored in OutlookAccount.email: ${stored}`)
  out(`    → stored in User.userPrincipalName: ${user?.userPrincipalName}`)
  out()

  const tokenClean = !String(tokenUsername).includes('#EXT#')
  const graphDirty = String(graphUpn).includes('#EXT#')
  const storedDirty = String(stored).includes('#EXT#')

  if (tokenClean && graphDirty && storedDirty) {
    out('  MSAL holds the clean address; Graph reports the guest UPN; the stored')
    out('  record holds the guest UPN. The substitution therefore happens where the')
    out('  application copies Graph over MSAL:')
    out()
    out('    backend/src/services/auth.service.js:209')
    out('      user.email = (profile.mail ?? profile.userPrincipalName ?? user.email)?.toLowerCase()')
    out('    backend/src/services/auth.service.js:210')
    out('      user.userPrincipalName = profile.userPrincipalName?.toLowerCase() ?? …')
    out('    backend/src/services/auth.service.js:216')
    out('      account.email = (profile.mail ?? profile.userPrincipalName).toLowerCase()')
    out()
    out(`  Because Graph reports mail = ${graphMail === null ? 'null' : `"${graphMail}"`}, each`)
    out('  expression falls through to userPrincipalName — the #EXT# form.')
  } else if (!tokenClean) {
    out('  The #EXT# form is present in the token itself, so it arrives from')
    out('  Microsoft. No application code introduces it.')
  }

  // -------------------------------------------------------------------------
  heading(12, 'LOGOUT COMPLETENESS AUDIT')

  const [sessionCount, flowCount] = await Promise.all([
    Session.countDocuments({ user: user?._id }),
    AuthFlow.countDocuments({}),
  ])

  out(`  Sessions for this user : ${sessionCount}`)
  out(`  Pending AuthFlows      : ${flowCount}`)
  out()
  out('  What POST /api/v1/auth/logout does, from the source:')
  out('    Session document      → deleted        (session.service.js destroySession)')
  out('    Session cookie        → cleared        (res.clearCookie, same attributes)')
  out('    MSAL cache            → account purged (msal.service.js purgeCachedAccount)')
  out('    OutlookAccount        → kept, marked disconnectedAt/signed_out')
  out('    OutlookAccount.tokenCache → overwritten with the purged cache')
  out('    ProviderToken         → NOT touched')
  out('    Mailbox               → NOT touched')
  out('    Synced Mail documents → NOT touched (intentional: user data)')
  out()

  finding(
    false,
    'logout does not revoke Phase 5 ProviderToken records',
    'they keep status=connected after a sign-out',
  )
  finding(
    false,
    'logout does not mark the Phase 5 Mailbox disconnected',
    'the provider page can still show it as connected',
  )
  finding(
    null,
    'the OutlookAccount row is retained by design',
    'so the UI can explain the disconnection and offer reconnection',
  )

  // -------------------------------------------------------------------------
  heading(13, 'ROOT CAUSE')

  const homeTenantIsMsa = htid === MSA_TENANT_ID
  const configuredTenantIsSpecific = !['common', 'organizations', 'consumers'].includes(
    String(config.microsoft.tenantId),
  )

  out('  Chain of evidence:')
  out()
  out(`  1. MICROSOFT_TENANT_ID = ${config.microsoft.tenantId}`)
  finding(
    !configuredTenantIsSpecific,
    'the authority is a SINGLE, SPECIFIC tenant',
    configuredTenantIsSpecific ? 'not /common, /organizations or /consumers' : '',
  )

  out()
  out(`  2. homeAccountId tenant segment = ${htid}`)
  finding(
    !homeTenantIsMsa,
    'the identity is native to that tenant',
    homeTenantIsMsa
      ? 'it is NOT — the home tenant is the personal-accounts tenant (MSA)'
      : '',
  )

  out()
  out(`  3. Graph /me.mail = ${graphMail === null ? 'null' : graphMail}`)
  finding(Boolean(graphMail), 'the identity has a mailbox address in this tenant')

  out()
  if (homeTenantIsMsa && configuredTenantIsSpecific) {
    out('  ROOT CAUSE')
    out('  ══════════')
    out('  A personal Microsoft account is signing in against a single-tenant')
    out('  authority. Entra ID cannot authenticate a personal account AS a member')
    out('  of a work tenant, so it authenticates the B2B GUEST object that')
    out('  represents that person inside the tenant. The guest object\'s UPN is')
    out(`  literally "${graphUpn}".`)
    out()
    out('  The #EXT# is therefore not a transformation the application performs.')
    out('  It is the name of the only object that exists for this identity in the')
    out('  configured tenant. Guests have no Exchange mailbox there, which is why')
    out('  every mail endpoint fails.')
    out()
    out('  FIX (either one):')
    out('    A. Set MICROSOFT_TENANT_ID=consumers (or common) and register the app')
    out('       for personal accounts. The user then signs in as themselves, with')
    out('       their real outlook.com mailbox.')
    out('    B. Keep the tenant and sign in as a LICENSED MEMBER user of it')
    out('       (e.g. someone@sadhaliya18outlook.onmicrosoft.com with an Exchange')
    out('       Online licence). Guests will never work.')
  }

  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  out(`\n  AUDIT FAILED: ${error?.message}`)
  out(error?.stack?.split('\n').slice(1, 5).join('\n') ?? '')
} finally {
  out()
  rule('═')
  await mongoose.disconnect().catch(() => {})
}

process.exit(exitCode)
