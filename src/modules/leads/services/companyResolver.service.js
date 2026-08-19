/**
 * Resolves the Company and Contact behind each imported row.
 *
 * ## The shape of the problem
 *
 * A row names a firm ("Tirupati Holidays"), a person ("Anju Peliwal") and an
 * address. None of them is a key. Across 1,698 rows the workbook contains 562
 * companies, 719 people and 1,686 enquiries, so the same firm and the same
 * person recur constantly and must be recognised rather than duplicated.
 *
 * ## Why identity is a domain first, a name second
 *
 * Measured on the real file, matching companies on trading name alone is wrong
 * in both directions: it splits 34 firms typed several ways
 * (`Icoon`/`Icconic`/`Iccon Holidays`, all `icconholidays.com`) and merges 14
 * that are genuinely separate (`akbarholidays.com`, `akbarcorporate.in` and
 * `akbartravels.in` all reduce to "akbar"). A domain is chosen by the company
 * and typed by nobody, so it is the stabler key — except for the 330 rows on
 * Gmail and friends, where there is no domain and the name is all there is.
 *
 * ## Caching
 *
 * An import of 1,700 rows would otherwise issue ~3,400 lookups for a few
 * hundred distinct organisations. The cache is per-run and in-memory, so it
 * cannot go stale across imports.
 */

import { Company, companyMatchKey, normaliseCompanyName, organisationDomain } from '../../../models/company.model.js'
import { Contact } from '../../../models/contact.model.js'
import { createContextLogger } from '../../../utils/logger.js'
import { COMPANY_STATUS } from '../constants/leadConstants.js'

const log = createContextLogger('lead-import')

/** Derives a short display code, e.g. "Flamingo Travels" -> FLAMINGO. */
function deriveCompanyCode(name) {
  const words = normaliseCompanyName(name).split(' ').filter(Boolean)
  if (words.length === 0) return null
  return words.slice(0, 2).join('').slice(0, 12).toUpperCase()
}

/**
 * Per-import resolution cache.
 *
 * Created fresh for each run by `createResolver`.
 */
