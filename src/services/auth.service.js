/**
 * Authentication orchestration.
 *
 * Sequences the OAuth 2.0 authorization-code flow with PKCE across MSAL, Graph,
 * the data models and the session store. Controllers call into this module and
 * deal only with HTTP concerns.
 */

import { config } from '../config/index.js'
import { AUTH_FLOW_PURPOSE, AuthFlow } from '../models/authFlow.model.js'
import { OutlookAccount } from '../models/outlookAccount.model.js'
import { AUTH_PROVIDERS, classifyAccountType, MSA_TENANT_ID, User } from '../models/user.model.js'
import { ApiError } from '../utils/ApiError.js'
import { createPkcePair, encryptSecret, generateOpaqueToken } from '../utils/crypto.js'
import { createContextLogger } from '../utils/logger.js'
import { buildAuthorizationUrl, redeemAuthorizationCode } from './msal.service.js'
import { fetchUserProfile } from './graph.service.js'

const log = createContextLogger('auth')


/**
 * Sanitises a caller-supplied post-login destination.
 *
 * Only same-site absolute paths are permitted. Returning an attacker-controlled
 * absolute URL would make the callback an open redirect — a credible phishing
 * vector, because the link genuinely starts at this application's domain.
 *
 * Protocol-relative values such as `//evil.com` are rejected too: a browser
 * treats them as absolute.
 *
 * @param {unknown} value
 * @returns {?string}
 */
export function sanitiseReturnPath(value) {
  if (typeof value !== 'string' || value === '') return null
  if (!value.startsWith('/')) return null
  if (value.startsWith('//')) return null
  if (value.includes('\\')) return null

  return value
}

/**
 * Begins a sign-in flow.
 *
 * @param {object} params
 * @param {import('express').Request} params.req
 * @param {?string} params.returnPath
 * @returns {Promise<{ authorizationUrl: string, state: string }>}
 */
export async function beginSignIn({ req, returnPath = null }) {
  const state = generateOpaqueToken(32)
  const { codeVerifier, codeChallenge } = createPkcePair()

  // Persisted before the redirect, so the callback can only succeed for a flow
  // this server actually started.
  await AuthFlow.create({
    state,
    codeVerifier,
    returnPath: sanitiseReturnPath(returnPath),
    expiresAt: new Date(Date.now() + config.session.authFlowTtlMs),
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  })

  const authorizationUrl = await buildAuthorizationUrl({ state, codeChallenge })

  log.info('Sign-in flow started', { requestId: req.id })

  return { authorizationUrl, state }
}

/**
 * Consumes a stored flow, verifying the `state` parameter.
 *
 * `findOneAndDelete` makes consumption atomic: two concurrent callbacks carrying
 * the same state cannot both succeed, which prevents authorization-code replay.
 *
 * @param {string} state
 * @returns {Promise<import('mongoose').Document>}
 */
async function consumeAuthFlow(state) {
  const flow = await AuthFlow.findOneAndDelete({ state })

  if (!flow) {
    throw ApiError.unauthorized(
      'This sign-in link is invalid or has already been used. Please start again.',
    )
  }

  if (flow.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('This sign-in attempt expired. Please start again.')
  }

  /**
   * A mailbox flow may not be redeemed as a sign-in.
   *
   * This function did not check the purpose, and both flows return to the same
   * redirect URI — so a "Connect Microsoft mailbox" click arrived at the
   * sign-in callback, was consumed here, and `completeSignIn` went on to upsert
   * a `User` from the Microsoft claims and open a session as it. That is the
   * mechanism by which authorising a mailbox created a CRM user.
   *
   * The callback now dispatches on purpose before reaching this code, so this
   * is defence in depth rather than the primary guard — which is the right
   * place for it, because the primary guard is one `if` somebody could later
   * reorder, and this refusal is unconditional.
   */
  if (flow.purpose !== AUTH_FLOW_PURPOSE.SIGN_IN) {
    log.warn('Refused to redeem a mailbox authorisation flow as a sign-in', {
      purpose: flow.purpose,
    })

    throw ApiError.unauthorized(
      'That link authorises a mailbox, not a sign-in. Connect mailboxes from the Account page.',
    )
  }

  return flow
}

