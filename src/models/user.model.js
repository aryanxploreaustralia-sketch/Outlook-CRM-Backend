/**
 * User model.
 *
 * Represents a person who has signed in with a Microsoft work, school or
 * personal account. This is the CRM's own identity record; it deliberately
 * mirrors only the claims needed to identify and display a user, not the whole
 * Microsoft Graph profile.
 *
 * There are no passwords. Authentication is delegated entirely to Microsoft
 * Entra ID, so this collection holds no credentials of any kind.
 */

import mongoose from 'mongoose'

import { GENDER_VALUES } from '../constants/employeeProfile.js'
import { ROLE_LABELS, ROLES, ROLE_VALUES } from '../constants/roles.js'
import { USER_STATUS, USER_STATUS_VALUES } from '../constants/userStatus.js'

const { Schema } = mongoose

/**
 * The fixed tenant id Microsoft uses for all personal (MSA) accounts.
 * A `tid` claim matching this means an outlook.com/hotmail.com account rather
 * than a work or school account.
 */
export const MSA_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad'

/**
 * Identity providers this CRM can authenticate against.
 *
 * `provider` records **who proved the person is who they say they are**, and
 * nothing else. It is not a statement about mail: a user authenticated by
 * Google can still have a Microsoft mailbox connected to their workspace, and
 * from Phase 13.2 onwards that is the expected arrangement. The two concerns
 * are stored separately — identity here, mailbox credentials on
 * `OutlookAccount` — and must stay that way.
 */
export const AUTH_PROVIDERS = Object.freeze({
  MICROSOFT: 'microsoft',
  /** Phase 13.1. Identity only — Google never sends mail for this CRM. */
  GOOGLE: 'google',
})

/** Microsoft account categories. */
export const ACCOUNT_TYPES = Object.freeze({
  WORK_OR_SCHOOL: 'work_or_school',
  PERSONAL: 'personal',
})

/**
 * Classifies an account from its tenant id.
 *
 * @param {?string} tenantId
 * @returns {string} One of ACCOUNT_TYPES.
 */
export function classifyAccountType(tenantId) {
  return tenantId === MSA_TENANT_ID ? ACCOUNT_TYPES.PERSONAL : ACCOUNT_TYPES.WORK_OR_SCHOOL
}

/**
 * The role a brand-new account should receive.
 *
 * ## Why the first account is different
 *
 * A deployment with no users has nobody who can grant a role, so the first
 * person through the door must be an owner or the console can never be
 * administered. Every subsequent account gets `VIEWER` — the least authority
 * that still permits signing in — and is promoted deliberately by somebody who
 * already holds the power to do it.
 *
 * This is the fix for "every account is effectively Owner". Before it, the
 * schema default applied to every insert, so anybody whose Google account
 * passed domain screening became an owner of the whole deployment.
 *
 * Racy by nature: two people completing their first sign-in in the same instant
 * could both see an empty collection and both become owners. Accepted, and
 * preferable to the alternative — a lock on the user collection taken on every
 * sign-in, forever, to guard a condition that is true once in a deployment's
 * lifetime. The outcome of losing the race is two owners, which is recoverable
 * through the role screen; the outcome of the lock failing is nobody can sign
 * in at all.
 *
 * @returns {Promise<string>}
 */
export async function defaultRoleForNewAccount() {
  const existing = await mongoose.model('User').estimatedDocumentCount()

  return existing === 0 ? ROLES.OWNER : ROLES.VIEWER
}

