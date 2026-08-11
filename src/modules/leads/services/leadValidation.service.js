/**
 * Turns one spreadsheet row into a validated lead.
 *
 * Every rule here was written against the real workbook, not imagined. Where a
 * value is messy the default is to **keep it and record what could not be
 * understood**, rather than reject the row — a sales register that refuses 64%
 * of its own phone numbers is not a validator, it is an obstacle.
 *
 * Only three things make a row unusable: no reference (nothing to key on), no
 * email (nothing to campaign to), and no contact person (nobody to address).
 */

import {
  LEAD_FIELD,
  LEAD_STAGE,
  LEAD_STAGE_LABELS,
  LEAD_STAGE_ORDER,
  MARKET,
  SHEET_STATUS_TO_STAGE,
} from '../constants/leadConstants.js'

/** Permissive by design; it rejects "Benny Panikulangara", not unusual TLDs. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Separators seen between several addresses or numbers in one cell. */
const MULTI_VALUE_SPLIT = /[;,/]+|\s{2,}\|\s{2,}|\band\b/i

/**
 * Splits a cell holding one or more email addresses.
 *
 * Three cells in the workbook hold two addresses. Keeping only the first would
 * quietly drop a working contact route, so the rest are retained as secondary.
 *
 * @returns {{ primary: ?string, additional: string[], invalid: string[] }}
 */
export function parseEmails(value) {
  const text = String(value ?? '').trim()
  if (!text) return { primary: null, additional: [], invalid: [] }

  const candidates = text
    .split(MULTI_VALUE_SPLIT)
    .map((part) => part.trim().replace(/^[<(]|[>)]$/g, '').toLowerCase())
    .filter(Boolean)

  const valid = []
  const invalid = []

  for (const candidate of candidates) {
    if (EMAIL_PATTERN.test(candidate)) {
      if (!valid.includes(candidate)) valid.push(candidate)
    } else {
      invalid.push(candidate)
    }
  }

  return { primary: valid[0] ?? null, additional: valid.slice(1), invalid }
}

/**
 * Extracts every telephone number from one cell.
 *
 * The workbook writes things like `91 9100951112 ; 040 39555671 EXT 232` and
 * `Mob :+91 98403 76106 ; Tel: +91 44 4289…`. A validator expecting a single
 * number rejects 64% of the file. This finds each run of digits and keeps them
 * all, because a second number for a client is useful, not noise.
 *
 * @returns {string[]} Normalised numbers, longest-plausible first, deduplicated.
 */
export function parsePhones(value) {
  const text = String(value ?? '').trim()
  if (!text) return []

  // Split on separators, then on labels like "Mob:" / "Tel:" / "Ext".
  const chunks = text
    .split(/[;,/|]+|\s{2,}/)
    .flatMap((chunk) => chunk.split(/\b(?:ext|extn|extension)\b\.?/i))
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  const numbers = []

  for (const chunk of chunks) {
    // Strip the label, keep the number and a leading +.
    const cleaned = chunk.replace(/[^\d+]/g, '')
    if (!cleaned) continue

    const digits = cleaned.replace(/\D/g, '')

    // 7 digits is a short local landline; 15 is E.164's ceiling. Anything
    // outside that is a reference number or a mangled paste, not a phone.
    if (digits.length < 7 || digits.length > 15) continue

    const normalised = cleaned.startsWith('+') ? `+${digits}` : digits
    if (!numbers.includes(normalised)) numbers.push(normalised)
  }

  return numbers
}

/**
 * Reads a date cell.
 *
 * The parser hands dates over as ISO already; this also accepts what a human
 * may have typed into a date column.
 *
 * @returns {{ date: ?Date, text: ?string }}
 *   `text` is set only when the value could not be read as a date, so prose
 *   like "Low Season" survives instead of being discarded or invented into a
 *   date that then drives campaign scheduling.
 */
export function parseDateCell(value) {
  const text = String(value ?? '').trim()
  if (!text) return { date: null, text: null }

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const date = new Date(`${text.slice(0, 10)}T00:00:00.000Z`)
    if (!Number.isNaN(date.getTime())) return { date, text: null }
  }

  // d/m/y and d-m-y. Day-first: the workbook is Indian and Australian, where
  // 03/05 means 3 May. Guessing month-first would shift dates by months.
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text)
  if (dmy) {
    const day = Number(dmy[1])
    const month = Number(dmy[2])
    let year = Number(dmy[3])
    if (year < 100) year += year < 70 ? 2000 : 1900

    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const date = new Date(Date.UTC(year, month - 1, day))
      if (!Number.isNaN(date.getTime())) return { date, text: null }
    }
  }

  // A bare Excel serial, in case a caller passed an unformatted cell.
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Number(text)
    if (serial > 20_000 && serial < 60_000) {
      return { date: new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000)), text: null }
    }
  }

  return { date: null, text: text.slice(0, 128) }
}