/**
 * `consumeAuthFlow`, exposed for the verification harness.
 *
 * Exported rather than making the function itself public, so the only supported
 * caller in application code remains `completeSignIn`. The guarantee being
 * verified — that a mailbox authorisation flow cannot be redeemed as a sign-in —
 * is worth an explicit test, and testing it through `completeSignIn` would
 * require a live Microsoft token exchange.
 *
 * @param {string} state
 */
export const consumeAuthFlowForTest = (state) => consumeAuthFlow(state)

/**
 * Reads the tenant and object id out of an MSAL account.
 *
 * `homeAccountId` is formatted `<oid>.<tenantId>`, but the id-token claims are
 * used where available because they are authoritative.
 *
 * @param {import('@azure/msal-node').AccountInfo} account
 */
function extractIdentity(account) {
  const claims = account.idTokenClaims ?? {}
  const [oidPart, tenantPart] = String(account.homeAccountId ?? '').split('.')

  const microsoftId = claims.oid ?? oidPart ?? null
  const tenantId = claims.tid ?? tenantPart ?? account.tenantId ?? null

  /**
   * The tenant this identity actually belongs to, which is not always `tid`.
   *
   * When a personal Microsoft account signs in against a single-tenant
   * authority, Entra ID authenticates the B2B guest object representing that
   * person inside the tenant. `tid` is then the *resource* tenant, while the
   * second segment of `homeAccountId` remains the identity's real home — the
   * fixed MSA tenant for a personal account.
   *
   * Classifying on `tid` would therefore label a personal account
   * `work_or_school`, which is both wrong and misleading in the UI.
   */
  const homeTenantId = tenantPart ?? tenantId

  if (!microsoftId || !tenantId) {
    throw ApiError.internal(
      'Microsoft did not return the account identifiers required to create a user record.',
    )
  }

  return { microsoftId, tenantId, homeTenantId }
}

/** Guest UPNs minted by B2B collaboration, e.g. `alice_contoso.com#EXT#@fabrikam.onmicrosoft.com`. */
const GUEST_UPN_PATTERN = /#EXT#@/i

/** How the signed-in identity was resolved by Entra ID. */
export const IDENTITY_KIND = Object.freeze({
  /** A personal Microsoft account authenticated as itself. Has an outlook.com mailbox. */
  CONSUMER: 'consumer',
  /** A member of the tenant the app is registered against. */
  MEMBER: 'member',
  /** A B2B guest object standing in for an identity whose home is elsewhere. */
  GUEST: 'guest',
})

/**
 * Explains which identity Entra ID actually returned, and why.
 *
 * The `#EXT#` failure was hard to diagnose precisely because the log said
 * nothing about *which* of three very different outcomes had occurred. All
 * three authenticate successfully and yield a valid token; only one of them can
 * send mail. This turns that distinction into a single structured statement.
 *
 * The reasoning is entirely derived from evidence already in hand — the ID
 * token's issuer and tenant, the home tenant embedded in `homeAccountId`, and
 * Graph's own `mail` / `userPrincipalName`. Nothing is inferred from
 * configuration alone.
 *
 * @param {object} params
 * @returns {{ kind: string, reason: string, mailboxExpected: boolean, evidence: object }}
 */
