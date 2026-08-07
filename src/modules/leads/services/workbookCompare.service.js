/**
 * Decides what each workbook row actually is.
 *
 * The sales team exports a fresh workbook every morning. Yesterday's had 5 rows;
 * today's has 12, and 5 of them are the same enquiries with the same details.
 * This module answers the only question that matters: **which of these have we
 * never seen before?**
 *
 * Get that wrong in one direction and a customer is emailed the same
 * introduction every single day. Get it wrong in the other and a genuinely new
 * enquiry is never contacted at all.
 *
 * ## Reference is the only key
 *
 * Not email, not name, not phone. One agent raises 183 enquiries from one
 * address, and two different people at the same firm share a company name.
 * `reference` is the value the team already writes on quotations and already
 * uses to discuss a deal, and it is unique per enquiry by construction.
 *
 * ## Comparison is on a fixed field list
 *
 * Comparing "every field on the document" would report every row as changed
 * every morning: `updatedAt` moves on every save, `sourceRow` moves when a row
 * is inserted above, and `stage` is maintained in the CRM rather than the
 * sheet. See `COMPARED_FIELDS` for the list and the reasoning.
 */

import { Lead } from '../../../models/lead.model.js'
import { validateLeadRow } from './leadValidation.service.js'
import {
  COMPARED_FIELDS,
  FIELD_LABELS,
  ROW_CATEGORY,
} from '../constants/syncConstants.js'

/**
 * Reduces a value to a string for comparison.
 *
 * Everything becomes a trimmed string so that `null`, `undefined` and `''` are
 * one thing rather than three — the workbook writes an empty cell for all of
 * them, and treating them as different would report a change every time a
 * salesperson cleared a field and retyped nothing.
 *
 * Dates compare by calendar day. The sheet carries no time of day, and
 * comparing full timestamps would call 00:00:00.000 and 00:00:00.001 a change.
 */
export function normaliseForCompare(value) {
  if (value === null || value === undefined) return ''

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  }

  if (Array.isArray(value)) {
    // Order-insensitive: a phone cell rewritten as "B; A" holds the same two
    // numbers as "A; B", and calling that a change would be noise.
    return value.map((entry) => String(entry ?? '').trim()).filter(Boolean).sort().join('|')
  }

  return String(value).trim()
}

/**
 * Compares an existing lead with what the workbook now says.
 *
 * @returns {{ field, label, from, to }[]} Empty when nothing the team typed changed.
 */
export function diffLead(existing, incoming) {
  const changes = []

  for (const field of COMPARED_FIELDS) {
    const before = normaliseForCompare(existing[field])
    const after = normaliseForCompare(incoming[field])

    /**
     * A cleared cell never erases a stored value.
     *
     * The team routinely exports a workbook with a column left blank, and
     * treating that as "delete the remark" would lose data the CRM holds and
     * the sheet simply did not carry that morning. Only a real new value counts.
     */
    if (after === '' && before !== '') continue

    if (before !== after) {
      changes.push({ field, label: FIELD_LABELS[field] ?? field, from: before || null, to: after || null })
    }
  }

  return changes
}

/**
 * Categorises every row of a worksheet against the database.
 *
 * Reads nothing but leads, writes nothing at all — this is the engine behind
 * the preview screen, and the preview must be able to promise what the import
 * will do without doing any of it.
 *
 * @param {{ rows, mapping, sheetName, headerRowNumber, owner }} params
 * @returns {Promise<{ categories, rows, duplicates, counts }>}
 */
