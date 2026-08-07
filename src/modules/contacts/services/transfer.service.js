/**
 * Import and export.
 *
 * One module for both directions because they share a column map — a field
 * renamed on one side and not the other produces files that cannot be
 * re-imported, and the only reliable way to prevent that is to define the
 * mapping once.
 *
 * ## Imports never overwrite silently
 *
 * The default mode is `skip_duplicates`. An import is bulk and hard to review
 * afterwards, so the safe outcome — add what is new, leave what exists — is the
 * one that happens when the caller does not choose. `merge` fills blanks;
 * `overwrite` replaces, and must be asked for explicitly.
 */

import { Contact } from '../../../models/contact.model.js'
import {
  CONTACT_CATEGORY,
  CONTACT_SOURCE,
  CONTACT_SYNC_STATUS,
  IMPORT_MODE,
  TRANSFER_FORMAT,
} from '../constants/contactConstants.js'
import { fromCsv, toCsv } from '../utils/csv.js'
import { fromVCardFile, toVCardFile } from '../utils/vcard.js'
import { fromXlsx, toXlsx } from '../utils/xlsx.js'
import { findDuplicates, mergeContacts } from './duplicate.service.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('contact-transfer')

/**
 * Column headers ⇄ contact fields.
 *
 * Headers are human-readable because these files are opened in Excel by people,
 * not machines. The reverse map is built from this one, so the two can never
 * disagree.
 */
export const COLUMN_MAP = Object.freeze({
  'First Name': 'firstName',
  'Last Name': 'lastName',
  'Display Name': 'displayName',
  Company: 'company',
  'Job Title': 'jobTitle',
  'Primary Email': 'primaryEmail',
  'Secondary Email': 'secondaryEmail',
  Mobile: 'mobile',
  'Business Phone': 'businessPhone',
  'Home Phone': 'phone',
  Website: 'website',
  Address: 'address',
  City: 'city',
  State: 'state',
  Country: 'country',
  'Postal Code': 'postalCode',
  Category: 'category',
  Tags: 'tags',
  Favorite: 'favorite',
  Notes: 'notes',
  Birthday: 'birthday',
  Source: 'source',
})

export const EXPORT_HEADERS = Object.freeze(Object.keys(COLUMN_MAP))

/**
 * Alternative spellings accepted on import.
 *
 * Real files come from Outlook, Google Contacts and hand-made spreadsheets, all
 * of which name these columns differently. Rejecting a file because it says
 * "E-mail Address" rather than "Primary Email" would be needlessly hostile.
 */
const HEADER_ALIASES = Object.freeze({
  'first name': 'firstName',
  firstname: 'firstName',
  given_name: 'firstName',
  'given name': 'firstName',
  'last name': 'lastName',
  lastname: 'lastName',
  surname: 'lastName',
  'family name': 'lastName',
  name: 'displayName',
  'full name': 'displayName',
  'display name': 'displayName',
  'display_name': 'displayName',
  organisation: 'company',
  organization: 'company',
  employer: 'company',
  'job title': 'jobTitle',
  title: 'jobTitle',
  position: 'jobTitle',
  role: 'jobTitle',
  email: 'primaryEmail',
  'e-mail': 'primaryEmail',
  'e-mail address': 'primaryEmail',
  'email address': 'primaryEmail',
  'primary email': 'primaryEmail',
  'email 1': 'primaryEmail',
  'email 2': 'secondaryEmail',
  'secondary email': 'secondaryEmail',
  'mobile phone': 'mobile',
  cell: 'mobile',
  'cell phone': 'mobile',
  'business phone': 'businessPhone',
  'work phone': 'businessPhone',
  'home phone': 'phone',
  phone: 'phone',
  'phone number': 'phone',
  'web page': 'website',
  url: 'website',
  street: 'address',
  'street address': 'address',
  town: 'city',
  county: 'state',
  region: 'state',
  province: 'state',
  'postal code': 'postalCode',
  postcode: 'postalCode',
  zip: 'postalCode',
  'zip code': 'postalCode',
  categories: 'tags',
  labels: 'tags',
  tag: 'tags',
  note: 'notes',
  comments: 'notes',
  remark: 'notes',
  remarks: 'notes',
  birthday: 'birthday',
  dob: 'birthday',

  /**
   * Vocabulary used by real sales spreadsheets.
   *
   * Their absence made an import of the company sales workbook fail every one
   * of its 1,698 rows with "No name or email.", because "Contact Person" and
   * "Email ID" resolved to nothing and the mapped row came out as
   * `{ city: "Hydrabad", displayName: null }`. The data was intact at every
   * stage before this table; it was discarded here.
   */
  'contact person': 'displayName',
  'contact name': 'displayName',
  'client name': 'displayName',
  'customer name': 'displayName',
  'person name': 'displayName',
  'email id': 'primaryEmail',
  'mail id': 'primaryEmail',
  'e-mail id': 'primaryEmail',
  'email-id': 'primaryEmail',
  'contact no': 'phone',
  'contact no.': 'phone',
  'contact number': 'phone',
  'mobile no': 'mobile',
  'mobile no.': 'mobile',
  'mobile number': 'mobile',
  'phone no': 'phone',
  'phone no.': 'phone',
  'agency': 'company',
  'agency name': 'company',
  'company name': 'company',
  'firm': 'company',
})

