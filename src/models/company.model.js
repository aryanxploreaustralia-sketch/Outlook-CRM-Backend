/**
 * A travel agency, corporate client or B2B partner.
 *
 * The top of the hierarchy: a company employs many contacts, and each contact
 * raises many enquiries. The workbook proves this is not theoretical — Akbar
 * appears with 35 distinct people across 67 enquiries, Flamingo with 5 people
 * across 198.
 *
 * ## Why identity is a domain first and a name second
 *
 * Measured on the real sheet, matching on trading name alone gets it wrong in
 * both directions:
 *
 *   - **wrongly splitting** 34 companies, because one firm is typed several
 *     ways — "Icoon Holidays", "Icconic Holidays" and "Iccon Holidays" are all
 *     `icconholidays.com`;
 *   - **wrongly merging** 14, because stripping legal suffixes collapses
 *     genuinely separate entities — `akbarholidays.com`, `akbarcorporate.in`
 *     and `akbartravels.in` are different businesses that all normalise to
 *     "akbar".
 *
 * An email domain is chosen by the company itself and typed by nobody, so it is
 * the stabler key. It only fails for the 330 rows using Gmail and friends,
 * where there is no domain to speak of and the name is all that is left.
 */

import mongoose from 'mongoose'

import {
  COMPANY_NAME_NOISE,
  COMPANY_STATUS,
  COMPANY_STATUS_VALUES,
  GENERIC_EMAIL_DOMAINS,
} from '../modules/leads/constants/leadConstants.js'

const { Schema } = mongoose

/**
 * Reduces a trading name to a comparison key.
 *
 * Conservative on purpose — see the note above about over-normalising.
 *
 * @param {?string} name
 * @returns {string}
 */
export function normaliseCompanyName(name) {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

  if (!base) return ''

  const words = base.split(' ').filter((word) => word && !COMPANY_NAME_NOISE.includes(word))

  // Falling back to the unfiltered form matters: a company literally called
  // "The Company" would otherwise normalise to an empty string and collide with
  // every other unnamed record.
  return (words.length > 0 ? words.join(' ') : base).trim()
}

/**
 * Extracts the organisational domain from an address.
 *
 * @param {?string} email
 * @returns {?string} Null for a personal mail provider, which identifies no company.
 */
export function organisationDomain(email) {
  const at = String(email ?? '').toLowerCase().trim().lastIndexOf('@')
  if (at === -1) return null

  const domain = String(email).toLowerCase().trim().slice(at + 1)
  if (!domain || !domain.includes('.')) return null

  return GENERIC_EMAIL_DOMAINS.has(domain) ? null : domain
}

/**
 * The key a company is deduplicated on.
 *
 * Prefixed so the two kinds can never collide: a company named "example.com"
 * must not merge with the holder of the domain `example.com`.
 *
 * @returns {?string}
 */
export function companyMatchKey({ email = null, name = null } = {}) {
  const domain = organisationDomain(email)
  if (domain) return `domain:${domain}`

  const normalised = normaliseCompanyName(name)
  return normalised ? `name:${normalised}` : null
}

const companySchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /** As typed in the sheet, preserved for display. */
    companyName: { type: String, required: true, trim: true, maxlength: 256 },

    /**
     * The deduplication key. Unique per owner.
     *
     * Derived, never entered. Stored rather than computed on read so the unique
     * index can enforce it — the guarantee has to live in the database, or two
     * concurrent imports create two copies of the same agency.
     */
    matchKey: { type: String, required: true, trim: true },

    /** Short code for the UI and exports, e.g. `FLAMINGO`. Derived if absent. */
    companyCode: { type: String, trim: true, uppercase: true, default: null, maxlength: 32 },

    /** Set when identity came from a domain; null for personal-mail agencies. */
    emailDomain: { type: String, trim: true, lowercase: true, default: null, index: true },

    city: { type: String, trim: true, default: null, maxlength: 128 },
    state: { type: String, trim: true, default: null, maxlength: 128 },
    country: { type: String, trim: true, default: null, maxlength: 128, index: true },

    website: { type: String, trim: true, default: null, maxlength: 512 },
    phone: { type: String, trim: true, default: null, maxlength: 64 },
    email: { type: String, trim: true, lowercase: true, default: null, maxlength: 320 },

    /** Indian GST registration. Optional — the sheet does not carry it. */
    gstNumber: { type: String, trim: true, uppercase: true, default: null, maxlength: 32 },

    status: {
      type: String,
      enum: COMPANY_STATUS_VALUES,
      default: COMPANY_STATUS.ACTIVE,
      index: true,
    },

    /**
     * Denormalised roll-ups.
     *
     * The company list shows both for every row; aggregating leads per company
     * on each page view would be a `$group` over the whole lead collection for
     * information that changes only on import.
     */
    leadCount: { type: Number, default: 0, min: 0 },
    contactCount: { type: Number, default: 0, min: 0 },

    /** Newest enquiry, for the "dormant partner" view. */
    lastLeadAt: { type: Date, default: null },

    notes: { type: String, trim: true, default: null, maxlength: 2000 },

    /** Every spelling seen, so a merge can be explained afterwards. */
    aliases: { type: [String], default: [] },

    importJob: { type: Schema.Types.ObjectId, ref: 'ImportJob', default: null, index: true },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, versionKey: false },
)

/** The identity guarantee. Partial so soft-deleted rows never block a re-create. */
companySchema.index(
  { owner: 1, matchKey: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
)

/** Default list: this user's companies, busiest first. */
companySchema.index({ owner: 1, isDeleted: 1, leadCount: -1 })

/** Alphabetical list. */
companySchema.index({ owner: 1, isDeleted: 1, companyName: 1 })

/** Global search. */
companySchema.index(
  { companyName: 'text', aliases: 'text', city: 'text' },
  { name: 'company_search', weights: { companyName: 10, aliases: 6, city: 2 } },
)

/**
 * Recomputes the roll-ups from the leads and contacts that actually exist.
 *
 * The reconciliation path for the denormalisation above.
 */
companySchema.methods.recount = async function recount() {
  const Lead = mongoose.model('Lead')
  const Contact = mongoose.model('Contact')

  const [leads, contacts, newest] = await Promise.all([
    Lead.countDocuments({ company: this._id, isDeleted: false }),
    // `companyId` is the relational link; `company` on a Contact is the
    // employer's NAME, kept as a string for backward compatibility.
    Contact.countDocuments({ companyId: this._id, isDeleted: false }),
    Lead.findOne({ company: this._id, isDeleted: false }).sort({ quoteDate: -1 }).select('quoteDate'),
  ])

  this.leadCount = leads
  this.contactCount = contacts
  this.lastLeadAt = newest?.quoteDate ?? null

  await this.save()
  return { leadCount: leads, contactCount: contacts }
}

companySchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    companyName: this.companyName,
    companyCode: this.companyCode,
    matchKey: this.matchKey,
    emailDomain: this.emailDomain,
    city: this.city,
    state: this.state,
    country: this.country,
    website: this.website,
    phone: this.phone,
    email: this.email,
    gstNumber: this.gstNumber,
    status: this.status,
    leadCount: this.leadCount,
    contactCount: this.contactCount,
    lastLeadAt: this.lastLeadAt,
    notes: this.notes,
    aliases: this.aliases,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

export const Company = mongoose.model('Company', companySchema)

export default Company