/**
 * Reads a party size.
 *
 * 14 distinct shapes appear in the workbook: `2A`, `4A`, `2A + 2 C`, `2A2C`,
 * `100 Pax`, `15-35 Pax`, `10 A 1 C`, `45 Studens + 5 Teachers`. The text is
 * always preserved; the counts are a convenience and may legitimately be null.
 *
 * @returns {{ text: string, adults: ?number, children: ?number }}
 */
export function parsePax(value) {
  const text = String(value ?? '').trim()
  if (!text) return { text: null, adults: null, children: null }

  const compact = text.toLowerCase()

  // "2A + 2C", "10 A 1 C", "2a2c"
  const adultMatch = /(\d+)\s*a(?![a-z])/.exec(compact)
  const childMatch = /(\d+)\s*c(?![a-z])/.exec(compact)

  if (adultMatch) {
    return {
      text: text.slice(0, 128),
      adults: Number(adultMatch[1]),
      children: childMatch ? Number(childMatch[1]) : null,
    }
  }

  // "15-35 Pax" — a range. Tested BEFORE the plain "N Pax" rule, which would
  // otherwise match the upper bound and silently double the party size.
  // The lower bound is the only figure that can be committed to; quoting for
  // the upper one would overstate the enquiry.
  const rangeMatch = /^(\d+)\s*[-–]\s*(\d+)/.exec(compact)
  if (rangeMatch) return { text: text.slice(0, 128), adults: Number(rangeMatch[1]), children: null }

  // "100 Pax", "6 Pax", "3 Adults"
  const paxMatch = /(\d+)\s*(?:pax|adults?|persons?|people|travell?ers?)/.exec(compact)
  if (paxMatch) return { text: text.slice(0, 128), adults: Number(paxMatch[1]), children: null }

  const bare = /^(\d+)$/.exec(compact)
  if (bare) return { text: text.slice(0, 128), adults: Number(bare[1]), children: null }

  return { text: text.slice(0, 128), adults: null, children: null }
}

/**
 * Maps the sheet's `Status` word onto a stage.
 *
 * The workbook's words are the CRM's stages, so the common case is an
 * exact match and the value is carried across untranslated.
 *
 * An unrecognised word falls back to `active` and reports `recognised: false`
 * rather than throwing. Two reasons it must not throw: the team will invent
 * vocabulary, and an import that fails on one odd status is an import that
 * fails every month. It must equally never store the word it was given — the
 * stage is a closed enum, and writing an arbitrary string into it would be
 * rejected by the schema at best and corrupt every stage filter at worst. The
 * caller turns `recognised: false` into a visible warning.
 *
 * @param {unknown} value
 * @returns {{ stage: string, recognised: boolean }}
 */
export function parseStage(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return { stage: LEAD_STAGE.ACTIVE, recognised: false }

  const stage = SHEET_STATUS_TO_STAGE[text]
  if (stage) return { stage, recognised: true }

  // Tolerate decoration: "Closed - no reply".
  for (const [word, mapped] of Object.entries(SHEET_STATUS_TO_STAGE)) {
    if (text.startsWith(word)) return { stage: mapped, recognised: true }
  }

  return { stage: LEAD_STAGE.ACTIVE, recognised: false }
}

/**
 * Derives the destination market.
 *
 * The sheet name is authoritative where it says so; the reference prefix is the
 * fallback, since `XNZMP…`/`XNMP…` mark New Zealand and `XAMP…` Australia.
 */
export function deriveMarket({ sheetName = '', reference = '' }) {
  const sheet = String(sheetName).toUpperCase()
  if (/\bNZ\b|NEW ZEALAND/.test(sheet)) return MARKET.NZ
  if (/\bAU\b|AUSTRALIA/.test(sheet)) return MARKET.AU

  const ref = String(reference).toUpperCase()
  if (/^XN/.test(ref)) return MARKET.NZ
  if (/^XA/.test(ref)) return MARKET.AU

  return MARKET.OTHER
}

/** Splits a written name into first and last. */
export function splitPersonName(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return { firstName: null, lastName: null, displayName: null }

  // Drop an honorific so "Mr. Piyush Khandelwal" yields Piyush, not Mr.
  const withoutTitle = text.replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, '').trim() || text
  const parts = withoutTitle.split(' ')

  return {
    firstName: parts[0] ?? null,
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
    displayName: withoutTitle,
  }
}

/**
 * Validates one row against a column mapping.
 *
 * @param {{ row: string[], mapping: object[], rowNumber: number, sheetName: string }} params
 * @returns {{ valid: boolean, lead: ?object, issues: object[] }}
 */
