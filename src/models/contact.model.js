/**
 * A person in the address book.
 *
 * Holds contacts from two origins that must coexist without interfering:
 * records synchronised from a mail provider, and records that exist only in this
 * CRM. `source` distinguishes them and drives real behaviour — a `crm` contact
 * is never overwritten by a sync, and an `outlook` contact that disappears
 * upstream is marked rather than destroyed.
 *
 * ## Normalised match fields
 *
 * `matchEmails` and `matchPhones` are derived, lower-cased and digit-only copies
 * of the addressable fields. They exist because duplicate detection has to be an
 * indexed query, not a scan: comparing `"+44 161 4960"` against `"01614960"` in
 * application code means loading every contact the user owns. Normalising once
 * on save turns that into an index hit.
 */

import crypto from 'node:crypto'

import mongoose from 'mongoose'

import {
  CONTACT_CATEGORY,
  CONTACT_CATEGORY_LABELS,
  CONTACT_CATEGORY_VALUES,
  CONTACT_SOURCE,
  CONTACT_SOURCE_LABELS,
  CONTACT_SOURCE_VALUES,
  CONTACT_SYNC_STATUS,
  CONTACT_SYNC_STATUS_LABELS,
  CONTACT_SYNC_STATUS_VALUES,
} from '../modules/contacts/constants/contactConstants.js'
import {
  LEAD_STATUS,
  LEAD_STATUS_VALUES,
} from '../modules/import/constants/importConstants.js'

const { Schema } = mongoose

/**
 * Strips a phone number to its digits, keeping a leading `+`.
 *
 * Exported because import, sync and duplicate detection must all normalise
 * identically — three near-identical regexes would drift apart, and the failure
 * would be silent duplicates rather than an error.
 *
 * @param {?string} value
 * @returns {?string}
 */
export function normalisePhone(value) {
  if (!value) return null

  const trimmed = String(value).trim()
  const digits = trimmed.replace(/[^\d]/g, '')

  if (digits.length < 6) return null

  /**
   * The last 9 digits are compared, not the whole string.
   *
   * `+44 161 496 0000` and `0161 496 0000` are the same line written with and
   * without a country code. Comparing full strings would treat them as different
   * people; comparing a fixed-length suffix matches them without needing a
   * country-code table.
   */
  return digits.slice(-9)
}

/** Lower-cases and trims an address for comparison. */
export function normaliseEmail(value) {
  const trimmed = String(value ?? '').trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}

/** Collapses whitespace and case so display names compare sensibly. */
export function normaliseName(value) {
  const collapsed = String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return collapsed === '' ? null : collapsed
}

/** Provider version marker plus the local edit clock, for conflict detection. */
const syncMetaSchema = new Schema(
  {
    changeKey: { type: String, default: null },
    /** Provider's last-modified time at the moment of the last successful sync. */
    remoteModifiedAt: { type: Date, default: null },
    /** Local `updatedAt` at the moment of the last successful sync. */
    localModifiedAt: { type: Date, default: null },
  },
  { _id: false },
)

