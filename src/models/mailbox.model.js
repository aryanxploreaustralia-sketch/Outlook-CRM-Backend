/**
 * A mailbox this CRM synchronises.
 *
 * Provider-independent by construction: nothing here is Microsoft-specific.
 * `providerAccountId` holds whatever opaque identifier the provider uses for the
 * account — a Graph `homeAccountId`, a Gmail address, an IMAP username — and no
 * consumer interprets it.
 *
 * ## Relationship to `OutlookAccount`
 *
 * `OutlookAccount` (Phase 2) remains exactly what it was: the OAuth grant and
 * encrypted MSAL cache for a Microsoft sign-in. `Mailbox` is the synchronisation
 * record layered above it, and links back through `sourceAccount`. They are kept
 * apart rather than merged so Phase 2's authentication continues to work
 * untouched, and so a future Gmail mailbox needs no `OutlookAccount` at all.
 */

import mongoose from 'mongoose'

import {
  CONNECTION_STATUS,
  PROVIDER_LABELS,
  PROVIDER_TYPE_VALUES,
} from '../modules/provider/constants/providerTypes.js'

const { Schema } = mongoose

const mailboxSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    provider: {
      type: String,
      enum: PROVIDER_TYPE_VALUES,
      required: true,
      index: true,
    },

    /** The provider's own account identifier. Opaque to this application. */
    providerAccountId: {
      type: String,
      required: true,
      trim: true,
    },

    /** Primary address. May be null — a guest identity legitimately has none. */
    emailAddress: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
      index: true,
    },

    displayName: { type: String, trim: true, default: null },

    /**
     * Link to the Phase 2 OAuth grant, for Microsoft mailboxes.
     *
     * Null for providers that authenticate some other way, which is why the
     * sync engine never assumes it is present.
     */
    sourceAccount: {
      type: Schema.Types.ObjectId,
      ref: 'OutlookAccount',
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(CONNECTION_STATUS),
      default: CONNECTION_STATUS.DISCONNECTED,
      index: true,
    },

    /**
     * Why the mailbox is unusable, when it is.
     *
     * Kept rather than deleting the record so the UI can explain what happened
     * and offer reconnection, instead of the mailbox silently disappearing.
     */
    statusReason: { type: String, default: null },

    /** Capabilities the adapter declared at connect time, cached for the UI. */
    capabilities: { type: [String], default: [] },

    /**
     * The workspace's sending mailbox when nobody chooses one.
     *
     * Phase 13.2. Needed because unattended mail — the morning introduction, a
     * sequence step — has no human present to pick a sender, and picking
     * "whichever connected most recently" would silently change who a customer
     * hears from the next time somebody reconnects a mailbox.
     *
     * Exactly one per user is enforced by the partial index below rather than by
     * application code, so two concurrent "Set as default" requests cannot leave
     * a workspace with two defaults.
     */
    isDefault: { type: Boolean, default: false },

    /**
     * Whether the reply sync reads this mailbox.
     *
     * Separate from `status`: a mailbox can be perfectly healthy for sending
     * while its owner does not want the CRM ingesting its inbox. Defaults true
     * so every mailbox that existed before this field behaves exactly as it did.
     */
    syncEnabled: { type: Boolean, default: true },

    // -----------------------------------------------------------------------
    // Phase 14.5 - assignment.
    //
    // Both default to `[]`, so every mailbox written before this phase reads
    // back unchanged and keeps working: `user` alone still grants its connector
    // access, and `isDefault` still records their default. Assignment only ever
    // *widens* who may reach a mailbox - see `constants/mailboxAccess.js`.
    // -----------------------------------------------------------------------

    /**
     * Users who may send through this mailbox besides the connector.
     *
     * A plain array of ids rather than embedded objects: the profile, the name
     * and the avatar all live on `User`, and copying them here would be a
     * second version of a person's details that nothing keeps in step.
     *
     * The connector is deliberately **not** listed here. They hold access
     * through `user`, and duplicating them would make "remove this person"
     * ambiguous - the one operation that must never silently revoke the grant
     * the mailbox actually runs on.
     */
    assignedUsers: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      index: true,
    },

    /**
     * Users for whom this is *their* default sending mailbox.
     *
     * A user appears in at most one mailbox's array. That is enforced by
     * `mailboxAssignment.service`, which clears the id from every other mailbox
     * inside the same operation - not by a unique index, because a multikey
     * unique index would collide on the empty arrays every other mailbox has.
     * The trade-off is stated where it is enforced.
     *
     * Distinct from `isDefault` above, which remains the *connector's* default
     * and is what a pre-assignment workspace still resolves by.
     */
    defaultUsers: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      index: true,
    },

    connectedAt: { type: Date, default: null },
    disconnectedAt: { type: Date, default: null },
    lastValidatedAt: { type: Date, default: null },

    /** Rolling counters, maintained by the sync engine. */
    stats: {
      totalMessagesSynced: { type: Number, default: 0, min: 0 },
      lastSyncAt: { type: Date, default: null },
      lastSuccessfulSyncAt: { type: Date, default: null },
      folderCount: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true, versionKey: false },
)