const userSchema = new Schema(
  {
    /**
     * The immutable object id (`oid`) from the Microsoft token.
     *
     * This is the correct join key, not the email address. A user's mail and
     * userPrincipalName can both change — after a name change or a domain
     * migration — while `oid` never does.
     */
    microsoftId: {
      /**
       * Required for a Microsoft-authenticated user, absent for a Google one.
       *
       * A function rather than `true` so the rule follows the provider instead
       * of the collection. `provider` defaults to `microsoft`, so every
       * existing document and every existing code path is validated exactly as
       * before — the condition only relaxes for records that declare
       * themselves Google.
       */
      type: String,
      required() {
        return this.provider === AUTH_PROVIDERS.MICROSOFT
      },
      trim: true,
      index: true,
    },

    /** Entra ID tenant the account belongs to. Microsoft identities only. */
    tenantId: {
      type: String,
      required() {
        return this.provider === AUTH_PROVIDERS.MICROSOFT
      },
      trim: true,
      index: true,
    },

    /**
     * The immutable `sub` claim from a verified Google ID token.
     *
     * The correct join key for a Google identity, for the same reason `oid` is
     * for Microsoft: an address can change hands or be renamed, `sub` cannot.
     * Email is used to *find* an existing CRM account on first Google sign-in —
     * the brief's "one CRM account per email" rule — but `googleId` is what
     * identifies the person on every sign-in afterwards.
     */
    googleId: {
      type: String,
      trim: true,
      default: null,
    },

    /**
     * The Microsoft address this account signs in with (Phase 14.8C).
     *
     * ## Why this is separate from `email`
     *
     * Until this phase, administrator sign-in matched the Microsoft verified
     * address against `email` — and `email` is the *Google* address for every
     * account created by the employee flow. In this deployment the two are on
     * different domains entirely (`aryan@gmail.com` versus
     * `enquiry@xploreaustralia.com`), so the match could never succeed and the
     * flow refused a legitimate owner with `no_account`.
     *
     * Requiring the addresses to be equal was the underlying mistake. It treats
     * an email address as an identity, when it is only *one provider's name*
     * for a person. A directory records that one human has two provider
     * identities; it does not demand they be spelled the same.
     *
     * So this field holds the Microsoft name, `email` holds the primary one,
     * and they are related by an explicit link made by an owner — never by
     * string equality.
     *
     * Null on every existing document, which is correct: none of them has had a
     * Microsoft identity linked. Nothing reads it except the administrator
     * sign-in lookup and the linking endpoint.
     */
    microsoftEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    /** Profile picture URL from the identity provider. Display only. */
    avatarUrl: {
      type: String,
      trim: true,
      default: null,
    },

    displayName: {
      type: String,
      trim: true,
      default: null,
    },

    /** Primary SMTP address reported by Graph. May be null for some accounts. */
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
      index: true,
    },

    /** Sign-in name, e.g. `ada@contoso.com`. */
    userPrincipalName: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    jobTitle: { type: String, trim: true, default: null },

    // --- Employee profile (Phase 17.1) --------------------------------------
    //
    // Every field is optional with a null default, so all five existing
    // accounts read back unchanged and nothing that reads a `User` today sees
    // a shape it does not recognise.
    //
    // These live on `User` rather than in a side collection because they are
    // one-to-one with the account and are read on almost every screen that
    // shows a person. `UserDocument` is separate precisely because it is
    // one-to-many and is read rarely — the split follows cardinality and
    // access, not tidiness.

    phone: { type: String, trim: true, default: null, maxlength: 32 },

    /**
     * The organization's own identifier for this person.
     *
     * Sparse-unique: two employees must not share one, but the overwhelming
     * majority of rows have none and a plain unique index would collide on
     * every null after the first.
     */
    employeeId: { type: String, trim: true, default: null, maxlength: 64 },

    department: { type: String, trim: true, default: null, maxlength: 128 },
    designation: { type: String, trim: true, default: null, maxlength: 128 },

    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: [...GENDER_VALUES, null], default: null },

    address: {
      line1: { type: String, trim: true, default: null, maxlength: 256 },
      line2: { type: String, trim: true, default: null, maxlength: 256 },
      city: { type: String, trim: true, default: null, maxlength: 128 },
      state: { type: String, trim: true, default: null, maxlength: 128 },
      country: { type: String, trim: true, default: null, maxlength: 128 },
      postalCode: { type: String, trim: true, default: null, maxlength: 32 },
    },

    emergencyContact: {
      name: { type: String, trim: true, default: null, maxlength: 128 },
      phone: { type: String, trim: true, default: null, maxlength: 32 },
      relationship: { type: String, trim: true, default: null, maxlength: 64 },
    },

    /**
     * Relative path under `config.storage.documents`, never an absolute one and
     * never the bytes. Same rule the attachment store follows — a path that
     * escapes the storage root is rejected at write time.
     */
    profilePhoto: { type: String, trim: true, default: null, maxlength: 512 },

    /**
     * When they joined. Read-only to the employee, set by an administrator.
     *
     * Falls back to `createdAt` on read when unset, which is the closest thing
     * to the truth for an account nobody has filled in.
     */
    joiningDate: { type: Date, default: null },

    /** Locale reported by Graph, used later for message formatting. */
    preferredLanguage: { type: String, trim: true, default: null },

    /**
     * What this account may do. Enforced everywhere since Phase 14.4.
     *
     * ## The default is `owner`, and that is a backfill rule, not a policy
     *
     * It exists so documents written before this field read back as owners
     * rather than `undefined`, which would fail the enum on their next
     * validated save.
     *
     * It is emphatically **not** what a new account should get. Phase 14.8B
     * moved that decision to `defaultRoleForNewAccount()` below, which the
     * sign-in flows call explicitly. Leaving the schema default to decide it
     * meant every person who completed a Google sign-in became an owner of the
     * whole deployment — the situation the Phase 14.8A brief opens with.
     *
     * Changing this default instead would have been the wrong fix: it is load
     * bearing for existing documents, and a migration that rewrote five
     * accounts' roles is not something a schema default should do silently.
     */
    role: {
      type: String,
      enum: ROLE_VALUES,
      default: ROLES.OWNER,
    },

    /**
     * Identity provider that authenticated this user.
     *
     * Fixed to `microsoft` today, but stored rather than assumed so a second
     * provider can be added later without a migration.
     */
    provider: {
      type: String,
      enum: Object.values(AUTH_PROVIDERS),
      default: AUTH_PROVIDERS.MICROSOFT,
    },

    /** Whether this is a work/school or a personal Microsoft account. */
    accountType: {
      type: String,
      enum: Object.values(ACCOUNT_TYPES),
      default: ACCOUNT_TYPES.WORK_OR_SCHOOL,
    },

    lastLoginAt: { type: Date, default: null },

    /**
     * Per-provider sign-in timestamps (Phase 14.8B).
     *
     * `lastLoginAt` is the most recent sign-in through *any* provider and keeps
     * its existing meaning — nothing that reads it changes. These two record
     * which provider it was, which is what makes the profile able to say "you
     * signed in with Google this morning and with Microsoft last week".
     *
     * Null on every existing document, and that is the honest value: the CRM
     * genuinely did not record it before, and back-filling `lastLoginAt` into
     * one of them would invent a fact about which provider was used.
     */
    /**
     * Soft-delete provenance (Phase 15.2).
     *
     * `isDeleted` already existed and is what sign-in checks; these two record
     * *when* and *by whom*, which is the difference between a flag and an
     * account of what happened. Null on every existing document, including any
     * that were already soft-deleted before this phase — the honest value,
     * since the CRM genuinely did not record it.
     */
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    lastGoogleLoginAt: { type: Date, default: null },
    lastMicrosoftLoginAt: { type: Date, default: null },

    /**
     * Whether this account may sign in.
     *
     * Defaults to true so every document written before this field existed —
     * and every future Microsoft sign-in, which never sets it — reads back as
     * active. Suspending somebody is therefore an explicit act, never a side
     * effect of the field being introduced.
     */
    isActive: { type: Boolean, default: true },

    /**
     * Soft deletion.
     *
     * Kept rather than removing the row, because sessions, leads, audit entries
     * and import jobs all reference a user by id. A hard delete would leave
     * those pointing at nothing.
     */
    isDeleted: { type: Boolean, default: false },

    // -----------------------------------------------------------------------
    // Phase 14.3A — enterprise directory.
    //
    // Every field below is additive and defaulted, so a document written before
    // this phase validates and reads back exactly as it did. Nothing here is
    // consulted by authentication: `canSignIn()` and the Google identity flow
    // still read `isActive` and `isDeleted`, and `constants/userStatus.js`
    // documents the invariant that keeps `status` in step with them.
    // -----------------------------------------------------------------------

    /**
     * Lifecycle state: invited, active, suspended or disabled.
     *
     * Defaults to `active` so a Microsoft or Google sign-in that has never
     * heard of this field creates a usable account, exactly as before. Records
     * that predate the field have no value at all — `deriveUserStatus()` reads
     * those from the booleans rather than trusting this default, because a
     * schema default is applied on create and not on read.
     */
    status: {
      type: String,
      enum: USER_STATUS_VALUES,
      default: USER_STATUS.ACTIVE,
      index: true,
    },

    /** Who created the invitation. Null for accounts that self-registered. */
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    invitedAt: { type: Date, default: null },

    /** Free text an administrator left when inviting. Display only. */
    inviteNotes: { type: String, trim: true, default: null, maxlength: 512 },

    /**
     * When and by whom the status last changed.
     *
     * One pair rather than a timestamp per transition: the directory shows the
     * *current* state and how it came about, and a row of mostly-null
     * `activatedAt` / `suspendedAt` / `reactivatedAt` columns answers that
     * question worse. This is also the extension point audit recording will
     * read from when it arrives.
     */
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/**
 * A Microsoft identity is only globally unique when tenant and object id are
 * combined — `oid` alone is unique within a tenant, not across them.
 *
 * ## Why this is now partial
 *
 * A Google-authenticated user has neither field. MongoDB indexes an absent
 * field as null, so a plain unique compound index would admit the *first*
 * Google user and reject every one after it with a duplicate-key error on
 * `(null, null)` — a failure that would only appear once a second person tried
 * to sign in.
 *
 * The filter restricts the constraint to documents that actually carry a
 * Microsoft object id, which is exactly the set it was written to protect. For
 * every Microsoft user the behaviour is identical to before.
 *
 * NOTE: changing an existing index's options requires dropping the old one —
 * MongoDB rejects a redefinition in place. Run `npm run migrate:google-index`
 * once per environment. Until it is run, the old index remains and a *second*
 * Google-only user cannot be created; Microsoft sign-in is unaffected either
 * way.
 */