export function classifySignInIdentity({
  claims = {},
  homeTenantId,
  graphMail,
  graphUpn,
  msalUsername,
}) {
  const isGuestUpn = GUEST_UPN_PATTERN.test(graphUpn ?? '')
  const homeIsPersonal = homeTenantId === MSA_TENANT_ID
  const tokenTid = claims.tid ?? null

  const evidence = {
    configuredAuthority: config.microsoft.authority,
    configuredTenantId: config.microsoft.tenantId,
    issuer: claims.iss ?? null,
    tokenTenantId: tokenTid,
    homeTenantId,
    homeTenantIsPersonalAccounts: homeIsPersonal,
    preferredUsername: claims.preferred_username ?? null,
    msalUsername: msalUsername ?? null,
    graphMail: graphMail ?? null,
    graphUserPrincipalName: graphUpn ?? null,
    identityProvider: claims.idp ?? null,
  }

  if (isGuestUpn) {
    return {
      kind: IDENTITY_KIND.GUEST,
      mailboxExpected: false,
      reason: homeIsPersonal
        ? `A personal Microsoft account (home tenant ${MSA_TENANT_ID}) signed in against ` +
          `authority "${config.microsoft.authority}". Entra ID cannot authenticate a personal ` +
          'account as a member of a work tenant, so it returned the B2B guest object that ' +
          'represents it there. Guests hold no Exchange mailbox, so every mail operation will ' +
          'fail with a bodyless 401. Sign in choosing "Personal account", or set ' +
          'MICROSOFT_TENANT_ID=common.'
        : `A work or school account whose home tenant is ${homeTenantId} signed in against ` +
          `tenant ${tokenTid}. It exists there only as an invited guest, which has no mailbox ` +
          'in that tenant.',
      evidence,
    }
  }

  if (homeIsPersonal) {
    return {
      kind: IDENTITY_KIND.CONSUMER,
      // Personal accounts report `mail: null` from Graph even when the mailbox
      // is real, so its absence is not evidence of a missing mailbox here.
      mailboxExpected: true,
      reason:
        'A personal Microsoft account authenticated as itself through the consumer endpoint. ' +
        `The issuer is ${claims.iss ?? 'unknown'} and the home tenant is the personal-accounts ` +
        'tenant, so this is the real outlook.com identity and its mailbox is addressable.',
      evidence,
    }
  }

  return {
    kind: IDENTITY_KIND.MEMBER,
    mailboxExpected: Boolean(graphMail),
    reason:
      `A member of tenant ${tokenTid} authenticated directly. A mailbox exists only if the ` +
      'account holds an Exchange Online licence; Graph reports ' +
      (graphMail ? `mail="${graphMail}", so it does.` : 'mail=null, so it may not.'),
    evidence,
  }
}

/**
 * Chooses the address to display for an account.
 *
 * ## Why this is not simply `profile.mail ?? profile.userPrincipalName`
 *
 * For a B2B guest, Graph reports `mail: null` and a `userPrincipalName` of the
 * form `alice_outlook.com#EXT#@tenant.onmicrosoft.com`. That string is the name
 * of the guest *object* inside the tenant — it is not an address, nothing can be
 * delivered to it, and the user has never seen it before.
 *
 * Meanwhile the ID token's `preferred_username` and MSAL's `account.username`
 * both carry the address the person actually typed at the sign-in prompt. A
 * naive fallback chain discards the good value in favour of the useless one,
 * purely because `mail` happened to be null.
 *
 * Preference order:
 *   1. `profile.mail`            — a real, routable mailbox address.
 *   2. MSAL `account.username`   — what the user signed in as.
 *   3. `preferred_username`      — the same value, from the raw claims.
 *   4. `profile.userPrincipalName` — only if it is not a guest UPN.
 *   5. the guest UPN             — last resort, so a record is never left blank.
 *
 * @param {object} params
 * @returns {?string} Lower-cased, or null when nothing usable was supplied.
 */
export function resolveDisplayAddress({ graphMail, msalUsername, preferredUsername, graphUpn }) {
  const candidates = [graphMail, msalUsername, preferredUsername, graphUpn]

  for (const candidate of candidates) {
    const value = candidate?.trim()
    if (!value) continue
    if (GUEST_UPN_PATTERN.test(value)) continue
    return value.toLowerCase()
  }

  // Everything available is a guest UPN. Kept rather than nulled so the record
  // still identifies the account, but it is deliberately the last choice.
  return graphUpn?.trim().toLowerCase() ?? null
}

/**
 * Completes a sign-in flow: redeems the code, stores tokens, opens a session.
 *
 * @param {object} params
 * @param {string} params.code
 * @param {string} params.state
 * @returns {Promise<{ user: object, account: object, returnPath: ?string }>}
 */
