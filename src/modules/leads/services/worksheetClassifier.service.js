/**
 * Decides what each worksheet in an uploaded workbook actually is.
 *
 * A real sales workbook is not one table. The file this module was written for
 * holds six tabs: two lead registers, two hotel-booking ledgers, a scratchpad
 * with no header row, and a tab whose headers are shifted one column out of
 * alignment with its data.
 *
 * Importing all of them blindly would create "leads" for hotel room blocks.
 * Importing only the first would silently lose five sixths of the workbook. So
 * every sheet is classified, with a stated reason, and the user chooses.
 *
 * ## Classification is by content, not just by header
 *
 * Headers lie. The workbook's "Sheet2" is labelled `… Contact Person, Email ID,
 * Contact No …` but its data sits one column to the left, so the column called
 * "Email ID" holds people's names and the one called "Contact No" holds their
 * email addresses. Header matching alone would import that as fact.
 */

import {
  LEAD_FIELD,
  LEAD_HEADER_SYNONYMS,
  OPERATIONS_HEADER_MARKERS,
  SHEET_KIND,
} from '../constants/leadConstants.js'

/** Rows sampled when judging what a column really holds. */
const SAMPLE_SIZE = 40

/** Deliberately permissive — this rejects "Benny Panikulangara", not odd TLDs. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Reduces a header to a comparison key. */
export function normaliseHeader(header) {
  return String(header ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** Fraction of sampled values in a column that look like email addresses. */
function emailDensity(values) {
  if (values.length === 0) return 0
  const hits = values.filter((value) => EMAIL_PATTERN.test(String(value).split(/[;,/]/)[0].trim()))
  return hits.length / values.length
}

/** Fraction that look like phone numbers rather than addresses. */
function phoneDensity(values) {
  if (values.length === 0) return 0
  const hits = values.filter((value) => {
    const text = String(value)
    if (text.includes('@')) return false
    return (text.match(/\d/g) ?? []).length >= 7
  })
  return hits.length / values.length
}

/** Fraction that parse as a date, in ISO or a common written form. */
function dateDensity(values) {
  if (values.length === 0) return 0
  const hits = values.filter((value) => {
    const text = String(value).trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return true
    if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)) return true
    return false
  })
  return hits.length / values.length
}

/** Column values from a grid, skipping blanks. */
function columnValues(rows, index, limit = SAMPLE_SIZE) {
  const out = []
  for (const row of rows) {
    const value = row?.[index]
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      out.push(String(value).trim())
      if (out.length >= limit) break
    }
  }
  return out
}

/**
 * Maps headers onto lead fields, then checks the data agrees.
 *
 * Returns both the mapping and any correction it had to make, so the UI can
 * show *why* a column was reassigned rather than silently doing it.
 *
 * @param {string[]} headers
 * @param {string[][]} rows Grid rows, positional.
 * @returns {{ mapping: object[], corrections: object[], confidence: number }}
 */
export function mapLeadColumns(headers, rows = []) {
  /**
   * Densified first, because a header row can legitimately have gaps.
   *
   * `fromXlsx` assigns cells by column index, so a sheet whose header row
   * starts at column C — or skips a column mid-row — yields a *sparse* array
   * with holes rather than empty strings. `Array.prototype.map` preserves those
   * holes, and `find` below then visits them as `undefined`, which threw
   * `Cannot read properties of undefined (reading 'field')` and failed the
   * whole inspection with a 500.
   *
   * Spreading fills each hole with `undefined`, which `normaliseHeader` already
   * reduces to `''` — the same treatment a blank header has always had. Nothing
   * changes for a dense row.
   */
  const mapping = [...headers].map((header, index) => {
    const key = normaliseHeader(header)
    const field = LEAD_HEADER_SYNONYMS[key] ?? LEAD_FIELD.IGNORE

    return {
      column: String(header ?? '').trim(),
      index,
      field,
      confidence: field === LEAD_FIELD.IGNORE ? 0 : 1,
      reason:
        field === LEAD_FIELD.IGNORE
          ? `No rule matched "${header}".`
          : `Header "${header}" is a known column name.`,
      source: 'header',
    }
  })

  const corrections = []

  // --- Verify the email column actually holds email addresses --------------
  const declaredEmail = mapping.find((entry) => entry.field === LEAD_FIELD.EMAIL)
  const declaredEmailDensity = declaredEmail
    ? emailDensity(columnValues(rows, declaredEmail.index))
    : 0

  if (!declaredEmail || declaredEmailDensity < 0.5) {
    // Find whichever column really does hold addresses.
    let best = null
    for (const entry of mapping) {
      const density = emailDensity(columnValues(rows, entry.index))
      if (density > 0.8 && (!best || density > best.density)) best = { entry, density }
    }

    if (best && best.entry !== declaredEmail) {
      if (declaredEmail) {
        corrections.push({
          column: declaredEmail.column,
          from: LEAD_FIELD.EMAIL,
          to: LEAD_FIELD.IGNORE,
          reason:
            `Column "${declaredEmail.column}" is labelled as the email address but ` +
            `only ${Math.round(declaredEmailDensity * 100)}% of its values are addresses. ` +
            `"${best.entry.column}" holds ${Math.round(best.density * 100)}% instead.`,
        })
        declaredEmail.field = LEAD_FIELD.IGNORE
        declaredEmail.confidence = 0
        declaredEmail.source = 'content'
      }

      corrections.push({
        column: best.entry.column,
        from: best.entry.field,
        to: LEAD_FIELD.EMAIL,
        reason: `${Math.round(best.density * 100)}% of the values in "${best.entry.column}" are email addresses.`,
      })

      best.entry.field = LEAD_FIELD.EMAIL
      best.entry.confidence = best.density
      best.entry.source = 'content'
      best.entry.reason = 'Identified from the data, not the header.'
    }
  }

  // --- Verify the phone column is not actually the email column ------------
  const declaredPhone = mapping.find((entry) => entry.field === LEAD_FIELD.PHONE)

  if (declaredPhone) {
    const values = columnValues(rows, declaredPhone.index)
    if (emailDensity(values) > 0.6 && phoneDensity(values) < 0.3) {
      corrections.push({
        column: declaredPhone.column,
        from: LEAD_FIELD.PHONE,
        to: LEAD_FIELD.IGNORE,
        reason: `"${declaredPhone.column}" is labelled a phone number but holds email addresses.`,
      })
      declaredPhone.field = LEAD_FIELD.IGNORE
      declaredPhone.confidence = 0
      declaredPhone.source = 'content'
    }
  }

  // --- Verify date columns hold dates --------------------------------------
  for (const field of [LEAD_FIELD.QUOTE_DATE, LEAD_FIELD.TRAVEL_DATE]) {
    const entry = mapping.find((candidate) => candidate.field === field)
    if (!entry) continue

    const values = columnValues(rows, entry.index)
    const density = dateDensity(values)

    // A low density is not automatically wrong — the workbook's travel dates
    // legitimately include "August" and "Low Season" — so this records doubt
    // rather than reassigning. Reassigning prose to another field would lose it.
    if (values.length > 0 && density < 0.5) {
      entry.confidence = Math.max(0.3, density)
      entry.reason = `Only ${Math.round(density * 100)}% of "${entry.column}" parses as a date; the rest is kept as written.`
    }
  }

  const mapped = mapping.filter((entry) => entry.field !== LEAD_FIELD.IGNORE)
  const confidence = mapped.length === 0
    ? 0
    : mapped.reduce((sum, entry) => sum + entry.confidence, 0) / mapped.length

  return { mapping, corrections, confidence }
}