export function createResolver({ owner, importJob = null, createdBy = null }) {
  /** matchKey -> Company document */
  const companyCache = new Map()
  /** normalised email -> Contact document */
  const contactCache = new Map()

  const stats = {
    companiesCreated: 0,
    companiesReused: 0,
    contactsCreated: 0,
    contactsReused: 0,
  }

  /**
   * Finds or creates the company behind a row.
   *
   * @param {{ companyName: ?string, email: ?string, city: ?string }} row
   * @returns {Promise<?object>} Null when the row names no company at all.
   */
  async function resolveCompany({ companyName, email, city = null }) {
    const matchKey = companyMatchKey({ email, name: companyName })
    if (!matchKey) return null

    const cached = companyCache.get(matchKey)
    if (cached) {
      stats.companiesReused += 1
      // A later row may spell the name differently; keep every spelling so a
      // merge can be explained rather than looking arbitrary.
      if (companyName && !cached.aliases.includes(companyName) && cached.companyName !== companyName) {
        cached.aliases.push(companyName)
        await cached.save()
      }
      return cached
    }

    const existing = await Company.findOne({ owner, matchKey, isDeleted: false })

    if (existing) {
      stats.companiesReused += 1
      if (companyName && existing.companyName !== companyName && !existing.aliases.includes(companyName)) {
        existing.aliases.push(companyName)
        await existing.save()
      }
      companyCache.set(matchKey, existing)
      return existing
    }

    const domain = organisationDomain(email)

    /**
     * `findOneAndUpdate` with upsert rather than `create`.
     *
     * Two rows for the same firm can be processed close together, and the
     * unique index would reject the second `create` outright. An upsert turns
     * that race into the reuse it should have been.
     */
    const company = await Company.findOneAndUpdate(
      { owner, matchKey },
      {
        $setOnInsert: {
          owner,
          createdBy,
          matchKey,
          companyName: companyName || domain || 'Unknown company',
          companyCode: deriveCompanyCode(companyName || domain),
          emailDomain: domain,
          city,
          status: COMPANY_STATUS.ACTIVE,
          importJob,
          isDeleted: false,
        },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    )

    stats.companiesCreated += 1
    companyCache.set(matchKey, company)
    return company
  }

  /**
   * Finds or creates the person behind a row.
   *
   * Keyed on email, which for a person genuinely is unique — unlike the
   * company name. A contact found by email is updated, never duplicated:
   * `pooja@flamingotravels.co.in` must remain one person across her 183
   * enquiries.
   *
   * @returns {Promise<?object>}
   */
  async function resolveContact({
    email,
    displayName,
    firstName,
    lastName,
    companyName,
    company,
    phones = [],
    additionalEmails = [],
    city = null,
  }) {
    if (!email) return null

    const key = email.toLowerCase()
    const cached = contactCache.get(key)
    if (cached) {
      stats.contactsReused += 1
      return cached
    }

    const existing = await Contact.findOne({ owner, primaryEmail: key, isDeleted: false })

    if (existing) {
      stats.contactsReused += 1

      // Fill gaps without overwriting anything a human may have corrected in
      // the CRM. The sheet is the source for new facts, not a licence to undo
      // curation.
      if (!existing.companyId && company) existing.companyId = company._id
      if (!existing.company && companyName) existing.company = companyName
      if (!existing.displayName && displayName) existing.displayName = displayName
      if (!existing.city && city) existing.city = city
      if (!existing.phone && phones[0]) existing.phone = phones[0]

      for (const phone of phones) {
        if (!existing.phones.includes(phone)) existing.phones.push(phone)
      }
      for (const extra of additionalEmails) {
        if (!existing.additionalEmails.includes(extra)) existing.additionalEmails.push(extra)
      }

      await existing.save()
      contactCache.set(key, existing)
      return existing
    }

    const contact = await Contact.findOneAndUpdate(
      { owner, primaryEmail: key },
      {
        $setOnInsert: {
          owner,
          primaryEmail: key,
          additionalEmails,
          firstName,
          lastName,
          displayName,
          company: companyName,
          companyId: company?._id ?? null,
          phone: phones[0] ?? null,
          phones,
          city,
          source: 'import',
          leadSource: companyName ?? null,
          importJob,
          isDeleted: false,
        },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    )

    stats.contactsCreated += 1
    contactCache.set(key, contact)
    return contact
  }

  /**
   * Recomputes the denormalised counters for everything this run touched.
   *
   * Done once at the end rather than per row: the same company appears on up to
   * 198 rows, and recounting on each would be 198 aggregations for one number.
   */
  async function finalise() {
    for (const company of companyCache.values()) {
      await company.recount()
    }

    /*
     * Contact lead counts, for every contact this import touched.
     *
     * ## Two round-trips, not two per contact
     *
     * This counted one contact at a time and saved each changed document
     * individually — a `countDocuments` and possibly a `save()` per contact. On
     * a workbook touching a thousand contacts that is a couple of thousand
     * sequential round-trips, and the cost is latency rather than indexes:
     * `{ contact: 1 }` makes each count fast, but not free to issue.
     *
     * One `$group` returns every count, and one `bulkWrite` applies them.
     *
     * ## Why a contact missing from the aggregate is set to zero
     *
     * `$group` only emits ids that matched. A contact whose last enquiry was
     * deleted produces no bucket at all, and leaving it alone would preserve a
     * stale non-zero count — the exact case the recount exists to correct. So
     * the map is read with `?? 0` rather than iterated.
     *
     * ## Why `bulkWrite` is safe here despite the `pre('save')` hook
     *
     * `contactSchema.pre('save')` runs `deriveContactFields`, which derives
     * `displayName`, `matchEmails`, `matchPhones` and `matchName` from the name,
     * email and phone fields. None of them reads `leadCount`, and `leadCount`
     * feeds none of them — so a `leadCount`-only write has nothing to re-derive.
     * The derived values stay whatever the last real `save()` produced.
     */
    const Lead = (await import('../../../models/lead.model.js')).Lead

    const contacts = [...contactCache.values()]
    const contactIds = contacts.map((contact) => contact._id)

    if (contactIds.length > 0) {
      const grouped = await Lead.aggregate([
        { $match: { contact: { $in: contactIds }, isDeleted: false } },
        { $group: { _id: '$contact', count: { $sum: 1 } } },
      ])

      const countById = new Map(grouped.map((row) => [String(row._id), row.count]))

      const operations = []

      for (const contact of contacts) {
        const count = countById.get(String(contact._id)) ?? 0
        if (contact.leadCount === count) continue

        // The in-memory document is updated too, so anything downstream in this
        // import reads the same value the database now holds.
        contact.leadCount = count
        operations.push({
          updateOne: { filter: { _id: contact._id }, update: { $set: { leadCount: count } } },
        })
      }

      // Only contacts whose value actually moved, exactly as before.
      if (operations.length > 0) await Contact.bulkWrite(operations)
    }

    log.info('Import resolution finished', {
      ...stats,
      distinctCompanies: companyCache.size,
      distinctContacts: contactCache.size,
    })

    return { ...stats, distinctCompanies: companyCache.size, distinctContacts: contactCache.size }
  }

  return { resolveCompany, resolveContact, finalise, stats }
}

export default { createResolver }
