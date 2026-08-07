/**
 * Row validation and normalisation.
 *
 * Runs on every row before it becomes a contact. Two jobs, deliberately kept
 * together because they operate on the same value at the same moment: deciding
 * whether a value is usable, and cleaning it if it is.
 *
 * ## The bar for rejection is low
 *
 * A bulk import of 5,000 rows that rejects 400 for being imperfect is a worse
 * outcome than one that imports them with the odd untidy phone number. Only
 * values that would actively break something downstream are rejected — a
 * malformed email, because a campaign cannot send to it — and everything else is
 * normalised as far as it can be and kept.
 */

import {
  IMPORT_FIELD,
  LEAD_STATUS,
  LEAD_STATUS_VALUES,
  ROW_STATUS,
} from '../constants/importConstants.js'
import { CONTACT_CATEGORY, CONTACT_CATEGORY_VALUES } from '../../contacts/constants/contactConstants.js'

/**
 * Practical email pattern.
 *
 * Deliberately not RFC 5322 — that grammar accepts addresses no mail server
 * routes and is famously unreadable. This checks the shape a campaign can
 * actually deliver to: a local part, an `@`, a domain with a dot and a TLD of at
 * least two characters.
 */
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i

/** Obvious placeholders that appear in spreadsheets where an address is unknown. */
const PLACEHOLDER_EMAILS = new Set([
  'n/a', 'na', 'none', 'nil', 'null', '-', '--', 'tbd', 'unknown',
  'no email', 'noemail', 'not available', 'test@test.com', 'a@a.com',
  'email@email.com', 'xxx@xxx.com', 'abc@abc.com',
])

/**
 * Cleans and validates an email.
 *
 * Handles the two shapes spreadsheets actually contain beyond a bare address:
 * `Name <a@b.com>` pasted from a mail client, and several addresses crammed into
 * one cell separated by commas or semicolons. In the second case the first is
 * taken and the rest reported, rather than rejecting a row that plainly has a
 * usable address.
 *
 * @param {*} value
 * @returns {{ value: ?string, valid: boolean, message: ?string, extra: string[] }}
 */
export function validateEmail(value) {
  const raw = String(value ?? '').trim()

  if (raw === '') return { value: null, valid: false, message: 'Email is empty.', extra: [] }

  if (PLACEHOLDER_EMAILS.has(raw.toLowerCase())) {
    return { value: null, valid: false, message: `"${raw}" is a placeholder, not an address.`, extra: [] }
  }

  // `Display Name <address@example.com>` → the address.
  const angled = /<([^>]+)>/.exec(raw)
  const candidate = angled ? angled[1].trim() : raw

  const parts = candidate.split(/[,;]/).map((part) => part.trim()).filter(Boolean)
  const [first, ...rest] = parts

  const cleaned = String(first ?? '').toLowerCase()

  if (!EMAIL_PATTERN.test(cleaned)) {
    return { value: null, valid: false, message: `"${raw}" is not a valid email address.`, extra: [] }
  }

  return {
    value: cleaned,
    valid: true,
    message: rest.length > 0 ? `Cell held ${parts.length} addresses; the first was used.` : null,
    extra: rest.map((entry) => entry.toLowerCase()).filter((entry) => EMAIL_PATTERN.test(entry)),
  }
}

/**
 * Normalises a phone number without rejecting it.
 *
 * Spreadsheets mangle phone numbers in predictable ways — Excel strips leading
 * zeros, renders long numbers in scientific notation, and users type extensions
 * inline. All three are repaired here rather than treated as errors, because a
 * phone number is never the reason to discard a lead.
 *
 * @param {*} value
 * @returns {{ value: ?string, valid: boolean, message: ?string }}
 */