/**
 * Classifies one worksheet.
 *
 * @param {{ name: string, headers: string[], rows: string[][] }} sheet
 * @returns {{ name, kind, reason, rowCount, mapping, corrections, confidence, missingRequired }}
 */
export function classifySheet({ name, headers = [], rows = [] }) {
  const dataRows = rows.filter((row) => row && row.some((v) => String(v ?? '').trim() !== ''))

  if (dataRows.length === 0) {
    return {
      name,
      kind: SHEET_KIND.EMPTY,
      reason: 'The sheet has no data rows.',
      rowCount: 0,
      mapping: [],
      corrections: [],
      confidence: 0,
      missingRequired: [],
    }
  }

  const normalised = headers.map(normaliseHeader)

  // Operations sheets are recognised by their own vocabulary rather than by
  // what they lack — a positive test gives a reason worth showing the user.
  const operationsHits = OPERATIONS_HEADER_MARKERS.filter((marker) => normalised.includes(marker))

  const { mapping, corrections, confidence } = mapLeadColumns(headers, rows)
  const present = new Set(mapping.filter((e) => e.field !== LEAD_FIELD.IGNORE).map((e) => e.field))

  const hasEmail = present.has(LEAD_FIELD.EMAIL)
  const hasPerson = present.has(LEAD_FIELD.CONTACT_PERSON)
  const hasReference = present.has(LEAD_FIELD.REFERENCE)

  if (operationsHits.length >= 3 && !(hasEmail && hasPerson)) {
    return {
      name,
      kind: SHEET_KIND.OPERATIONS,
      reason:
        `Hotel operations data — the sheet has ${operationsHits.length} booking columns ` +
        `(${operationsHits.slice(0, 4).join(', ')}) and no usable contact. Importing it would ` +
        'create leads for room blocks rather than people.',
      rowCount: dataRows.length,
      mapping,
      corrections,
      confidence: 0,
      missingRequired: [],
    }
  }

  const missingRequired = []
  if (!hasEmail) missingRequired.push(LEAD_FIELD.EMAIL)
  if (!hasPerson) missingRequired.push(LEAD_FIELD.CONTACT_PERSON)
  if (!hasReference) missingRequired.push(LEAD_FIELD.REFERENCE)

  if (hasEmail && hasPerson) {
    return {
      name,
      kind: SHEET_KIND.LEADS,
      reason: hasReference
        ? 'Lead register — has a contact, an email address and a reference.'
        : 'Lead register — has a contact and an email address, but no reference column, ' +
          'so re-importing cannot match rows to existing leads.',
      rowCount: dataRows.length,
      mapping,
      corrections,
      confidence,
      missingRequired,
    }
  }

  return {
    name,
    kind: SHEET_KIND.UNKNOWN,
    reason:
      `Could not identify this sheet: no column holds ${!hasEmail ? 'email addresses' : 'contact names'}. ` +
      (headers.every((h) => !h)
        ? 'It appears to have no header row.'
        : `Headers seen: ${headers.filter(Boolean).slice(0, 6).join(', ')}.`),
    rowCount: dataRows.length,
    mapping,
    corrections,
    confidence,
    missingRequired,
  }
}

/**
 * Classifies every sheet in a parsed workbook.
 *
 * @param {{ name: string, headers: string[], rows: string[][] }[]} sheets
 */
export function classifyWorkbook(sheets) {
  const classified = sheets.map(classifySheet)

  return {
    sheets: classified,
    /** The sheet to preselect: the lead register with the most rows. */
    recommended:
      classified
        .filter((sheet) => sheet.kind === SHEET_KIND.LEADS)
        .sort((a, b) => b.rowCount - a.rowCount)[0]?.name ?? null,
    leadSheets: classified.filter((s) => s.kind === SHEET_KIND.LEADS).length,
  }
}

export default { classifyWorkbook, classifySheet, mapLeadColumns, normaliseHeader }
