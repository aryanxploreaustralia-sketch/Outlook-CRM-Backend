/**
 * In-flight OAuth authorization request.
 *
 * Between redirecting the browser to Microsoft and receiving the callback, two
 * values must survive server-side:
 *
 *  - **state** — an unguessable value echoed back by Microsoft. Verifying it
 *    proves the callback belongs to a flow this server actually started, which
 *    is what defeats CSRF-style login attacks where an attacker feeds a victim
 *    their own authorization code.
 *
 *  - **code_verifier** (PKCE) — the secret half of the `code_challenge` sent in
 *    the authorize request. Without it, an authorization code intercepted from
 *    the redirect URL cannot be redeemed.
 *
 * Storing these in the database rather than a cookie means the flow survives a
 * user opening the sign-in link in a different tab, and works unchanged when the
 * API runs as more than one process — a cookie-based verifier would break the
 * moment a load balancer sent the callback to a different instance.
 *
 * Documents are single-use and short-lived: consumed on callback, and swept by a
 * TTL index if the user abandons the flow.
 */

import mongoose from 'mongoose'

const { Schema } = mongoose

/**
 * What a flow is for.
 *
 * The two are genuinely different operations that happen to share a protocol.
 * A sign-in *establishes* an identity and therefore has no user yet; connecting
 * a mailbox *attaches* a credential to an identity that already exists and must
 * not be allowed to establish one. Recording the purpose is what lets each
 * callback refuse the other's flows outright rather than discovering the
 * mismatch halfway through.
 */
export const AUTH_FLOW_PURPOSE = Object.freeze({
  /** Microsoft sign-in. Creates a session. */
  SIGN_IN: 'sign_in',
  /** Phase 13.2 — attaches a *new* mailbox to the signed-in CRM user. */
  CONNECT_MAILBOX: 'connect_mailbox',
  /**
   * Phase 13.3 — re-authorises one existing mailbox.
   *
   * Distinct from `CONNECT_MAILBOX` rather than inferred from `targetMailbox`
   * being set, because the two have different *rules*: a connect may return any
   * Microsoft account and legitimately add a registry entry, while a reconnect
   * must return one specific account or be refused. Naming the intent means the
   * callback selects the rule from a value written before the redirect, instead
   * of deducing it from the shape of the record afterwards.
   */
  RECONNECT_MAILBOX: 'reconnect_mailbox',

  /**
   * Phase 14.8B — Microsoft sign-in for administrators.
   *
   * Distinct from `SIGN_IN`, which is the legacy Microsoft identity flow that
   * `MICROSOFT_ALLOW_SIGN_IN` gates off. That flow *mints* a CRM user keyed on
   * `(tenantId, microsoftId)`, which is exactly the defect Phase 13.2 disabled
   * it for: every Microsoft account became its own CRM user with its own
   * mailbox registry.
   *
   * This one never creates a user. It resolves a **verified email** to an
   * account that already exists, links the Microsoft identity onto it, and
   * refuses if there is no such account. Naming it separately is what lets the
   * callback pick that rule from a value written before the redirect, rather
   * than re-deriving it afterwards — and stops re-enabling one flow from
   * silently re-enabling the other.
   */
  ADMIN_SIGN_IN: 'admin_sign_in',
})

/** Flows that authorise a mailbox rather than establishing a CRM identity. */
export const MAILBOX_FLOW_PURPOSES = Object.freeze([
  AUTH_FLOW_PURPOSE.CONNECT_MAILBOX,
  AUTH_FLOW_PURPOSE.RECONNECT_MAILBOX,
])

const authFlowSchema = new Schema(
  {
    /** The OAuth `state` parameter. Random and unguessable. */
    state: {
      type: String,
      required: true,
      unique: true,
    },

    /**
     * Why this flow was started.
     *
     * Defaults to `sign_in` so every document written before this field existed
     * — and every existing code path, which never sets it — reads back as
     * exactly what it was.
     */
    purpose: {
      type: String,
      enum: Object.values(AUTH_FLOW_PURPOSE),
      default: AUTH_FLOW_PURPOSE.SIGN_IN,
    },

    /**
     * The CRM user this flow belongs to, for `connect_mailbox`.
     *
     * This is the security-critical field of Phase 13.2. Ownership of the
     * resulting mailbox is taken from **here** — a value written server-side
     * before the browser ever left for Microsoft — and never from the callback
     * query string, which is attacker-controlled. An attacker who replays
     * somebody else's authorization code still lands on a flow they did not
     * start, and `state` is single-use, so there is no code path that attaches a
     * mailbox to a workspace that did not ask for it.
     *
     * Null for `sign_in`, which has no user until it completes.
     */
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    /**
     * The mailbox being **re-authorised**, for a reconnect.
     *
     * Null for "Connect Microsoft mailbox", where any account is a legitimate
     * answer and produces a new registry entry. Set for "Reconnect", where
     * exactly one account is the right answer.
     *
     * Recorded server-side alongside the owner for the same reason: it is what
     * lets the callback verify that the account the user actually signed in
     * with is the one whose mailbox they asked to repair. Without it, clicking
     * Reconnect on `aryan.xplore@…` and then signing in as `sales@…` would
     * overwrite the first mailbox's identity with the second's — silently
     * renaming a registry entry and pointing it at the wrong mailbox.
     */
    targetMailbox: {
      type: Schema.Types.ObjectId,
      ref: 'Mailbox',
      default: null,
    },

    /**
     * The redirect URI this flow's authorize request was built with.
     *
     * Recorded because OAuth requires the redemption request to present the
     * *same* `redirect_uri` as the authorization request — Entra ID rejects the
     * code otherwise, with an error that says nothing about why. Storing it
     * removes the possibility of the two halves disagreeing, which is exactly
     * what happens when one of them reads a config value that has since been
     * overridden for a different flow.
     *
     * Null for flows written before this field existed; callers fall back to
     * the configured default, which is what those flows used.
     */
    redirectUri: {
      type: String,
      default: null,
    },

    /** PKCE code verifier. Never leaves the server. */
    codeVerifier: {
      type: String,
      required: true,
    },

    /**
     * Optional path within the web client to return to after sign-in.
     *
     * Validated as a relative path before storage — accepting an absolute URL
     * here would turn the callback into an open redirect.
     */
    returnPath: {
      type: String,
      default: null,
    },

    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

/** MongoDB sweeps abandoned flows automatically. */
authFlowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const AuthFlow = mongoose.model('AuthFlow', authFlowSchema)

export default AuthFlow