export async function compareWorkbook({
  rows,
  mapping,
  sheetName,
  headerRowNumber = 1,
  owner,
}) {
  const counts = {
    total: 0,
    new: 0,
    updated: 0,
    unchanged: 0,
    invalid: 0,
  }

  const categorised = []
  const issues = []

  // --- 1. Validate and collect references ---------------------------------
  const validRows = []
  const seenReferences = new Map()

  for (const [index, row] of rows.entries()) {
    const rowNumber = headerRowNumber + index + 1

    // A row with nothing in any mapped column is absence, not a problem.
    const isBlank = mapping
      .filter((entry) => entry.field !== '__ignore__')
      .every((entry) => String(row?.[entry.index] ?? '').trim() === '')

    if (isBlank) continue

    counts.total += 1

    const result = validateLeadRow({ row, mapping, rowNumber, sheetName })

    if (!result.valid) {
      counts.invalid += 1
      categorised.push({
        rowNumber,
        category: ROW_CATEGORY.INVALID,
        reference: null,
        reasons: result.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message),
      })
      issues.push(...result.issues.filter((issue) => issue.severity === 'error'))
      continue
    }

    /**
     * The same reference twice in one workbook is a validation error.
     *
     * Not a warning: the two rows disagree about the same enquiry, and there is
     * no defensible way to choose. Both are reported and neither is imported,
     * so the team fixes the sheet rather than discovering weeks later that half
     * the details were silently discarded.
     */
    const previous = seenReferences.get(result.lead.reference)

    if (previous !== undefined) {
      counts.invalid += 1
      const message =
        `Reference ${result.lead.reference} appears on rows ${previous.rowNumber} and ${rowNumber}. ` +
        'Two rows cannot describe the same enquiry; neither was imported.'

      categorised.push({
        rowNumber,
        category: ROW_CATEGORY.INVALID,
        reference: result.lead.reference,
        reasons: [message],
      })
      issues.push({ row: rowNumber, field: 'reference', severity: 'error', message })

      // The first occurrence has to be demoted too — it is no longer safe.
      if (!previous.demoted) {
        previous.demoted = true
        previous.entry.category = ROW_CATEGORY.INVALID
        previous.entry.reasons = [message]
        counts.invalid += 1
        counts[previous.originalCategory] -= 1
      }
      continue
    }

    const entry = { rowNumber, category: null, reference: result.lead.reference, data: result.lead, changes: [] }
    seenReferences.set(result.lead.reference, { rowNumber, entry, demoted: false, originalCategory: null })
    validRows.push(entry)
    if (result.issues.length > 0) issues.push(...result.issues)
  }

  // --- 2. Look up every reference in one pass ------------------------------
  //
  // Batched rather than one query per row: a 10,000-row workbook would
  // otherwise issue 10,000 round trips before a single decision was made.
  const references = validRows.map((entry) => entry.reference)
  const existingByReference = new Map()

  for (let start = 0; start < references.length; start += 1000) {
    const slice = references.slice(start, start + 1000)
    const found = await Lead.find({ owner, reference: { $in: slice }, isDeleted: false })

    for (const lead of found) existingByReference.set(lead.reference, lead)
  }

  // --- 3. Categorise -------------------------------------------------------
  for (const entry of validRows) {
    /**
     * Demoted by a duplicate reference found further down the sheet.
     *
     * Pushed to the report rather than skipped: the counts already say two rows
     * are invalid, and omitting one of them from the list would show the user a
     * single offending row when the whole point is that a pair of rows disagree.
     */
    if (entry.category === ROW_CATEGORY.INVALID) {
      categorised.push(entry)
      continue
    }

    const existing = existingByReference.get(entry.reference)

    if (!existing) {
      entry.category = ROW_CATEGORY.NEW
      counts.new += 1
    } else {
      const changes = diffLead(existing, entry.data)
      entry.existingId = existing._id
      entry.changes = changes
      entry.autoMailStatus = existing.autoMail?.status ?? 'pending'

      if (changes.length > 0) {
        entry.category = ROW_CATEGORY.UPDATED
        counts.updated += 1
      } else {
        entry.category = ROW_CATEGORY.UNCHANGED
        counts.unchanged += 1
      }
    }

    const tracked = seenReferences.get(entry.reference)
    if (tracked) tracked.originalCategory = entry.category

    categorised.push(entry)
  }

  categorised.sort((a, b) => a.rowNumber - b.rowNumber)

  /**
   * How many of the new rows will actually be emailed.
   *
   * Computed here so the preview can promise a number rather than the user
   * discovering it afterwards. A new lead with no address is still a lead; it
   * just cannot be written to.
   */
  const mailable = categorised.filter(
    (entry) => entry.category === ROW_CATEGORY.NEW && Boolean(entry.data?.email),
  ).length

  return {
    counts,
    /** Every row with its verdict, in sheet order. */
    rows: categorised,
    /** Rows that will be created and emailed. */
    mailable,
    issues: issues.slice(0, 500),
    issuesTruncated: issues.length > 500,
  }
}

/**
 * A short, human summary of the comparison.
 *
 * Worded for the person about to click Import: it leads with what will actually
 * happen rather than with row counts.
 */
export function describeComparison(counts, mailable) {
  const parts = []

  if (counts.new > 0) parts.push(`${counts.new} new lead(s) — ${mailable} will be emailed`)
  else parts.push('no new leads')

  if (counts.updated > 0) parts.push(`${counts.updated} updated`)
  if (counts.unchanged > 0) parts.push(`${counts.unchanged} unchanged`)
  if (counts.invalid > 0) parts.push(`${counts.invalid} invalid`)

  return `${parts.join(', ')}.`
}

export default { compareWorkbook, diffLead, normaliseForCompare, describeComparison }
