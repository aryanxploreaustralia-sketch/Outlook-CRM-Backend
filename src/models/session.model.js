/**
 * Server-side session store.
 *
 * ## Why database sessions rather than a JWT
 *
 * A JWT cannot be revoked. Once signed it stays valid until it expires, so
 * "log out" becomes a client-side suggestion rather than a server-side fact.
 * For an application holding mailbox credentials that is the wrong trade: a
 * user who signs out on a shared machine must be signed out immediately.
 *
 * Sessions here are opaque random identifiers looked up on each request. Logging
 * out deletes the row and the session is dead instantly.
 *
 * The identifier is stored **hashed**. The same reasoning applies as for
 * passwords: a leaked database must not hand an attacker a set of working
 * session cookies.
 */

import mongoose from 'mongoose'

const { Schema } = mongoose

const sessionSchema = new Schema(
  {
    /** SHA-256 of the session token. The plaintext exists only in the cookie. */
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },

    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    outlookAccount: {
      type: Schema.Types.ObjectId,
      ref: 'OutlookAccount',
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
    },

    /**
     * Captured at sign-in for audit purposes. Deliberately *not* used to
     * validate the session — mobile networks rotate IPs and browsers change
     * user-agent strings on update, so enforcing them logs out legitimate users.
     */
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },

    lastUsedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/**
 * TTL index: MongoDB deletes expired sessions automatically.
 *
 * The application also treats an expired-but-not-yet-swept document as invalid,
 * because the background sweeper only runs about once a minute and correctness
 * must not depend on its timing.
 */
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const Session = mongoose.model('Session', sessionSchema)

export default Session
