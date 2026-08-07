/**
 * In-flight Google sign-in attempts.
 *
 * ## Why this is not the existing `AuthFlow` collection
 *
 * `AuthFlow` belongs to the Microsoft mailbox authorisation. Sharing it would
 * couple two systems the architecture requires to stay independent: a change to
 * one flow's stored shape would then be a change to the other's, and a bug in
 * either could consume the other's records. A separate collection costs one
 * small model and buys the guarantee that Phase 13.2 can evolve the Microsoft
 * flow without touching anything here.
 *
 * A row exists only between the redirect to Google and the callback returning.
 * It is deleted on consumption and swept by a TTL index if the user abandons
 * the attempt at the Google consent screen.
 */

import mongoose from 'mongoose'

const { Schema } = mongoose

const googleAuthFlowSchema = new Schema(
  {
    /**
     * Opaque CSRF token echoed by Google in the callback query string.
     *
     * Unique so a replayed callback cannot match a second row, and indexed
     * because it is the only field ever looked up.
     */
    state: {
      type: String,
      required: true,
      unique: true,
    },

    /**
     * PKCE verifier. Never leaves the server.
     *
     * Google supports PKCE for confidential clients and there is no reason to
     * decline it: it binds the authorization code to this specific flow, so a
     * code intercepted from the redirect cannot be redeemed elsewhere.
     */
    codeVerifier: {
      type: String,
      required: true,
    },

    /**
     * Random value echoed into the ID token's `nonce` claim.
     *
     * PKCE protects the *code*; the nonce protects the *token*. Without it a
     * previously-issued ID token could be replayed into this callback.
     */
    nonce: {
      type: String,
      required: true,
    },

    /** Where to send the browser afterwards. Sanitised before storage. */
    returnPath: {
      type: String,
      default: null,
    },

    /** Captured for audit only; never used to validate the callback. */
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
)

/** MongoDB removes abandoned attempts automatically. */
googleAuthFlowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const GoogleAuthFlow = mongoose.model('GoogleAuthFlow', googleAuthFlowSchema)

export default GoogleAuthFlow