export function validatePhone(value) {
  let raw = String(value ?? '').trim()

  if (raw === '') return { value: null, valid: true, message: null }

  let message = null

  /**
   * Excel turns a long number into `9.19876543211e+11`. The digits are still
   * there, so the exponent is expanded rather than the row being failed.
   */
  const scientific = /^(\d(?:\.\d+)?)e\+?(\d+)$/i.exec(raw)
  if (scientific) {
    const expanded = Number(raw)
    if (Number.isFinite(expanded)) {
      raw = expanded.toFixed(0)
      message = 'Recovered from scientific notation.'
    }
  }

  // Keep the extension separate so it is not mistaken for part of the number.
  const extension = /(?:ext|x|extn)\.?\s*(\d{1,6})\s*$/i.exec(raw)
  const withoutExtension = extension ? raw.slice(0, extension.index).trim() : raw

  const hasPlus = withoutExtension.trimStart().startsWith('+')
  const digits = withoutExtension.replace(/\D/g, '')

  if (digits.length < 6) {
    return { value: null, valid: false, message: `"${raw}" has too few digits to be a phone number.` }
  }

  if (digits.length > 15) {
    // E.164 caps at 15 digits. More than that is two numbers in one cell.
    return { value: null, valid: false, message: `"${raw}" has too many digits to be one number.` }
  }

  const formatted = `${hasPlus ? '+' : ''}${digits}${extension ? ` ext ${extension[1]}` : ''}`

  return { value: formatted, valid: true, message }
}

/**
 * Normalises a website.
 *
 * A bare domain gets `https://` prepended — sheets almost never include the
 * scheme, and a URL without one is not a link the UI can render.
 */