export async function completeSignIn({ code, state }) {
  const flow = await consumeAuthFlow(state)

  const { result, serialisedCache } = await redeemAuthorizationCode({
    code,
    codeVerifier: flow.codeVerifier,
  })

  const { microsoftId, tenantId, homeTenantId } = extractIdentity(result.account)
  const claims = result.account.idTokenClaims ?? {}

  /**
   * The address the user signed in as, before Graph has been consulted.
   *
   * Captured here because it is the most trustworthy value available: it comes
   * from the ID token, and for a guest identity it is the *only* place the
   * user's real address appears.
   */
  const signInAddress = resolveDisplayAddress({
    graphMail: null,
    msalUsername: result.account.username,
    preferredUsername: claims.preferred_username,
    graphUpn: null,
  })

  // Upsert keyed on tenant + object id so signing in again updates the existing
  // record instead of creating a duplicate.
  const user = await User.findOneAndUpdate(
    { tenantId, microsoftId },
    {
      $set: {
        displayName: result.account.name ?? claims.name ?? null,
        email: claims.email ?? signInAddress,
        userPrincipalName: signInAddress,
        // Classified on the HOME tenant, not `tid`. A personal account signing
        // into a work tenant reports `tid` as that work tenant, and classifying
        // on it would mislabel the account as work/school.
        accountType: classifyAccountType(homeTenantId),
        provider: AUTH_PROVIDERS.MICROSOFT,
        lastLoginAt: new Date(),
      },
      // `role` is deliberately absent from $set: it is assigned once on insert
      // and must never be reset by a subsequent sign-in.
      $setOnInsert: { tenantId, microsoftId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )

  const encryptedCache = encryptSecret(serialisedCache, config.security.tokenEncryptionKey)

  const account = await OutlookAccount.findOneAndUpdate(
    { homeAccountId: result.account.homeAccountId },
    {
      $set: {
        user: user._id,
        email: signInAddress ?? user.email ?? null,
        tokenCache: encryptedCache,
        scopes: result.scopes ?? [],
        accessTokenExpiresAt: result.expiresOn ?? null,
        // Reconnecting clears any previous failure state.
        disconnectedAt: null,
        disconnectReason: null,
        connectedAt: new Date(),
      },
      $setOnInsert: { homeAccountId: result.account.homeAccountId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )

  // Enrich the record from Graph. Deliberately non-fatal: sign-in has already
  // succeeded, and failing here would strand a user who holds valid tokens.
  try {
    const profile = await fetchUserProfile(account._id.toString())

    /**
     * Graph enriches, but must not *downgrade*.
     *
     * The previous version read
     *   `profile.mail ?? profile.userPrincipalName ?? user.email`
     * which looks reasonable and is wrong for any guest identity: Graph reports
     * `mail: null` for a guest, so the chain fell through to the guest UPN
     * (`alice_outlook.com#EXT#@tenant.onmicrosoft.com`) and overwrote the
     * correct address that the ID token had already supplied.
     *
     * `resolveDisplayAddress` keeps the ordering explicit, so a null `mail` no
     * longer promotes a guest UPN over the address the user signed in with.
     */
    const bestAddress = resolveDisplayAddress({
      graphMail: profile.mail,
      msalUsername: result.account.username,
      preferredUsername: claims.preferred_username,
      graphUpn: profile.userPrincipalName,
    })

    user.displayName = profile.displayName ?? user.displayName
    user.email = bestAddress ?? user.email
    user.userPrincipalName = bestAddress ?? user.userPrincipalName
    user.jobTitle = profile.jobTitle ?? null
    user.preferredLanguage = profile.preferredLanguage ?? null
    await user.save()

    if (bestAddress) {
      account.email = bestAddress
      await account.save()
    }

    /**
     * State which identity Entra ID returned, and why, on every sign-in.
     *
     * Logged unconditionally rather than only on failure: knowing that a
     * sign-in produced a *consumer* identity is exactly as diagnostic as
     * knowing it produced a guest, and the healthy case is what a later
     * regression would be measured against.
     */
    const identity = classifySignInIdentity({
      claims,
      homeTenantId,
      graphMail: profile.mail,
      graphUpn: profile.userPrincipalName,
      msalUsername: result.account.username,
    })

    const payload = {
      userId: user._id.toString(),
      accountId: account._id.toString(),
      identityKind: identity.kind,
      reason: identity.reason,
      mailboxExpected: identity.mailboxExpected,
      resolvedAddress: bestAddress,
      homeAccountId: result.account.homeAccountId,
      ...identity.evidence,
    }

    if (identity.kind === IDENTITY_KIND.GUEST) {
      log.warn('Sign-in resolved to a GUEST identity — mail operations will fail', payload)
    } else if (!identity.mailboxExpected) {
      log.warn('Sign-in resolved to an identity with no addressable mailbox', payload)
    } else {
      log.info(`Sign-in resolved to a ${identity.kind.toUpperCase()} identity`, payload)
    }
  } catch (error) {
    log.warn('Could not enrich the user profile from Microsoft Graph after sign-in', {
      message: error.message,
    })
  }

  log.info('Sign-in completed', {
    userId: user._id.toString(),
    accountId: account._id.toString(),
  })

  return { user, account, returnPath: flow.returnPath }
}

export default {
  beginSignIn,
  completeSignIn,
  sanitiseReturnPath,
}
