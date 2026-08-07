/**
 * Credential record for one mailbox connection.
 *
 * ## The important design decision: MSAL keeps owning Microsoft credentials
 *
 * The obvious implementation — copy `accessToken` and `refreshToken` out of MSAL
 * and store them here — would be actively harmful, for two reasons.
 *
 * First, correctness. Entra ID **rotates** refresh tokens: every redemption
 * issues a replacement and invalidates the old one. MSAL tracks that inside its
 * own cache. A second copy here would go stale the moment MSAL refreshed, and
 * the next attempt to use it would fail with `invalid_grant` — intermittently,
 * which is the worst way for it to fail.
 *
 * Second, exposure. It would put a second long-lived credential in a second
 * place, doubling the surface for no gain.
 *
 * So for `microsoft-graph` this record holds **metadata only** — expiry, scope,
 * status, last refresh — and `msalAccountRef` points at the `OutlookAccount`
 * whose encrypted MSAL cache remains the single source of truth. `accessToken`
 * and `refreshToken` stay null.
 *
 * They exist for providers that have no SDK-managed cache. An SMTP password or
 * a SendGrid API key has nowhere else to live, so those are stored here,
 * encrypted with the same AES-256-GCM helper used for the MSAL blob and marked
 * `select: false` so they cannot leak through a careless query.
 */

import mongoose from 'mongoose'

import { CONNECTION_STATUS, PROVIDER_TYPE_VALUES } from '../modules/provider/constants/providerTypes.js'

const { Schema } = mongoose

const providerTokenSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    mailbox: {
      type: Schema.Types.ObjectId,
      ref: 'Mailbox',
      required: true,
      index: true,
    },

    provider: {
      type: String,
      enum: PROVIDER_TYPE_VALUES,
      required: true,
      index: true,
    },

    /**
     * The `OutlookAccount` holding MSAL's encrypted cache.
     *
     * Set for `microsoft-graph`; null for providers that store credentials in
     * the two encrypted fields below.
     */
    msalAccountRef: {
      type: Schema.Types.ObjectId,
      ref: 'OutlookAccount',
      default: null,
    },

    /**
     * Encrypted credentials for providers without an SDK-managed cache.
     *
     * Null for Microsoft — see the note at the top of this file.
     */
    accessToken: { type: String, default: null, select: false },
    refreshToken: { type: String, default: null, select: false },

    /**
     * Advisory expiry, used to display connection state and to decide whether a
     * pre-emptive refresh is worth attempting. The provider's own SDK remains
     * authoritative on whether a token is actually usable.
     */
    expiresAt: { type: Date, default: null },

    /** Permissions actually granted, which may be narrower than those requested. */
    scope: { type: [String], default: [] },

    status: {
      type: String,
      enum: Object.values(CONNECTION_STATUS),
      default: CONNECTION_STATUS.DISCONNECTED,
      index: true,
    },

    lastRefresh: { type: Date, default: null },
    /** Consecutive refresh failures. Reset on success; drives backoff. */
    refreshFailureCount: { type: Number, default: 0, min: 0 },
    lastError: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      occurredAt: { type: Date, default: null },
    },
  },
  { timestamps: true, versionKey: false },
)

/** One credential record per mailbox per provider. */
providerTokenSchema.index({ mailbox: 1, provider: 1 }, { unique: true })

/**
 * True when the access token is expired or close enough that using it is a race.
 *
 * The 5-minute skew is not arbitrary: a token that expires in 30 seconds will
 * very likely expire mid-request, and the resulting 401 is indistinguishable
 * from a real authentication failure. Refreshing early avoids that entirely.
 */
providerTokenSchema.methods.isExpired = function isExpired(skewMs = 5 * 60 * 1000) {
  if (!this.expiresAt) return false
  return this.expiresAt.getTime() - skewMs <= Date.now()
}

/** Safe representation — never includes credential material. */
providerTokenSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    provider: this.provider,
    status: this.status,
    scope: this.scope,
    expiresAt: this.expiresAt,
    expiresInSeconds: this.expiresAt
      ? Math.max(0, Math.round((this.expiresAt.getTime() - Date.now()) / 1000))
      : null,
    isExpired: this.isExpired(0),
    lastRefresh: this.lastRefresh,
    refreshFailureCount: this.refreshFailureCount,
    lastError: this.lastError?.code ? this.lastError : null,
    /** Signals that credentials live in MSAL's cache, not in this record. */
    managedByMsal: this.msalAccountRef !== null,
  }
}

export const ProviderToken = mongoose.model('ProviderToken', providerTokenSchema)

export default ProviderToken