const contactSchema = new Schema(
  {
    // --- Ownership ---------------------------------------------------------

    /**
     * The user whose address book this is.
     *
     * Present in every query in the repository layer, which is what makes
     * cross-user access impossible by construction rather than by remembering.
     */
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    // --- Identity ----------------------------------------------------------

    firstName: { type: String, trim: true, default: null, maxlength: 128 },
    lastName: { type: String, trim: true, default: null, maxlength: 128 },

    /**
     * What the UI shows.
     *
     * Derived from the name parts when absent (see the pre-save hook) so a list
     * never renders a blank row, which is what happens when a provider supplies
     * only an email address.
     */
    displayName: { type: String, trim: true, default: null, maxlength: 256, index: true },

    /**
     * Employer name as text.
     *
     * Stays a string, and stays named `company`. Phase 8 introduced a real
     * Company entity, but retyping this field would break every existing
     * reader — the `{{Company}}` campaign variable, the CSV/XLSX exporters, the
     * text index, the company facet on the contacts list. The relational link
     * is added alongside as `companyId` instead, which is additive and cannot
     * break anything.
     */
    company: { type: String, trim: true, default: null, maxlength: 256, index: true },

    /**
     * The employer record, when one could be resolved.
     *
     * Null for every contact created before Phase 8 and for anyone whose
     * company could not be identified; `scripts/backfill-companies.js`
     * populates it for existing data.
     */
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', default: null, index: true },

    jobTitle: { type: String, trim: true, default: null, maxlength: 256 },

    /** Role as the sheet words it. `jobTitle` remains the Graph-synced field. */
    designation: { type: String, trim: true, default: null, maxlength: 256 },

    department: { type: String, trim: true, default: null, maxlength: 128 },

    // --- Addressable -------------------------------------------------------

    primaryEmail: { type: String, trim: true, lowercase: true, default: null, index: true },
    secondaryEmail: { type: String, trim: true, lowercase: true, default: null },

    phone: { type: String, trim: true, default: null },
    mobile: { type: String, trim: true, default: null },
    businessPhone: { type: String, trim: true, default: null },

    /**
     * Every address and number the source held.
     *
     * A single `phone` string cannot represent what the sales workbook actually
     * contains: 64% of its non-empty phone cells hold more than one number
     * ("9460363021 // 8947823973 // 0141-4020102"). The old singular fields stay
     * as the primary value so nothing that reads them breaks; these carry the
     * rest instead of discarding it.
     */
    additionalEmails: { type: [String], default: [] },
    phones: { type: [String], default: [] },

    website: { type: String, trim: true, default: null, maxlength: 512 },

    // --- Location ----------------------------------------------------------

    address: { type: String, trim: true, default: null, maxlength: 512 },
    city: { type: String, trim: true, default: null, maxlength: 128 },
    state: { type: String, trim: true, default: null, maxlength: 128 },
    country: { type: String, trim: true, default: null, maxlength: 128, index: true },
    postalCode: { type: String, trim: true, default: null, maxlength: 32 },

    // --- CRM ---------------------------------------------------------------

    notes: { type: String, default: null, maxlength: 10_000 },

    tags: { type: [String], default: [], index: true },

    category: {
      type: String,
      enum: CONTACT_CATEGORY_VALUES,
      default: CONTACT_CATEGORY.OTHER,
      index: true,
    },

    favorite: { type: Boolean, default: false, index: true },

    /**
     * Base64 photo, with its content type.
     *
     * `select: false` because a list of 200 contacts must not ship 200 images.
     * Fetched explicitly by the detail endpoint.
     */
    photo: {
      contentType: { type: String, default: null },
      contentBytes: { type: String, default: null, select: false },
    },

    birthday: { type: Date, default: null },

    /** Last time a message was exchanged. Maintained by the mail module later. */
    lastInteraction: { type: Date, default: null, index: true },

    // --- Provenance and sync ----------------------------------------------

    source: {
      type: String,
      enum: CONTACT_SOURCE_VALUES,
      default: CONTACT_SOURCE.CRM,
      index: true,
    },

    provider: { type: String, default: null },

    /** The provider's identifier. Null for contacts that exist only here. */
    providerContactId: { type: String, trim: true, default: null },

    /** Mailbox this contact was synchronised from. */
    mailbox: { type: Schema.Types.ObjectId, ref: 'Mailbox', default: null, index: true },

    syncStatus: {
      type: String,
      enum: CONTACT_SYNC_STATUS_VALUES,
      default: CONTACT_SYNC_STATUS.LOCAL,
      index: true,
    },

    syncMeta: { type: syncMetaSchema, default: () => ({}) },

    lastSyncedAt: { type: Date, default: null },

    /**
     * Set when the contact vanished at the provider.
     *
     * Retained rather than deleted so the user can restore it, and so a
     * mis-click in Outlook does not silently destroy CRM annotations — tags,
     * notes and category have no upstream equivalent and could not be recovered.
     */
    deletedRemotelyAt: { type: Date, default: null },

    /** Soft delete, for contacts removed in the CRM. */
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },

    // --- Phase 7: bulk outreach -------------------------------------------
    //
    // Added additively, every field with a default that describes what an
    // existing contact already is. No migration is needed and no existing query
    // changes meaning.

    /**
     * Stable public identifier.
     *
     * Distinct from `_id`: campaign links and unsubscribe tokens need an
     * identifier that can appear in a URL without exposing a database key, and
     * that stays constant if records are ever migrated between collections.
     */
    uuid: {
      type: String,
      default: () => crypto.randomUUID(),
      index: true,
    },

    /** Where the lead came from. Free text — sheets carry anything. */
    leadSource: { type: String, trim: true, default: null, index: true },

    /** Position in the sales pipeline. */
    leadStatus: {
      type: String,
      enum: LEAD_STATUS_VALUES,
      default: LEAD_STATUS.NEW,
      index: true,
    },

    /** The import that created this contact, for filtering and rollback. */
    importJob: {
      type: Schema.Types.ObjectId,
      ref: 'ImportJob',
      default: null,
      index: true,
    },

    /** 1-based row in the source spreadsheet, so a record traces to its origin. */
    importRow: { type: Number, default: null },

    /** Enquiries raised by this person. Denormalised for the contact list. */
    leadCount: { type: Number, default: 0, min: 0 },

    /**
     * Columns the sheet carried that no field maps onto.
     *
     * Kept rather than discarded: a sales sheet routinely holds a column the CRM
     * has no concept of, and throwing it away means re-importing to get it back.
     */
    customFields: { type: Map, of: String, default: undefined },

    // --- Derived match keys (maintained by the pre-save hook) --------------

    matchEmails: { type: [String], default: [], index: true },
    matchPhones: { type: [String], default: [], index: true },
    matchName: { type: String, default: null, index: true },
  },
  { timestamps: true, versionKey: false },
)