userSchema.index(
  { tenantId: 1, microsoftId: 1 },
  { unique: true, partialFilterExpression: { microsoftId: { $type: 'string' } } },
)

/**
 * One CRM account per Google identity.
 *
 * Partial for the mirror-image reason: every Microsoft-only user has a null
 * `googleId`, and without the filter they would all collide with each other.
 */
userSchema.index(
  { googleId: 1 },
  { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } },
)

/**
 * One Microsoft address may claim at most one CRM account.
 *
 * Partial, so the null on every un-linked account does not collide — the same
 * pattern `googleId` uses above and for the same reason. Without it, an owner
 * could link `enquiry@xploreaustralia.com` to two different users and a
 * Microsoft sign-in would resolve to whichever the query happened to return
 * first.
 */
/**
 * One employee id per organization.
 *
 * Partial rather than sparse-with-unique: the overwhelming majority of rows
 * have no `employeeId`, and the partial filter keeps them out of the index
 * entirely rather than relying on sparse semantics that differ subtly between
 * MongoDB versions. The same pattern `googleId` and `microsoftEmail` use.
 */
userSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { employeeId: { $type: 'string' } } },
)

userSchema.index(
  { microsoftEmail: 1 },
  { unique: true, partialFilterExpression: { microsoftEmail: { $type: 'string' } } },
)