export function validateWebsite(value) {
  const raw = String(value ?? '').trim()

  if (raw === '') return { value: null, valid: true, message: null }

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`

  try {
    const url = new URL(candidate)

    // A hostname with no dot is not a public site — usually a stray word.
    if (!url.hostname.includes('.')) {
      return { value: null, valid: false, message: `"${raw}" is not a valid website.` }
    }

    return {
      value: url.toString().replace(/\/$/, ''),
      valid: true,
      message: /^https?:\/\//i.test(raw) ? null : 'Assumed https://.',
    }
  } catch {
    return { value: null, valid: false, message: `"${raw}" is not a valid website.` }
  }
}

/** Trims, collapses whitespace and caps length. Never rejects. */
export function cleanText(value, maxLength = 256) {
  const cleaned = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned === '') return null

  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned
}

/**
 * Maps a lead status from a sheet onto the pipeline vocabulary.
 *
 * Unrecognised values fall back to `new` rather than failing the row: a sheet
 * saying "Hot" is telling us something, but not something this enum models, and
 * discarding the lead over it would be absurd.
 */
export function normaliseLeadStatus(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')

  if (raw === '') return LEAD_STATUS.NEW
  if (LEAD_STATUS_VALUES.includes(raw)) return raw

  return {
    open: LEAD_STATUS.NEW,
    fresh: LEAD_STATUS.NEW,
    hot: LEAD_STATUS.ENGAGED,
    warm: LEAD_STATUS.CONTACTED,
    cold: LEAD_STATUS.NEW,
    interested: LEAD_STATUS.ENGAGED,
    replied: LEAD_STATUS.ENGAGED,
    won: LEAD_STATUS.CUSTOMER,
    closed: LEAD_STATUS.CUSTOMER,
    lost: LEAD_STATUS.UNQUALIFIED,
    dead: LEAD_STATUS.UNQUALIFIED,
    rejected: LEAD_STATUS.UNQUALIFIED,
    dnc: LEAD_STATUS.DO_NOT_CONTACT,
    unsubscribed: LEAD_STATUS.DO_NOT_CONTACT,
  }[raw] ?? LEAD_STATUS.NEW
}

/** Maps a category, defaulting to `lead` — a bulk import is prospecting data. */
function normaliseCategory(value) {
  const raw = String(value ?? '').trim().toLowerCase()

  if (CONTACT_CATEGORY_VALUES.includes(raw)) return raw

  return { prospect: CONTACT_CATEGORY.LEAD, client: CONTACT_CATEGORY.CUSTOMER, supplier: CONTACT_CATEGORY.VENDOR }[raw] ??
    CONTACT_CATEGORY.LEAD
}

/** Splits a tag cell on the separators sheets actually use. */
function parseTags(value) {
  return String(value ?? '')
    .split(/[,;|]/)
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 50)
}

/**
 * Applies a column mapping to one raw row and validates the result.
 *
 * @param {object} params
 * @param {object} params.row Raw row, keyed by the file's own headers.
 * @param {Array<{ column: string, field: string }>} params.mapping
 * @param {number} params.rowNumber 1-based, counting the header.
 * @returns {{ contact: object, status: string, issues: Array<object>, custom: object }}
 */
export function validateRow({ row, mapping, rowNumber }) {
  const contact = {}
  const custom = {}
  const issues = []

  const note = (status, field, message, value = null) =>
    issues.push({ row: rowNumber, status, field, message, value: value ? String(value).slice(0, 200) : null })

  let hasAnyValue = false

  for (const entry of mapping) {
    const raw = row[entry.column]

    if (String(raw ?? '').trim() !== '') hasAnyValue = true

    if (entry.field === IMPORT_FIELD.IGNORE) {
      // Unmapped columns are preserved rather than discarded — see the note on
      // `customFields` in the Contact model.
      const value = cleanText(raw, 500)
      if (value) custom[entry.column] = value
      continue
    }

    switch (entry.field) {
      case IMPORT_FIELD.PRIMARY_EMAIL:
      case IMPORT_FIELD.SECONDARY_EMAIL: {
        if (String(raw ?? '').trim() === '') break

        const result = validateEmail(raw)

        if (!result.valid) {
          note(ROW_STATUS.INVALID, entry.field, result.message, raw)
          break
        }

        contact[entry.field] = result.value

        // A second address found in the same cell fills the secondary slot
        // rather than being thrown away.
        if (result.extra.length > 0 && !contact.secondaryEmail) {
          contact.secondaryEmail = result.extra[0]
        }

        if (result.message) note(ROW_STATUS.VALID, entry.field, result.message, raw)
        break
      }

      case IMPORT_FIELD.PHONE:
      case IMPORT_FIELD.MOBILE:
      case IMPORT_FIELD.BUSINESS_PHONE: {
        const result = validatePhone(raw)

        if (!result.valid) {
          note(ROW_STATUS.INVALID, entry.field, result.message, raw)
          break
        }

        if (result.value) contact[entry.field] = result.value
        if (result.message) note(ROW_STATUS.VALID, entry.field, result.message, raw)
        break
      }

      case IMPORT_FIELD.WEBSITE: {
        const result = validateWebsite(raw)
        if (!result.valid) {
          note(ROW_STATUS.INVALID, entry.field, result.message, raw)
          break
        }
        if (result.value) contact.website = result.value
        break
      }

      case IMPORT_FIELD.TAGS:
        contact.tags = parseTags(raw)
        break

      case IMPORT_FIELD.CATEGORY:
        contact.category = normaliseCategory(raw)
        break

      case IMPORT_FIELD.LEAD_STATUS:
        contact.leadStatus = normaliseLeadStatus(raw)
        break

      case IMPORT_FIELD.LEAD_SOURCE:
        contact.leadSource = cleanText(raw, 128)
        break

      case IMPORT_FIELD.NOTES:
        contact.notes = cleanText(raw, 10_000)
        break

      default:
        contact[entry.field] = cleanText(raw, 512)
        break
    }
  }

  // --- Derive a display name -----------------------------------------------
  //
  // A single "Contact Person" column holding "Priya Raman" is split, because the
  // CRM personalises campaigns with {{FirstName}} and "Dear Priya Raman" reads
  // like a mail merge that went wrong.
  if (!contact.firstName && contact.displayName) {
    const parts = contact.displayName.split(/\s+/)
    if (parts.length > 1) {
      contact.firstName = parts[0]
      contact.lastName = parts.slice(1).join(' ')
    } else {
      contact.firstName = contact.displayName
    }
  }

  if (!contact.displayName) {
    contact.displayName =
      [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.primaryEmail || null
  }

  // --- Classify -------------------------------------------------------------
  let status = ROW_STATUS.VALID

  if (!hasAnyValue) {
    status = ROW_STATUS.EMPTY
  } else if (!contact.primaryEmail) {
    // Not a hard failure: the row may still be a useful contact record, but it
    // cannot receive a campaign, which is what this CRM exists to do.
    status = ROW_STATUS.MISSING_EMAIL
    note(ROW_STATUS.MISSING_EMAIL, IMPORT_FIELD.PRIMARY_EMAIL, 'No usable email address.')
  } else if (issues.some((issue) => issue.status === ROW_STATUS.INVALID)) {
    status = ROW_STATUS.INVALID
  }

  return { contact, status, issues, custom }
}

export default {
  validateRow,
  validateEmail,
  validatePhone,
  validateWebsite,
  cleanText,
  normaliseLeadStatus,
}
