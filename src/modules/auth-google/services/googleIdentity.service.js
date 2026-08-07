/**
 * Turning a verified Google identity into a CRM user.
 *
 * The only module in this phase that writes to `User`, and it holds no
 * cryptography — `googleOAuth.service.js` has already proved the claims are
 * genuine by the time anything here runs. The separation means the account
 * rules below can be read and argued about without also reading a JWT verifier.
 *
 * ## The matching rule, and why email comes first
 *
 * Two keys, applied in order:
 *
 *   1. `googleId` — the `sub` claim. Immutable, and the right key for every
 *      sign-in after the first.
 *   2. `email` — used only when no `googleId` matches, to satisfy the brief's
 *      "one CRM account per email" rule.
 *
 * Step 2 is what makes the migration from Microsoft sign-in seamless: a person
 * who has been signing in with `ada@contoso.com` through Entra ID and now signs
 * in with Google as `ada@contoso.com` lands on **their existing CRM account**,
 * keeping their role, their leads and their history. A `googleId` is stamped
 * onto that record, and every later sign-in matches on it directly.
 *
 * Matching on email is only safe because the address has been *verified by
 * Google* before this module sees it. An unverified address is refused
 * upstream, precisely so that this lookup cannot be used to claim somebody
 * else's CRM account by asserting their address.
 *
 * ## What is deliberately not touched
 *
 * `role` is never written after insert. A user's authority in the CRM is
 * assigned once and changed by an administrator, never silently re-derived from
 * whatever an identity provider happened to return this morning. This mirrors
 * the Microsoft path exactly, where `role` is kept out of `$set` for the same
 * reason.
 *
 * `microsoftId`, `tenantId` and any connected `OutlookAccount` are likewise
 * never modified here. Google authenticates the person; it has no authority
 * over their mailbox, and Phase 13.2 depends on that boundary holding.
 */

import { AUTH_PROVIDERS, User, defaultRoleForNewAccount } from '../../../models/user.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { config } from '../../../config/index.js'
import { GOOGLE_AUTH_ERROR } from '../constants/googleAuth.constants.js'

const log = createContextLogger('google-auth')

/**
 * Applies the deployment's account policy to a set of verified claims.
 *
 * Runs before any database lookup: a request that must be refused should be
 * refused without writing anything or revealing whether an account exists.
 *
 * @param {object} claims  Verified ID-token claims.
 * @returns {{ email: string, domain: string }}
 */
export function screenClaims(claims) {
  const email = String(claims.email ?? '').trim().toLowerCase()

  if (!email) {
    throw ApiError.forbidden(
      'Google did not return an email address for this account, so a CRM user cannot be identified.',
      { code: GOOGLE_AUTH_ERROR.NO_EMAIL },
    )
  }

  /**
   * Verification is mandatory and non-negotiable.
   *
   * `email_verified: false` means Google is reporting an address the account
   * holder has *claimed* but not proved. Accepting it would let anyone create
   * a Google account asserting a colleague's address and — through the
   * email-matching rule above — walk directly into that colleague's CRM
   * account. This single check is what makes email matching safe.
   */
  if (claims.email_verified !== true) {
    throw ApiError.forbidden(
      'Google has not verified this email address. Verify it with Google and try again.',
      { code: GOOGLE_AUTH_ERROR.EMAIL_NOT_VERIFIED },
    )
  }

  const domain = email.slice(email.lastIndexOf('@') + 1)
  const allowed = config.google.allowedDomains

  if (allowed.length > 0) {
    /**
     * Checked against both the verified email domain and the `hd` claim.
     *
     * `hd` is present only for Workspace accounts and is the stronger signal,
     * but a consumer Gmail address has no `hd` at all — so the email domain is
     * checked too. Requiring only `hd` would lock out a deployment that
     * legitimately allows `gmail.com`.
     */
    const hostedDomain = String(claims.hd ?? '').trim().toLowerCase()
    const permitted = allowed.some(
      (candidate) => candidate.toLowerCase() === domain || candidate.toLowerCase() === hostedDomain,
    )

    if (!permitted) {
      log.warn('Google sign-in refused: domain not allowed', { domain, hostedDomain })

      throw ApiError.forbidden(
        `Accounts on "${domain}" cannot sign in to this CRM. Use your work Google account.`,
        { code: GOOGLE_AUTH_ERROR.DOMAIN_NOT_ALLOWED },
      )
    }
  }

  return { email, domain }
}

/** Turns the model's sign-in verdict into the right HTTP failure. */
function assertCanSignIn(user) {
  const verdict = user.canSignIn()
  if (verdict.allowed) return

  log.warn('Google sign-in refused for a blocked account', {
    userId: String(user._id),
    reason: verdict.reason,
  })

  throw ApiError.forbidden(
    verdict.reason === 'account_deleted'
      ? 'This CRM account has been removed. Contact an administrator.'
      : 'This CRM account is not active. Contact an administrator.',
    {
      code:
        verdict.reason === 'account_deleted'
          ? GOOGLE_AUTH_ERROR.ACCOUNT_DELETED
          : GOOGLE_AUTH_ERROR.ACCOUNT_INACTIVE,
    },
  )
}

