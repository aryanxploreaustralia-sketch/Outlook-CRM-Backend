/**
 * Turning a verified Microsoft identity into an **existing** CRM administrator.
 *
 * ## Why this is not `completeSignIn`
 *
 * The legacy Microsoft sign-in in `services/auth.service.js` upserts a `User`
 * keyed on `(tenantId, microsoftId)`. Phase 13.2 disabled it, and the reason is
 * recorded at length in `config/index.js`: every Microsoft account that signed
 * in became *its own CRM user* with its own workspace, so the mailbox registry
 * appeared to change contents depending on which Microsoft account was used.
 * The registry was right; the identity underneath it had changed.
 *
 * Re-enabling that flow to satisfy "administrators sign in with Microsoft"
 * would reintroduce the defect exactly. So this module does the opposite of an
 * upsert: it **never creates a user**. It resolves a verified address to an
 * account that already exists, links the Microsoft identity onto it, and
 * refuses when there is none.
 *
 * The practical consequence is the correct one: an administrator is somebody
 * the CRM already knows — invited through the directory, or already signing in
 * with Google. Microsoft proves who they are; it does not decide who they are.
 *
 * ## Matching, in order
 *
 *   1. `microsoftId` within the tenant — immutable, right for every sign-in
 *      after the first.
 *   2. `microsoftEmail` — the address an **owner explicitly linked** to an
 *      account. This is the one that makes the product a directory: the CRM
 *      knows `aryan@gmail.com` and `enquiry@xploreaustralia.com` are the same
 *      person because somebody said so, not because the strings match.
 *   3. `email` — the same-address case, retained for an account whose primary
 *      address genuinely is its Microsoft one.
 *   4. Bootstrap — the very first owner of an unclaimed organization. Once.
 *
 * ## Why step 3 is no longer the main path
 *
 * Phase 14.8B had only steps 1 and 3, and step 3 could not work here: every
 * account was created by Google sign-in with a `@gmail.com` address, while the
 * Microsoft identities are on `@xploreaustralia.com`. The flow refused a
 * legitimate owner with `no_account`.
 *
 * The mistake was treating an email address as an identity. It is one
 * provider's *name* for a person. Step 2 replaces equality with an explicit
 * link, which is what a directory does.
 *
 * Steps 2 and 3 are only safe because Entra ID verified the address before this
 * module sees it — an unverified address would let somebody claim another
 * person's account by asserting it, so `screenClaims` refuses those upstream.
 *
 * ## What is never written
 *
 * `role` is not touched. Not on link, not on sign-in. Authority inside the CRM
 * is assigned by an administrator through Phase 14.8A's role endpoint and never
 * re-derived from what an identity provider happened to return this morning —
 * which also means a Microsoft directory role can never silently promote
 * somebody here.
 *
 * `OutlookAccount` and every mailbox credential are likewise untouched. This
 * flow proves identity; it requests no mail scopes and stores no token cache.
 */

import {
  AUTH_PROVIDERS,
  MSA_TENANT_ID,
  User,
  classifyAccountType,
} from '../../../models/user.model.js'
import {
  OrganizationBootstrap,
  isBootstrapCompleted,
} from '../../../models/organizationBootstrap.model.js'
import { ROLES } from '../../../constants/roles.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { deriveUserStatus, USER_STATUS } from '../../../constants/userStatus.js'

const log = createContextLogger('admin-identity')

/** Why an admin sign-in was refused. Stable codes the login page renders. */
export const ADMIN_SIGN_IN_ERROR = Object.freeze({
  NO_ACCOUNT: 'no_account',
  /** Bootstrap was needed but another account claimed it first. */
  BOOTSTRAP_TAKEN: 'bootstrap_taken',
  NOT_ADMIN: 'not_admin',
  SUSPENDED: 'suspended',
  UNVERIFIED: 'unverified_email',
  PERSONAL_ACCOUNT: 'personal_account',
  FLOW_INVALID: 'flow_invalid',
  EXCHANGE_FAILED: 'exchange_failed',
})

/**
 * Pulls a usable address out of the ID token claims.
 *
 * `email` first, then `preferred_username`. A guest identity reports its real
 * address in `email` while `preferred_username` is the mangled
 * `alice_outlook.com#EXT#@tenant.onmicrosoft.com` form, so the order matters:
 * reversed, every guest would fail to match their own CRM account.
 */
export function resolveClaimEmail(claims = {}) {
  const candidate = claims.email ?? claims.preferred_username ?? null

  if (!candidate || !String(candidate).includes('@')) return null

  return String(candidate).trim().toLowerCase()
}

