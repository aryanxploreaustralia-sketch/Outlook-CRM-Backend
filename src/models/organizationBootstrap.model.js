/**
 * The one-time record that organization bootstrap has run.
 *
 * ## Why a stored marker and not just "are there any owners?"
 *
 * The brief's rule is "if owner count is zero, allow one Microsoft account to
 * become the first owner". Evaluated on its own, that rule **re-opens**: a
 * deployment whose owners are all later suspended goes back to zero active
 * owners, and the door swings open again for any Microsoft account that can
 * authenticate. Somebody who could suspend the owners could then appoint
 * themselves — which turns an installation step into a privilege-escalation
 * path.
 *
 * So the count decides whether bootstrap is *needed*, and this document decides
 * whether it is still *permitted*. Both must agree. Once the first owner is
 * created the document exists forever, and the phrase "bootstrap permanently
 * disables itself" becomes literally true rather than incidentally true.
 *
 * ## Why a singleton collection rather than a config flag
 *
 * A flag in `.env` can be flipped back by whoever holds the server, which is
 * the same person the marker is protecting against in the scenario above. A
 * document is also *evidence*: it records which Microsoft identity claimed the
 * organization and when, which is the single most consequential event in the
 * deployment's history and the first thing an auditor would ask about.
 *
 * ## Not an `Organization` entity
 *
 * Deliberately. There is still no tenancy model in this product — every
 * business collection is keyed on a `User`, and inventing a half-organization
 * here would imply a scoping that does not exist. This records one fact about
 * installation and nothing else.
 */

import mongoose from 'mongoose'

const { Schema } = mongoose

const organizationBootstrapSchema = new Schema(
  {
    /**
     * Always `true`, and uniquely indexed.
     *
     * The mechanism that makes this a singleton: a second insert violates the
     * unique index and fails, so two concurrent bootstrap attempts cannot both
     * succeed no matter how the application code is written. The guarantee
     * lives in the database rather than in a check somebody could forget.
     */
    singleton: { type: Boolean, default: true, unique: true, required: true },

    completedAt: { type: Date, default: Date.now, required: true },

    /** The account that claimed the organization. */
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /** Captured at the time — the target may be renamed or deleted later. */
    ownerEmail: { type: String, trim: true, default: null },

    /** The Microsoft identity used. Never a token, never a cache. */
    microsoftEmail: { type: String, trim: true, default: null },
    tenantId: { type: String, trim: true, default: null },

    /** Where it was claimed from, for the audit trail. */
    ip: { type: String, trim: true, default: null },
    userAgent: { type: String, trim: true, default: null, maxlength: 512 },
  },
  { timestamps: true, versionKey: false },
)

export const OrganizationBootstrap = mongoose.model(
  'OrganizationBootstrap',
  organizationBootstrapSchema,
)

/**
 * Whether the organization has already been claimed.
 *
 * @returns {Promise<boolean>}
 */
export async function isBootstrapCompleted() {
  return (await OrganizationBootstrap.estimatedDocumentCount()) > 0
}

export default OrganizationBootstrap
