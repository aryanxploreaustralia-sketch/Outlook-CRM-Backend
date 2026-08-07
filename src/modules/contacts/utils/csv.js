/**
 * RFC 4180 CSV reader and writer.
 *
 * Written rather than pulled in because the format is small and the failure
 * modes of a careless implementation are the ones that actually bite: a comma
 * inside a company name, a quoted field containing a newline, or a leading `=`
 * that a spreadsheet interprets as a formula.
 *
 * ## Formula injection
 *
 * A field beginning `=`, `+`, `-` or `@` is executed as a formula when the file
 * is opened in Excel or Sheets. A contact whose name is `=HYPERLINK(...)`
 * becomes an attack on whoever opens the export. Such values are prefixed with a
 * single quote, which spreadsheets strip on display but not on evaluation.
 */

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Escapes one value for CSV output.
 *
 * @param {*} value
 * @returns {string}
 */
export function escapeCsvValue(value) {
  if (value === null || value === undefined) return ''

  let text = String(value)

  if (text.length > 0 && FORMULA_PREFIXES.has(text[0])) {
    text = `'${text}`
  }

  // Quoting is required when the value contains a delimiter, a quote or a
  // newline. Quotes inside are doubled, per RFC 4180.
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }

  return text
}

/**
 * Serialises rows to CSV.
 *
 * @param {string[]} headers
 * @param {Array<object>} rows
 * @returns {string}
 */
export function toCsv(headers, rows) {
  const lines = [headers.map(escapeCsvValue).join(',')]

  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsvValue(row[header])).join(','))
  }

  // CRLF, which RFC 4180 specifies and Excel on Windows expects.
  return lines.join('\r\n')
}

/**
 * Parses CSV text into row objects keyed by the header row.
 *
 * A hand-written state machine rather than `split(',')`, which breaks on the
 * very first quoted field containing a comma — and quoted commas are guaranteed
 * in any real address book.
 *
 * @param {string} text
 * @returns {{ headers: string[], rows: object[] }}
 */
export function fromCsv(text) {
  const content = String(text ?? '').replace(/^﻿/, '') // strip a BOM if present

  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (content[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r') {
      // Consumed with the \n that follows; a lone \r also ends the record.
      if (content[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }

  // A file not ending in a newline still has a final record.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  if (rows.length === 0) return { headers: [], rows: [] }

  const headers = rows[0].map((header) => header.trim())

  const parsed = rows
    .slice(1)
    // Trailing blank lines are normal and must not become empty contacts.
    .filter((values) => values.some((value) => value.trim() !== ''))
    .map((values) => {
      const record = {}
      headers.forEach((header, position) => {
        record[header] = (values[position] ?? '').trim()
      })
      return record
    })

  return { headers, rows: parsed }
}

export default { toCsv, fromCsv, escapeCsvValue }