/**
 * Derives display name and match keys before every save.
 *
 * Done in a hook rather than at each call site because contacts arrive from five
 * places — the API, sync, CSV, vCard and XLSX import — and a normalisation any
 * one of them skipped would produce duplicates that detection could not see.
 */
/**
 * Derives the display name and the normalised match keys.
 *
 * Exported and called from two places, deliberately. The pre-save hook covers
 * every ordinary write, but `insertMany` — which the import engine needs for
 * throughput — **bypasses document middleware entirely**. A contact inserted
 * that way would carry no `matchEmails`, making it invisible to duplicate
 * detection: the next import would happily insert it again.
 *
 * Sharing one implementation is what keeps the bulk path and the single-document
 * path from diverging.
 *
 * @param {object} doc A Contact document or a plain object destined to become one.
 * @returns {object} The same object, with the derived fields set.
 */
export function deriveContactFields(doc) {
  if (!doc.displayName) {
    const parts = [doc.firstName, doc.lastName].filter(Boolean)
    doc.displayName = parts.length > 0 ? parts.join(' ') : (doc.primaryEmail ?? null)
  }

  doc.matchEmails = [
    ...new Set([doc.primaryEmail, doc.secondaryEmail].map(normaliseEmail).filter(Boolean)),
  ]

  doc.matchPhones = [
    ...new Set([doc.mobile, doc.businessPhone, doc.phone].map(normalisePhone).filter(Boolean)),
  ]

  doc.matchName = normaliseName(doc.displayName)

  return doc
}

// Declared `async` with no `next` parameter: Mongoose resolves the returned
// promise. The callback form is not used because Mongoose 9 does not supply
// `next` to a hook that declares no parameters, and mixing the two styles is
// how a hook silently stops running.
contactSchema.pre('save', async function deriveFields() {
  deriveContactFields(this)
})

// --- Indexes ---------------------------------------------------------------

/** The default list: this user's contacts, excluding deleted, newest first. */
contactSchema.index({ owner: 1, isDeleted: 1, createdAt: -1 })

/** Alphabetical listing, the other common ordering. */
contactSchema.index({ owner: 1, isDeleted: 1, displayName: 1 })

/**
 * Duplicate detection on the provider's own id.
 *
 * Unique with a partial filter, so re-syncing is idempotent at the database
 * rather than relying on application bookkeeping. The filter is essential:
 * without it every CRM-only contact (no `providerContactId`) would collide
 * on null.
 */
contactSchema.index(
  { owner: 1, provider: 1, providerContactId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerContactId: { $type: 'string' },
      provider: { $type: 'string' },
    },
  },
)

