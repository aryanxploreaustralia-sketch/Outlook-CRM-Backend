/**
 * A saved column mapping.
 *
 * Sales teams import the same shaped sheet repeatedly — "Mukesh Sheet",
 * "Australia Leads", "Corporate Leads" — and re-deciding twenty column mappings
 * every week is exactly the friction that makes people stop using an importer.
 *
 * ## Matching
 *
 * A template records the header set it was built from, so the wizard can offer
 * the right one automatically. Matching is on the *set* of headers rather than
 * their order, because exporting the same report twice can reorder columns
 * without changing what they mean.
 */

import mongoose from 'mongoose'

const { Schema } = mongoose

const templateMappingSchema = new Schema(
  {
    column: { type: String, required: true },
    field: { type: String, required: true },
  },
  { _id: false },
)

const importTemplateSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    name: { type: String, required: true, trim: true, maxlength: 128 },
    description: { type: String, trim: true, default: null, maxlength: 1000 },

    mapping: { type: [templateMappingSchema], default: [] },

    /**
     * The headers this template was built from, normalised and sorted.
     *
     * Sorted so a reordered export still matches, and normalised so
     * "E-Mail_ID" and "email id" are recognised as the same column.
     */
    headerSignature: { type: [String], default: [], index: true },

    defaultTags: { type: [String], default: [] },
    defaultLeadSource: { type: String, default: null },
    defaultLeadStatus: { type: String, default: null },
    duplicateAction: { type: String, default: 'skip' },

    /** Maintained so the wizard can offer the most-used template first. */
    useCount: { type: Number, default: 0, min: 0 },
    lastUsedAt: { type: Date, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, versionKey: false },
)

/** Template names are unique per user, case-insensitively. */
importTemplateSchema.index(
  { owner: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
)

/**
 * Scores how well this template fits a set of headers.
 *
 * Returns the proportion of the template's own columns that are present. A
 * partial match is still useful — a sheet with two extra columns should still
 * offer the template — so this is a ratio rather than a boolean.
 *
 * @param {string[]} normalisedHeaders
 * @returns {number} 0–1
 */
importTemplateSchema.methods.matchScore = function matchScore(normalisedHeaders) {
  if (this.headerSignature.length === 0) return 0

  const present = new Set(normalisedHeaders)
  const matched = this.headerSignature.filter((header) => present.has(header)).length

  return matched / this.headerSignature.length
}

importTemplateSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    description: this.description,
    mapping: this.mapping,
    columnCount: this.mapping.length,
    defaultTags: this.defaultTags,
    defaultLeadSource: this.defaultLeadSource,
    defaultLeadStatus: this.defaultLeadStatus,
    duplicateAction: this.duplicateAction,
    useCount: this.useCount,
    lastUsedAt: this.lastUsedAt,
    createdAt: this.createdAt,
  }
}

export const ImportTemplate = mongoose.model('ImportTemplate', importTemplateSchema)

export default ImportTemplate