export function validateLeadRow({ row, mapping, rowNumber, sheetName = '' }) {
  const issues = []
  const raw = {}

  for (const entry of mapping) {
    if (entry.field === LEAD_FIELD.IGNORE) continue
    raw[entry.field] = String(row?.[entry.index] ?? '').trim()
  }

  const note = (field, message, severity = 'warning') =>
    issues.push({ row: rowNumber, field, message, severity })

  // --- The three things a lead cannot exist without ------------------------
  const reference = (raw[LEAD_FIELD.REFERENCE] ?? '').trim().toUpperCase()
  if (!reference) {
    note(LEAD_FIELD.REFERENCE, 'No reference — a lead cannot be matched on re-import without one.', 'error')
  }

  const { primary, additional, invalid } = parseEmails(raw[LEAD_FIELD.EMAIL])
  if (!primary) {
    note(
      LEAD_FIELD.EMAIL,
      raw[LEAD_FIELD.EMAIL]
        ? `"${raw[LEAD_FIELD.EMAIL]}" is not a usable email address.`
        : 'No email address — this lead cannot be campaigned to.',
      'error',
    )
  } else if (invalid.length > 0) {
    note(LEAD_FIELD.EMAIL, `Ignored ${invalid.length} unreadable address(es) in the same cell.`)
  }

  const person = (raw[LEAD_FIELD.CONTACT_PERSON] ?? '').trim()
  if (!person) note(LEAD_FIELD.CONTACT_PERSON, 'No contact person.', 'error')

  const hasError = issues.some((issue) => issue.severity === 'error')
  if (hasError) return { valid: false, lead: null, issues }

  // --- Everything else degrades rather than failing ------------------------
  const quote = parseDateCell(raw[LEAD_FIELD.QUOTE_DATE])
  if (!quote.date && quote.text) {
    note(LEAD_FIELD.QUOTE_DATE, `Query Date "${quote.text}" could not be read as a date.`)
  }

  const travel = parseDateCell(raw[LEAD_FIELD.TRAVEL_DATE])
  const pax = parsePax(raw[LEAD_FIELD.PAX])
  const phones = parsePhones(raw[LEAD_FIELD.PHONE])

  if (raw[LEAD_FIELD.PHONE] && phones.length === 0) {
    note(LEAD_FIELD.PHONE, `No usable number found in "${raw[LEAD_FIELD.PHONE]}".`)
  }

  const { stage, recognised } = parseStage(raw[LEAD_FIELD.STAGE])
  if (raw[LEAD_FIELD.STAGE] && !recognised) {
    note(
      LEAD_FIELD.STAGE,
      // Built from the vocabulary rather than written out, so adding a stage
      // cannot leave this message naming a set the importer no longer uses.
      `Status "${raw[LEAD_FIELD.STAGE]}" is not one of ` +
        `${LEAD_STAGE_ORDER.map((stage) => LEAD_STAGE_LABELS[stage]).join(', ')}; filed as Active.`,
    )
  }

  const name = splitPersonName(person)

  /**
   * `Handled By` is discarded when it is not initials.
   *
   * In the workbook this column is 96% empty and what remains is polluted with
   * dates and stray values. Importing "42857" as a sales executive would make
   * the agent-performance report meaningless.
   */
  let handledBy = (raw[LEAD_FIELD.HANDLED_BY] ?? '').trim() || null
  if (handledBy && (/^\d+$/.test(handledBy) || /^\d{4}-\d{2}-\d{2}/.test(handledBy))) {
    note(LEAD_FIELD.HANDLED_BY, `Ignored "${handledBy}" — not a person's name or initials.`)
    handledBy = null
  }

  return {
    valid: true,
    issues,
    lead: {
      reference,
      market: deriveMarket({ sheetName, reference }),

      contactPerson: person.slice(0, 256),
      firstName: name.firstName,
      lastName: name.lastName,
      displayName: name.displayName,

      companyName: (raw[LEAD_FIELD.COMPANY_NAME] ?? '').trim().slice(0, 256) || null,

      email: primary,
      additionalEmails: additional,
      phones,

      quoteDate: quote.date,
      travelDate: travel.date,
      travelDateText: travel.text,

      city: (raw[LEAD_FIELD.CITY] ?? '').trim().slice(0, 128) || null,

      paxText: pax.text,
      adultCount: pax.adults,
      childCount: pax.children,

      stage,
      handledBy: handledBy ? handledBy.slice(0, 64) : null,
      internalNotes: (raw[LEAD_FIELD.NOTES] ?? '').trim().slice(0, 4000) || null,

      sourceSheet: sheetName || null,
      sourceRow: rowNumber,
    },
  }
}

export default {
  validateLeadRow,
  parseEmails,
  parsePhones,
  parseDateCell,
  parsePax,
  parseStage,
  deriveMarket,
  splitPersonName,
}