/**
 * One mailbox per provider account per user.
 *
 * Scoped to the user rather than global: the same shared mailbox can legitimately
 * be connected by two different people, and a global unique index would let
 * whoever connected first block everyone else.
 */
mailboxSchema.index({ user: 1, provider: 1, providerAccountId: 1 }, { unique: true })

/**
 * At most one default mailbox per user — enforced by the database.
 *
 * Partial on `isDefault: true` for the reason every partial index in this
 * codebase is partial: MongoDB indexes `false` as a value like any other, so a
 * plain compound unique index would admit one non-default mailbox per user and
 * reject every one after it. The filter narrows the constraint to exactly the
 * set it was written to protect.
 *
 * Doing it here rather than in application code is what makes the guarantee
 * hold under concurrency. Two simultaneous "Set as default" requests both read
 * "the current default is A" and both try to write; with only an application
 * check, both succeed and the workspace ends up with two defaults and a
 * non-deterministic sender. With this index the second write fails, and
 * `setDefaultMailbox` orders its two updates so that failure leaves the
 * previous default intact rather than none at all.
 */
mailboxSchema.index(
  { user: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
)

mailboxSchema.virtual('isConnected').get(function isConnected() {
  return this.status === CONNECTION_STATUS.CONNECTED
})

mailboxSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    provider: this.provider,
    providerLabel: PROVIDER_LABELS[this.provider] ?? this.provider,
    providerAccountId: this.providerAccountId,
    emailAddress: this.emailAddress,
    displayName: this.displayName,
    status: this.status,
    statusReason: this.statusReason,
    capabilities: this.capabilities,
    connected: this.status === CONNECTION_STATUS.CONNECTED,

    // Additive in Phase 13.2. Existing consumers read the keys around these and
    // are unaffected; neither carries any credential material.
    isDefault: this.isDefault === true,
    syncEnabled: this.syncEnabled !== false,

    /**
     * Additive in Phase 14.5. Counts only - never the ids.
     *
     * A client rendering a mailbox picker needs to know how many people share
     * it; it has no business receiving a list of user ids it cannot resolve and
     * did not ask for. The admin endpoints return the people themselves, behind
     * `mailboxes.view`.
     */
    assignedUserCount: (this.assignedUsers ?? []).length,
    defaultUserCount: (this.defaultUsers ?? []).length,
    /** Whether this mailbox can be used to send right now. */
    canSend: this.status === CONNECTION_STATUS.CONNECTED && this.disconnectedAt === null,

    connectedAt: this.connectedAt,
    disconnectedAt: this.disconnectedAt,
    lastValidatedAt: this.lastValidatedAt,
    stats: {
      totalMessagesSynced: this.stats?.totalMessagesSynced ?? 0,
      lastSyncAt: this.stats?.lastSyncAt ?? null,
      lastSuccessfulSyncAt: this.stats?.lastSuccessfulSyncAt ?? null,
      folderCount: this.stats?.folderCount ?? 0,
    },
    createdAt: this.createdAt,
  }
}

export const Mailbox = mongoose.model('Mailbox', mailboxSchema)

export default Mailbox