/**
 * Applies deployment policy to the claims, before any database read.
 *
 * A request that must be refused is refused without revealing whether an
 * account exists — the refusal is about the claims, not about the directory.
 *
 * @param {object} claims Verified ID-token claims.
 * @returns {{ email: string, tenantId: string, microsoftId: string }}
 */
export function screenClaims(claims) {
  const email = resolveClaimEmail(claims)

  if (!email) {
    throw ApiError.unauthorized('Microsoft did not return a usable email address.', {
      details: { reason: ADMIN_SIGN_IN_ERROR.UNVERIFIED },
    })
  }

  const tenantId = claims.tid ?? null
  const microsoftId = claims.oid ?? claims.sub ?? null

  if (!tenantId || !microsoftId) {
    throw ApiError.unauthorized('Microsoft did not return a complete identity.', {
      details: { reason: ADMIN_SIGN_IN_ERROR.UNVERIFIED },
    })
  }

  /**
   * Personal Microsoft accounts are refused for **administration**.
   *
   * An outlook.com address is not an organisational identity: nobody
   * administers the tenant it belongs to, so it carries none of the assurance
   * that makes "sign in with Microsoft" mean something for an admin portal. It
   * remains perfectly valid for connecting a mailbox, which is a different
   * decision made elsewhere and is not affected by this.
   */
  if (tenantId === MSA_TENANT_ID) {
    throw ApiError.unauthorized(
      'Administrator sign-in requires a work or school account, not a personal Microsoft account.',
      { details: { reason: ADMIN_SIGN_IN_ERROR.PERSONAL_ACCOUNT } },
    )
  }

  return { email, tenantId, microsoftId }
}

/** Refuses an account that cannot sign in, with the reason the page renders. */
function assertCanSignIn(user) {
  const status = deriveUserStatus(user)

  if (status === USER_STATUS.SUSPENDED || status === USER_STATUS.DELETED) {
    throw ApiError.forbidden('This account cannot sign in. Contact an administrator.', {
      details: { reason: ADMIN_SIGN_IN_ERROR.SUSPENDED },
    })
  }
}

/**
 * Finds the CRM user behind a verified Microsoft identity.
 *
 * Never creates one. The absence of an account is a refusal, not a signal to
 * provision — see the header.
 *
 * @param {{ claims: object }} params
 * @returns {Promise<{ user: object, linkedExisting: boolean }>}
 */