/**
 * Copies the display fields an identity provider legitimately owns.
 *
 * Names and avatars change, and the provider is the authority on them. Nothing
 * that carries authority inside the CRM — role, active state, mailbox links —
 * is in this list.
 */
function applyProfile(user, { claims, email }) {
  user.googleId = claims.sub
  user.email = email
  user.displayName = claims.name ?? user.displayName ?? email
  user.avatarUrl = claims.picture ?? user.avatarUrl ?? null
  user.lastLoginAt = new Date()

  /**
   * Phase 14.8B: which provider it was, alongside when.
   *
   * `lastLoginAt` keeps its existing meaning — the most recent sign-in through
   * any provider — so nothing that reads it changes. This records that *this*
   * one was Google, which is what lets the profile show both timestamps for an
   * account reachable through either.
   */
  user.lastGoogleLoginAt = new Date()

  /**
   * `userPrincipalName` is filled only when the record has none.
   *
   * For a user who originally signed in through Entra ID it holds their
   * Microsoft sign-in name, which is still the truth about their mailbox.
   * Overwriting it with a Google address would corrupt the one field that
   * explains which Microsoft identity the account belongs to — and Phase 13.2
   * needs that intact.
   */
  if (!user.userPrincipalName) user.userPrincipalName = email
}

/**
 * Finds or creates the CRM user behind a verified Google identity.
 *
 * @param {{ claims: object }} params
 * @returns {Promise<{ user: object, isNew: boolean, linkedExisting: boolean }>}
 */
export async function resolveGoogleUser({ claims }) {
  const { email } = screenClaims(claims)

  // --- 1. Known Google identity -------------------------------------------
  const byGoogleId = await User.findOne({ googleId: claims.sub })

  if (byGoogleId) {
    assertCanSignIn(byGoogleId)
    applyProfile(byGoogleId, { claims, email })
    await byGoogleId.save()

    log.info('Google sign-in matched an existing Google identity', {
      userId: String(byGoogleId._id),
      role: byGoogleId.role,
    })

    return { user: byGoogleId, isNew: false, linkedExisting: false }
  }

  // --- 2. Existing CRM account with the same verified address --------------
  const byEmail = await User.findOne({ email })

  if (byEmail) {
    assertCanSignIn(byEmail)

    const previousProvider = byEmail.provider
    applyProfile(byEmail, { claims, email })

    /**
     * `provider` is left alone when the account already has a Microsoft
     * identity.
     *
     * It records how the record was *established*, and for these users that is
     * still Microsoft — their `microsoftId`, `tenantId` and mailbox all remain
     * valid and are what Phase 13.2 will build on. Flipping it to `google`
     * would also flip `microsoftId` from required to optional on the next
     * validated save, which is a data-integrity change nobody asked for.
     */
    if (!byEmail.microsoftId) byEmail.provider = AUTH_PROVIDERS.GOOGLE

    await byEmail.save()

    log.info('Google sign-in linked to an existing CRM account by verified email', {
      userId: String(byEmail._id),
      previousProvider,
      role: byEmail.role,
      note: 'role, mailbox links and Microsoft identifiers were preserved',
    })

    return { user: byEmail, isNew: false, linkedExisting: true }
  }

  // --- 3. A person the CRM has never seen ----------------------------------
  //
  // `role` is now set **explicitly**, and this is the Phase 14.8A fix.
  //
  // It used to be omitted so the schema default applied — and that default is
  // `owner`, a backfill rule for documents written before the field existed.
  // The effect was that anybody whose Google account passed domain screening
  // became an owner of the whole deployment on their first sign-in, which is
  // the situation the brief opens with. `defaultRoleForNewAccount()` gives the
  // very first account owner (nobody exists to grant it otherwise) and everyone
  // after that viewer, to be promoted deliberately.
  const role = await defaultRoleForNewAccount()

  let user
  try {
    user = await User.create({
      provider: AUTH_PROVIDERS.GOOGLE,
      googleId: claims.sub,
      email,
      role,
      displayName: claims.name ?? email,
      avatarUrl: claims.picture ?? null,
      userPrincipalName: email,
      lastLoginAt: new Date(),
      lastGoogleLoginAt: new Date(),
    })
  } catch (error) {
    /**
     * Two browser tabs completing sign-in at the same instant.
     *
     * The unique partial index on `googleId` is what actually prevents the
     * duplicate; this turns the loser of that race into the read it should
     * have been. Falling through to a hard error would show a confusing
     * failure for a sign-in that had, in fact, succeeded.
     */
    if (error?.code === 11_000) {
      const existing = await User.findOne({ googleId: claims.sub })
      if (existing) {
        assertCanSignIn(existing)
        return { user: existing, isNew: false, linkedExisting: false }
      }
    }
    throw error
  }

  log.info('Google sign-in created a new CRM user', {
    userId: String(user._id),
    role: user.role,
  })

  return { user, isNew: true, linkedExisting: false }
}

export default { resolveGoogleUser, screenClaims }