/** Resolves a file's header to a contact field, or null if unrecognised. */
function resolveHeader(header) {
  const trimmed = String(header ?? '').trim()
  if (trimmed === '') return null

  if (COLUMN_MAP[trimmed]) return COLUMN_MAP[trimmed]

  return HEADER_ALIASES[trimmed.toLowerCase()] ?? null
}

/** Formats a contact as one export row. */
function toRow(contact) {
  const row = {}

  for (const [header, field] of Object.entries(COLUMN_MAP)) {
    let value = contact[field]

    if (field === 'tags') value = (contact.tags ?? []).join(', ')
    else if (field === 'favorite') value = contact.favorite ? 'Yes' : 'No'
    else if (field === 'birthday' && contact.birthday) {
      value = new Date(contact.birthday).toISOString().slice(0, 10)
    }

    row[header] = value ?? ''
  }

  return row
}

/**
 * Exports contacts in the requested format.
 *
 * @returns {{ buffer: Buffer, filename: string, contentType: string }}
 */
export function exportContacts({ contacts, format = TRANSFER_FORMAT.CSV }) {
  const stamp = new Date().toISOString().slice(0, 10)

  if (format === TRANSFER_FORMAT.VCF) {
    return {
      buffer: Buffer.from(toVCardFile(contacts), 'utf8'),
      filename: `contacts-${stamp}.vcf`,
      contentType: 'text/vcard; charset=utf-8',
    }
  }

  if (format === TRANSFER_FORMAT.XLSX) {
    return {
      buffer: toXlsx(EXPORT_HEADERS, contacts.map(toRow)),
      filename: `contacts-${stamp}.xlsx`,
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }
  }

  if (format === TRANSFER_FORMAT.JSON) {
    return {
      buffer: Buffer.from(JSON.stringify(contacts.map(toRow), null, 2), 'utf8'),
      filename: `contacts-${stamp}.json`,
      contentType: 'application/json; charset=utf-8',
    }
  }

  /**
   * A UTF-8 BOM is prepended to CSV.
   *
   * Excel on Windows assumes the system codepage without it, so any accented
   * name — Almeida, Bergström, Sørensen — renders as mojibake. The BOM is the
   * only reliable signal Excel honours.
   */
  const csv = toCsv(EXPORT_HEADERS, contacts.map(toRow))

  return {
    buffer: Buffer.from(`﻿${csv}`, 'utf8'),
    filename: `contacts-${stamp}.csv`,
    contentType: 'text/csv; charset=utf-8',
  }
}

/** Normalises one parsed row into contact fields. */
function toContactFields(row) {
  const contact = {}

  for (const [header, rawValue] of Object.entries(row)) {
    const field = resolveHeader(header)
    if (!field) continue

    const value = String(rawValue ?? '').trim()
    if (value === '') continue

    if (field === 'tags') {
      contact.tags = value
        .split(/[,;]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    } else if (field === 'favorite') {
      contact.favorite = /^(yes|true|1|y)$/i.test(value)
    } else if (field === 'birthday') {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) contact.birthday = date
    } else if (field === 'category') {
      const lowered = value.toLowerCase()
      // An unrecognised category becomes `other` rather than failing the row —
      // one odd value should not reject an otherwise good import.
      contact.category = Object.values(CONTACT_CATEGORY).includes(lowered)
        ? lowered
        : CONTACT_CATEGORY.OTHER
    } else if (field === 'source') {
      // Ignored: source describes how the record entered this system, and a file
      // cannot claim to be an Outlook sync.
      continue
    } else {
      contact[field] = value
    }
  }

  if (!contact.displayName) {
    contact.displayName =
      [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
      contact.primaryEmail ||
      null
  }

  return contact
}

/** Parses an uploaded file into contact-shaped rows. */
export function parseImportFile({ content, format }) {
  if (format === TRANSFER_FORMAT.VCF) {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content)
    return fromVCardFile(text)
  }

  if (format === TRANSFER_FORMAT.XLSX) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'base64')
    return fromXlsx(buffer).rows.map(toContactFields)
  }

  if (format === TRANSFER_FORMAT.JSON) {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content)
    const parsed = JSON.parse(text)
    return (Array.isArray(parsed) ? parsed : []).map(toContactFields)
  }

  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content)
  return fromCsv(text).rows.map(toContactFields)
}

