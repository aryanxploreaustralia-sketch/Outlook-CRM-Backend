/**
 * A role whose permissions have been changed from the built-in default.
 *
 * ## Why a sparse override table rather than a `Role` collection
 *
 * Until now a role was a compile-time constant: `constants/roleMatrix.js` held
 * the bundles and `permissionsForRole()` read them out of a frozen `Set`. That
 * design has a real property worth keeping — a deployment with an empty database
 * still has a correct, complete permission model, and the code that enforces it
 * cannot be edited by anything short of a release.
 *
 * Storing every role as a row would throw that away: the matrix would live in
 * the database, a failed migration or an empty collection would mean *nobody has
 * any permissions*, and the constants file would become documentation of
 * something that is no longer true.
 *
 * So only **departures** from the default are stored. A role with no document
 * here resolves exactly as it did before this collection existed. That makes the
 * feature additive in the strongest sense: dropping this collection restores the
 * original behaviour rather than breaking the deployment, and `roleMatrix.js`
 * remains the source of truth for anything nobody has deliberately changed.
 *
 * ## `permissions` is the complete set, not a delta
 *
 * The document holds the role's whole permission list, not "added" and "removed"
 * lists. A delta has to be replayed against a default that may itself change in
 * a later release, and the result of that replay is not something an
 * administrator can predict from what they see on screen. The stored list is
 * what the role has.
 */

import mongoose, { Schema } from 'mongoose'

import { PERMISSION_VALUES } from '../constants/permissions.js'
import { ROLE_VALUES } from '../constants/roles.js'

const rolePermissionSchema = new Schema(
  {
    /**
     * The role this overrides. Unique: a role has one definition, and a second
     * document would make "what can this role do" ambiguous at the storage
     * layer, where no amount of care further up can settle it.
     */
    role: {
      type: String,
      enum: ROLE_VALUES,
      required: true,
      unique: true,
      index: true,
    },

    /**
     * The role's complete permission list.
     *
     * Enum-validated at the schema, which is the last line rather than the first
     * — the service validates before writing. Both exist because they fail
     * differently: the service can explain *which* permission was unknown, and
     * this stops anything that bypassed the service from storing a string the
     * authorization layer would silently never match.
     */
    permissions: {
      type: [{ type: String, enum: PERMISSION_VALUES }],
      default: [],
    },

    /** Who last changed it. The audit log holds the full history. */
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
)

export const RolePermission =
  mongoose.models.RolePermission ?? mongoose.model('RolePermission', rolePermissionSchema)

export default RolePermission
