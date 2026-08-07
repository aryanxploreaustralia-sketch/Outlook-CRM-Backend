/**
 * A named collection of contacts.
 *
 * Membership is stored as an array of contact ids on the group rather than a
 * group array on each contact. The reasoning is access-pattern based: the group
 * screen always asks "who is in this group", which is one document read; the
 * reverse question — "which groups is this contact in" — is asked only on a
 * single contact's detail page, where an indexed `$elemMatch` is perfectly fast.
 *
 * Storing it the other way round would mean a write to every affected contact
 * whenever a group changed.
 */

import mongoose from 'mongoose'

import { GROUP_COLORS } from '../modules/contacts/constants/contactConstants.js'

const { Schema } = mongoose

const contactGroupSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
    },

    description: { type: String, trim: true, default: null, maxlength: 1000 },

    /**
     * Hex colour used by the UI.
     *
     * Validated rather than free-form: an arbitrary string here reaches a
     * `style` attribute in the browser, and constraining it to a hex colour
     * keeps that from becoming an injection surface.
     */
    color: {
      type: String,
      default: GROUP_COLORS[0],
      validate: {
        validator: (value) => /^#[0-9a-f]{6}$/i.test(value),
        message: 'color must be a hex value such as #2563eb.',
      },
    },

    members: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Contact' }],
      default: [],
    },

    /**
     * Denormalised member count.
     *
     * The group list shows a count for every group; computing it would mean
     * loading every membership array. Maintained by the repository on every
     * membership change, which is the only place membership is written.
     */
    memberCount: { type: Number, default: 0, min: 0 },

    /** Set for groups mirrored from a provider's contact folders. */
    provider: { type: String, default: null },
    providerGroupId: { type: String, trim: true, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

/**
 * Group names are unique per user.
 *
 * Case-insensitive via a collation, so "Suppliers" and "suppliers" collide —
 * which is what a user expects, and prevents a list that appears to contain the
 * same group twice.
 */
contactGroupSchema.index(
  { owner: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
)

/** Answers "which groups is this contact in" without a scan. */
contactGroupSchema.index({ owner: 1, members: 1 })

/** Keeps the denormalised count honest on any direct save. */
contactGroupSchema.pre('save', async function syncCount() {
  if (this.isModified('members')) {
    this.memberCount = this.members.length
  }
})

contactGroupSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    description: this.description,
    color: this.color,
    memberCount: this.memberCount,
    provider: this.provider,
    providerGroupId: this.providerGroupId,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

/** Includes the membership list — only for the detail endpoint. */
contactGroupSchema.methods.toDetailJSON = function toDetailJSON() {
  return {
    ...this.toPublicJSON(),
    members: this.members.map((id) => id.toString()),
  }
}

export const ContactGroup = mongoose.model('ContactGroup', contactGroupSchema)

export default ContactGroup