/**
 * Imports parsed rows.
 *
 * Every row is reported individually so a partial success is legible: "412
 * imported, 6 skipped, 2 failed" with the reasons, rather than one opaque
 * outcome for the whole file.
 *
 * @returns {Promise<object>} A summary with per-row detail for anything unusual.
 */
export async function importContacts({
  rows,
  owner,
  createdBy = null,
  mode = IMPORT_MODE.SKIP_DUPLICATES,
  defaultTags = [],
}) {
  const summary = {
    total: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    details: [],
  }

  for (const [index, row] of rows.entries()) {
    // Row numbers are 1-based and account for the header, so they match what the
    // user sees in their spreadsheet.
    const rowNumber = index + 2

    // A row with nothing addressable and no name cannot become a contact.
    if (!row.displayName && !row.primaryEmail && !row.firstName && !row.lastName) {
      summary.failed += 1
      summary.details.push({ row: rowNumber, outcome: 'failed', reason: 'No name or email.' })
      continue
    }

    try {
      const duplicates = await findDuplicates({ candidate: row, owner })
      const match = duplicates[0]

      if (match && mode === IMPORT_MODE.SKIP_DUPLICATES) {
        summary.skipped += 1
        summary.details.push({
          row: rowNumber,
          outcome: 'skipped',
          reason: `Matches "${match.contact.displayName}" on ${match.strategy}.`,
          contactId: match.contact._id.toString(),
        })
        continue
      }

      if (match && mode === IMPORT_MODE.MERGE) {
        const { changes } = mergeContacts({ existing: match.contact, incoming: row })

        if (Object.keys(changes).length === 0) {
          summary.skipped += 1
          summary.details.push({
            row: rowNumber,
            outcome: 'skipped',
            reason: 'Nothing new to merge.',
            contactId: match.contact._id.toString(),
          })
          continue
        }

        Object.assign(match.contact, changes)
        match.contact.updatedBy = createdBy
        await match.contact.save()

        summary.updated += 1
        summary.details.push({
          row: rowNumber,
          outcome: 'updated',
          reason: `Merged ${Object.keys(changes).length} field(s).`,
          contactId: match.contact._id.toString(),
        })
        continue
      }

      if (match && mode === IMPORT_MODE.OVERWRITE) {
        Object.assign(match.contact, row)
        match.contact.updatedBy = createdBy
        await match.contact.save()

        summary.updated += 1
        summary.details.push({
          row: rowNumber,
          outcome: 'updated',
          reason: 'Overwritten.',
          contactId: match.contact._id.toString(),
        })
        continue
      }

      const created = await Contact.create({
        ...row,
        tags: [...new Set([...(row.tags ?? []), ...defaultTags])],
        owner,
        createdBy,
        updatedBy: createdBy,
        source: CONTACT_SOURCE.IMPORT,
        syncStatus: CONTACT_SYNC_STATUS.LOCAL,
      })

      summary.created += 1
      summary.details.push({
        row: rowNumber,
        outcome: 'created',
        contactId: created._id.toString(),
      })
    } catch (error) {
      // One bad row must never abandon the rest of the file.
      summary.failed += 1
      summary.details.push({
        row: rowNumber,
        outcome: 'failed',
        reason: error?.message ?? String(error),
      })
    }
  }

  log.info('Contact import complete', {
    total: summary.total,
    created: summary.created,
    updated: summary.updated,
    skipped: summary.skipped,
    failed: summary.failed,
    mode,
  })

  return summary
}

export default { exportContacts, parseImportFile, importContacts, COLUMN_MAP, EXPORT_HEADERS }