/**
 * One outstanding invitation per address.
 *
 * Partial on `status: 'invited'` for two reasons, and both matter.
 *
 * The first is the same one every partial index in this file exists for: a plain
 * unique index on `email` would collide with the accounts that already exist —
 * and, worse, would be a schema change capable of failing at startup on a
 * database that happened to hold two records for one address. Restricting it to
 * invitations means it constrains a set that was empty when it was introduced,
 * so it cannot fail on existing data.
 *
 * The second is concurrency. The invite service checks for an existing account
 * before writing, and two simultaneous invitations for one address both pass
 * that check. Only the database can settle it, and here it does: the second
 * write fails with a duplicate-key error the service turns into a 409.
 *
 * It deliberately does *not* stop an invitation being raised for an address that
 * already has an active account — that check is the service's, because the right
 * answer there is an explanatory 409 rather than a constraint violation.
 *
 * ## Why the key is compound
 *
 * `status` is pinned to a single value by the partial filter, so uniqueness on
 * `(email, 'invited')` is exactly uniqueness on `email` within the indexed set —
 * the guarantee is identical. The second key exists to keep the index
 * distinguishable from the field-level `email` index above, which Mongoose would
 * otherwise report as an accidental duplicate definition. Both are wanted: the
 * plain one serves the `findOne({ email })` that Google sign-in performs on
 * every login, and must not be removed to silence a warning.
 */