export async function resolveAdminUser({ claims }) {
  const { email, tenantId, microsoftId } = screenClaims(claims)

  /**
   * Every lookup below is scoped to live accounts.
   *
   * The mirror of the same scope in `googleIdentity.service.js`, for the same
   * reason: a soft-deleted account keeps its `microsoftId`, `microsoftEmail`
   * and address — its history is preserved — but must not answer for them, or
   * a replacement invited onto the same address could never sign in.
   *
   * `$ne: true` rather than `false`, so documents predating the field still
   * count as live.
   */
  const LIVE = { isDeleted: { $ne: true } }

  // --- 1. A Microsoft identity this CRM has already linked -----------------
  const byMicrosoftId = await User.findOne({ tenantId, microsoftId, ...LIVE })

  if (byMicrosoftId) {
    assertCanSignIn(byMicrosoftId)

    byMicrosoftId.lastLoginAt = new Date()
    byMicrosoftId.lastMicrosoftLoginAt = new Date()
    await byMicrosoftId.save()

    log.info('Admin sign-in matched a linked Microsoft identity', {
      userId: String(byMicrosoftId._id),
      role: byMicrosoftId.role,
    })

    return { user: byMicrosoftId, linkedExisting: false }
  }

  /**
   * Attaches the verified Microsoft identity to an account and signs it in.
   *
   * `role` is deliberately absent. Linking an identity must never change
   * authority — that is the role endpoint's job, and only an owner may use it.
   *
   * `provider` is also left alone: it records how the record was *established*,
   * and for a Google-first account that is still Google. Flipping it would flip
   * `googleId`'s conditional requirement on the next validated save, which is a
   * data-integrity change nobody asked for.
   */
  const attach = async (user, { via }) => {
    assertCanSignIn(user)

    user.microsoftId = microsoftId
    user.tenantId = tenantId
    user.accountType = classifyAccountType(tenantId)
    // Recorded so a later sign-in matches at step 2 even if `microsoftId`
    // changes — and so the console can show which address is linked.
    user.microsoftEmail = email
    user.lastLoginAt = new Date()
    user.lastMicrosoftLoginAt = new Date()

    await user.save()

    log.info('Administrator sign-in resolved a Microsoft identity', {
      userId: String(user._id),
      role: user.role,
      via,
      note: 'role, mailbox links and Google identifiers were preserved',
    })

    return user
  }

  // --- 2. An address an owner explicitly linked ----------------------------
  //
  // The directory path, and the one that makes differing Google and Microsoft
  // addresses work. `microsoftEmail` is set by an owner through the invitation
  // or the link endpoint — never inferred.
  const byLinkedAddress = await User.findOne({ microsoftEmail: email, ...LIVE })

  if (byLinkedAddress) {
    return { user: await attach(byLinkedAddress, { via: 'linked_address' }), linkedExisting: true }
  }

  // --- 3. An account whose primary address *is* this one -------------------
  //
  // Retained from Phase 14.8B for an account established through Microsoft, or
  // one whose owner happens to use the same address with both providers. Not
  // the main path, and no longer required to be.
  const byEmail = await User.findOne({ email, ...LIVE })

  if (byEmail) {
    return { user: await attach(byEmail, { via: 'primary_address' }), linkedExisting: true }
  }

  // --- 4. Bootstrap: claiming an organization that has no owner ------------
  //
  // The one place in the product that creates an administrator, and it can run
  // exactly once. Both conditions must hold:
  //
  //   * no active owner exists — the organization is genuinely unadministered;
  //   * bootstrap has never completed — recorded durably, so suspending every
  //     owner later cannot re-open this door.
  //
  // The count alone would re-open. The marker alone would refuse a legitimate
  // first install if the collection were ever cleared. Together they say
  // "unclaimed, and never previously claimed".
  const [completed, activeOwners] = await Promise.all([
    isBootstrapCompleted(),
    User.countDocuments({ role: ROLES.OWNER, isActive: true, isDeleted: { $ne: true } }),
  ])

  if (!completed && activeOwners === 0) {
    return { user: await bootstrapFirstOwner({ email, tenantId, microsoftId }), bootstrapped: true }
  }

  // --- 5. Nobody -----------------------------------------------------------
  //
  // Refused, never provisioned. An unknown Microsoft identity does not become a
  // user, an admin or an owner — the organization is already claimed and its
  // owners decide who else gets in.
  log.warn('Administrator sign-in refused: no CRM account holds that Microsoft identity', {
    email,
    bootstrapCompleted: completed,
    activeOwners,
  })

  throw ApiError.forbidden(
    'No organization access. Contact an existing Organization Owner to be invited.',
    { details: { reason: ADMIN_SIGN_IN_ERROR.NO_ACCOUNT } },
  )
}

/**
 * Creates the first owner of an unclaimed organization.
 *
 * The single exception to "never auto-create an owner", and it is not really an
 * exception: an organization with no owner cannot invite anybody, so without
 * one installation step there is no way in at all. It is the installation, and
 * it happens once.
 *
 * ## The marker is written first
 *
 * `OrganizationBootstrap` has a unique index on a constant field, so a second
 * insert fails at the database. Writing it *before* the user means two
 * simultaneous first sign-ins cannot both create an owner: the loser's insert
 * is rejected and it falls through to the ordinary refusal. Creating the user
 * first and the marker second would leave the reverse — two owners and one
 * marker — which is the outcome that actually matters to prevent.
 */
async function bootstrapFirstOwner({ email, tenantId, microsoftId }) {
  const user = new User({
    provider: AUTH_PROVIDERS.MICROSOFT,
    microsoftId,
    tenantId,
    microsoftEmail: email,
    email,
    userPrincipalName: email,
    displayName: email,
    accountType: classifyAccountType(tenantId),
    role: ROLES.OWNER,
    isActive: true,
    lastLoginAt: new Date(),
    lastMicrosoftLoginAt: new Date(),
  })

  try {
    await OrganizationBootstrap.create({
      owner: user._id,
      ownerEmail: email,
      microsoftEmail: email,
      tenantId,
    })
  } catch (error) {
    // A duplicate key means another sign-in claimed the organization between
    // our check and this insert. Refuse rather than create a second owner.
    if (error?.code === 11_000) {
      log.warn('Bootstrap lost a race: the organization was claimed concurrently', { email })

      throw ApiError.forbidden(
        'This organization has just been claimed by another account. Ask them to invite you.',
        { details: { reason: ADMIN_SIGN_IN_ERROR.BOOTSTRAP_TAKEN } },
      )
    }

    throw error
  }

  await user.save()

  log.warn('ORGANIZATION BOOTSTRAP: the first owner has been created', {
    userId: String(user._id),
    email,
    tenantId,
    note: 'This can only happen once. Every later owner must be invited.',
  })

  return user
}

export default { resolveAdminUser, screenClaims, ADMIN_SIGN_IN_ERROR }
