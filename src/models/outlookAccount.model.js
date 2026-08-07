/**
 * Outlook account connection.
 *
 * Holds the OAuth material that lets the CRM act on a user's mailbox on their
 * behalf. Separated from `User` for two reasons: the security profile is
 * completely different (this document is the sensitive one), and a user may
 * later connect more than one mailbox.
 *
 * ## Why the whole MSAL cache is stored rather than individual tokens
 *
 * MSAL deliberately does not expose refresh tokens through its public API —
 * `AuthenticationResult` carries an access token but never the refresh token.
 * The supported way to persist a session is to serialise MSAL's own token cache
 * and hand it back later.
 *
 * Doing it that way is also the more correct choice: Entra ID rotates refresh
 * tokens, issuing a replacement each time one is redeemed. MSAL handles that
 * internally, so persisting its cache keeps rotation working without this code
 * having to track token lifecycles itself.
 *
 * The serialised cache is encrypted with AES-256-GCM before it is written, so a
 * database dump alone cannot be used to access anyone's mailbox.
 */

import mongoose from 'mongoose'

const { Schema } = mongoose

const outlookAccountSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /**
     * MSAL's identifier for the cached account, formatted `<oid>.<tenantId>`.
     * Required to locate the right account inside a deserialised cache.
     */
    homeAccountId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },

    /** Mailbox address this connection controls. */
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    /**
     * Encrypted, serialised MSAL token cache.
     *
     * `select: false` keeps it out of every query result unless explicitly
     * requested with `.select('+tokenCache')`, so it cannot leak into an API
     * response through a careless `res.json(account)`.
     */
    tokenCache: {
      type: String,
      required: true,
      select: false,
    },

    /** Delegated permissions actually granted, which may differ from those requested. */
    scopes: {
      type: [String],
      default: [],
    },

    /**
     * Expiry of the currently cached access token.
     *
     * Advisory only — used to display connection state without decrypting the
     * cache. MSAL remains the authority on whether a refresh is needed.
     */
    accessTokenExpiresAt: {
      type: Date,
      default: null,
    },

    /**
     * Set when a refresh fails permanently, e.g. the user revoked consent, the
     * password changed, or an administrator removed the grant. The connection
     * is kept rather than deleted so the UI can explain what happened and
     * prompt for reconnection.
     */
    disconnectedAt: { type: Date, default: null },
    disconnectReason: { type: String, default: null },

    lastSyncedAt: { type: Date, default: null },
    connectedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/** True when this connection can still be used to call Microsoft Graph. */
outlookAccountSchema.virtual('isConnected').get(function isConnected() {
  return this.disconnectedAt === null
})

/** Safe representation for API responses — never includes the token cache. */
outlookAccountSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    email: this.email,
    homeAccountId: this.homeAccountId,
    scopes: this.scopes,
    connected: this.disconnectedAt === null,
    connectedAt: this.connectedAt,
    disconnectedAt: this.disconnectedAt,
    disconnectReason: this.disconnectReason,
    accessTokenExpiresAt: this.accessTokenExpiresAt,
    lastSyncedAt: this.lastSyncedAt,
  }
}

export const OutlookAccount = mongoose.model('OutlookAccount', outlookAccountSchema)

export default OutlookAccount