userSchema.index(
  { email: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: USER_STATUS.INVITED } },
)

/** Shape returned to API clients. Keeps internal fields out of responses. */
userSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    microsoftId: this.microsoftId,
    microsoftEmail: this.microsoftEmail ?? null,
    tenantId: this.tenantId,
    displayName: this.displayName,
    email: this.email,
    userPrincipalName: this.userPrincipalName,
    jobTitle: this.jobTitle,
    preferredLanguage: this.preferredLanguage,
    role: this.role,
    roleLabel: ROLE_LABELS[this.role] ?? this.role,
    provider: this.provider,

    /**
     * Which providers can sign this person in, and when each last did.
     *
     * Derived rather than stored: the source of truth is whether the identifier
     * is present, and a separate boolean would be a second copy of that fact
     * able to disagree with it.
     */
    identities: {
      google: {
        linked: Boolean(this.googleId),
        lastLoginAt: this.lastGoogleLoginAt ?? null,
      },
      microsoft: {
        /**
         * Linked once an address has been *assigned*, not only once it has been
         * signed in with. An owner who has linked an address but not yet used
         * it has a Microsoft identity — it simply has no sign-in yet, which
         * `lastLoginAt: null` says.
         */
        linked: Boolean(this.microsoftId) || Boolean(this.microsoftEmail),
        email: this.microsoftEmail ?? null,
        /** True once Microsoft has actually authenticated it. */
        verified: Boolean(this.microsoftId),
        lastLoginAt: this.lastMicrosoftLoginAt ?? null,
      },
      /** True when one person reaches this account through both providers. */
      linked: Boolean(this.googleId) && (Boolean(this.microsoftId) || Boolean(this.microsoftEmail)),
      /** Which one established the record. Not which one is preferred. */
      establishedBy: this.provider,
    },
    accountType: this.accountType,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,

    // Additive. Existing consumers read the keys above and are unaffected.
    googleId: this.googleId ?? null,
    avatarUrl: this.avatarUrl ?? null,
    isActive: this.isActive !== false,

    /**
     * Additive in Phase 14.3A.
     *
     * `isActive` above is unchanged and still says whether the account may sign
     * in; this says *why*. A client that only ever read `isActive` keeps
     * working, and one that wants to tell "invited" from "suspended" no longer
     * has to guess from a boolean that cannot express the difference.
     */
    status: this.status ?? USER_STATUS.ACTIVE,
  }
}

/**
 * Whether this account is permitted to open a session.
 *
 * Read at sign-in by every identity provider, so a suspended or deleted person
 * is refused consistently however they authenticate.
 *
 * @returns {{ allowed: boolean, reason: ?string }}
 */
userSchema.methods.canSignIn = function canSignIn() {
  if (this.isDeleted === true) return { allowed: false, reason: 'account_deleted' }
  if (this.isActive === false) return { allowed: false, reason: 'account_inactive' }
  return { allowed: true, reason: null }
}

export const User = mongoose.model('User', userSchema)

export default User