/** Duplicate detection by email and phone — indexed, not scanned. */
contactSchema.index({ owner: 1, matchEmails: 1 })
contactSchema.index({ owner: 1, matchPhones: 1 })
contactSchema.index({ owner: 1, matchName: 1 })

/** Filters. */
contactSchema.index({ owner: 1, favorite: 1, isDeleted: 1 })
contactSchema.index({ owner: 1, company: 1, isDeleted: 1 })

/** Contacts belonging to one company — the company detail page. */
contactSchema.index({ owner: 1, companyId: 1, isDeleted: 1 })
contactSchema.index({ owner: 1, tags: 1, isDeleted: 1 })
contactSchema.index({ owner: 1, source: 1, isDeleted: 1 })

/**
 * The incremental sync feed (offline-first Phase 2).
 *
 * Same shape and the same reasoning as `lead_sync_feed` — see `lead.model.js`
 * for why `owner`, then `updatedAt`, then `_id`, and why it is not filtered on
 * `isDeleted`.
 */
contactSchema.index({ owner: 1, updatedAt: 1, _id: 1 }, { name: 'contact_sync_feed' })

/**
 * Full-text search across the fields a user would search by.
 *
 * Weighted so a name match outranks a note that happens to mention the word —
 * searching "Priya" should surface Priya before a contact whose notes say
 * "introduced by Priya".
 */
contactSchema.index(
  { displayName: 'text', company: 'text', primaryEmail: 'text', notes: 'text', tags: 'text' },
  {
    name: 'contact_search',
    weights: { displayName: 10, primaryEmail: 8, company: 5, tags: 3, notes: 1 },
  },
)

// --- Serialisation ---------------------------------------------------------

/** Compact shape for list views. Never includes the photo bytes or notes. */
contactSchema.methods.toSummaryJSON = function toSummaryJSON() {
  return {
    id: this._id.toString(),
    firstName: this.firstName,
    lastName: this.lastName,
    displayName: this.displayName,
    company: this.company,
    jobTitle: this.jobTitle,
    primaryEmail: this.primaryEmail,
    mobile: this.mobile,
    businessPhone: this.businessPhone,
    city: this.city,
    country: this.country,
    tags: this.tags,
    category: this.category,
    categoryLabel: CONTACT_CATEGORY_LABELS[this.category] ?? this.category,
    favorite: this.favorite,
    source: this.source,
    sourceLabel: CONTACT_SOURCE_LABELS[this.source] ?? this.source,
    syncStatus: this.syncStatus,
    syncStatusLabel: CONTACT_SYNC_STATUS_LABELS[this.syncStatus] ?? this.syncStatus,
    hasPhoto: Boolean(this.photo?.contentType),
    lastInteraction: this.lastInteraction,
    leadSource: this.leadSource,
    leadStatus: this.leadStatus,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

/** Full shape for the detail endpoint. */
contactSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    ...this.toSummaryJSON(),
    secondaryEmail: this.secondaryEmail,
    phone: this.phone,
    website: this.website,
    address: this.address,
    state: this.state,
    postalCode: this.postalCode,
    notes: this.notes,
    birthday: this.birthday,
    provider: this.provider,
    providerContactId: this.providerContactId,
    lastSyncedAt: this.lastSyncedAt,
    deletedRemotelyAt: this.deletedRemotelyAt,
    isDeleted: this.isDeleted,
    createdBy: this.createdBy?.toString() ?? null,
    updatedBy: this.updatedBy?.toString() ?? null,

    // --- Phase 7 ---
    uuid: this.uuid,
    leadSource: this.leadSource,
    leadStatus: this.leadStatus,
    companyId: this.companyId?.toString() ?? null,
    designation: this.designation,
    department: this.department,
    additionalEmails: this.additionalEmails,
    phones: this.phones,
    leadCount: this.leadCount,
    importJob: this.importJob?.toString() ?? null,
    importRow: this.importRow,
    customFields: this.customFields ? Object.fromEntries(this.customFields) : null,
  }
}

export const Contact = mongoose.model('Contact', contactSchema)

export { CONTACT_SOURCE, CONTACT_SYNC_STATUS }
export default Contact
