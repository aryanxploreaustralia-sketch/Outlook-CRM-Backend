/**
 * XLSB (Excel Binary Workbook) reader — no dependencies.
 *
 * XLSB is the same ZIP package as XLSX with the XML parts replaced by a binary
 * record stream (BIFF12). The container is therefore already solved — this
 * module reuses the ZIP reader written for XLSX — and only the record decoding
 * is new.
 *
 * ## The record format
 *
 * Every record is `[variable-length id][variable-length size][payload]`.
 *
 * Both the id and the size use a continuation-bit encoding: if the high bit of a
 * byte is set, another byte follows. Ids are 1–2 bytes, sizes 1–4. Getting this
 * wrong desynchronises the whole stream, which is why the reader validates the
 * record boundary rather than trusting it — a corrupt size would otherwise send
 * it reading garbage until it crashed.
 *
 * ## Why read-only
 *
 * Import needs to read spreadsheets, never write them. Exports are produced as
 * XLSX, which every version of Excel opens. Implementing the BIFF12 writer would
 * be substantial work for a format nobody has asked to receive.
 */

import { readZip } from '../../contacts/utils/xlsx.js'

/** BIFF12 record ids this reader acts on. Everything else is skipped by length. */
const RECORD = Object.freeze({
  ROW_HDR: 0x00,
  CELL_BLANK: 0x01,
  CELL_RK: 0x02,
  CELL_ERROR: 0x03,
  CELL_BOOL: 0x04,
  CELL_REAL: 0x05,
  CELL_ST: 0x06,
  CELL_ISST: 0x07,
  CELL_FMLA_STRING: 0x08,
  CELL_FMLA_NUM: 0x09,
  CELL_FMLA_BOOL: 0x0a,
  CELL_FMLA_ERROR: 0x0b,
  SST_ITEM: 0x13,
  BEGIN_SHEET_DATA: 0x91,
  END_SHEET_DATA: 0x92,
})

/**
 * Reads a variable-length integer with continuation bits.
 *
 * @returns {{ value: number, bytesRead: number }}
 */
function readVariableInt(buffer, offset, maxBytes) {
  let value = 0
  let shift = 0
  let read = 0

  while (read < maxBytes) {
    if (offset + read >= buffer.length) break

    const byte = buffer[offset + read]
    value |= (byte & 0x7f) << shift
    read += 1

    // High bit clear means this was the last byte.
    if ((byte & 0x80) === 0) break

    shift += 7
  }

  return { value, bytesRead: read }
}

/**
 * Decodes an RK value.
 *
 * RK packs a number into 32 bits using two flags: bit 0 means the value was
 * multiplied by 100 (so it must be divided back), bit 1 means it is a 30-bit
 * integer rather than the top 30 bits of an IEEE-754 double. Ignoring either
 * flag yields numbers that are wrong by a factor of 100 or nonsensical
 * entirely — and in an import, a silently wrong number is worse than a failure.
 */
function decodeRk(raw) {
  const isMultiplied = (raw & 0x01) !== 0
  const isInteger = (raw & 0x02) !== 0

  let value

  if (isInteger) {
    // Sign-extend the 30-bit integer held in the upper bits.
    value = raw >> 2
  } else {
    // The 30 bits are the *high* bits of a double; the low 34 are zero.
    const buffer = Buffer.alloc(8)
    buffer.writeInt32LE(0, 0)
    buffer.writeInt32LE(raw & 0xff_ff_ff_fc, 4)
    value = buffer.readDoubleLE(0)
  }

  return isMultiplied ? value / 100 : value
}

/**
 * Reads a BIFF12 string: a 4-byte character count followed by UTF-16LE.
 *
 * @returns {{ value: string, bytesRead: number }}
 */
function readString(buffer, offset) {
  if (offset + 4 > buffer.length) return { value: '', bytesRead: 0 }

  const length = buffer.readUInt32LE(offset)

  // 0xFFFFFFFF is the documented "no string" marker; a huge length otherwise
  // means the stream has desynchronised and must not be trusted.
  if (length === 0xff_ff_ff_ff || length > 32_767) return { value: '', bytesRead: 4 }

  const byteLength = length * 2
  const end = offset + 4 + byteLength

  if (end > buffer.length) return { value: '', bytesRead: 4 }

  return {
    value: buffer.toString('utf16le', offset + 4, end),
    bytesRead: 4 + byteLength,
  }
}

/**
 * Walks a BIFF12 stream, invoking a handler per record.
 *
 * @param {Buffer} buffer
 * @param {(id: number, payload: Buffer) => void} onRecord
 */
function walkRecords(buffer, onRecord) {
  let offset = 0

  while (offset < buffer.length) {
    const id = readVariableInt(buffer, offset, 2)
    offset += id.bytesRead

    const size = readVariableInt(buffer, offset, 4)
    offset += size.bytesRead

    // A size running past the end means the stream is corrupt or the encoding
    // was misread. Stopping is the only safe response — continuing would read
    // arbitrary memory as cell data.
    if (size.value < 0 || offset + size.value > buffer.length) break

    onRecord(id.value, buffer.subarray(offset, offset + size.value))

    offset += size.value
  }
}

/** Reads the shared string table, which cells reference by index. */
function readSharedStrings(buffer) {
  const strings = []

  if (!buffer) return strings

  walkRecords(buffer, (id, payload) => {
    if (id !== RECORD.SST_ITEM) return

    // The first byte holds flags (rich text, phonetic); the string follows.
    strings.push(readString(payload, 1).value)
  })

  return strings
}

/**
 * Reads the first worksheet into a grid of strings.
 *
 * @param {Buffer} sheetBuffer
 * @param {string[]} sharedStrings
 * @returns {string[][]}
 */
function readSheet(sheetBuffer, sharedStrings) {
  const grid = []

  let rowIndex = -1
  let inSheetData = false

  walkRecords(sheetBuffer, (id, payload) => {
    if (id === RECORD.BEGIN_SHEET_DATA) {
      inSheetData = true
      return
    }

    if (id === RECORD.END_SHEET_DATA) {
      inSheetData = false
      return
    }

    if (!inSheetData) return

    if (id === RECORD.ROW_HDR) {
      rowIndex = payload.readUInt32LE(0)
      grid[rowIndex] ??= []
      return
    }

    if (rowIndex < 0 || payload.length < 8) return

    // Every cell record begins with a 4-byte column index and 4 bytes of style.
    const columnIndex = payload.readUInt32LE(0)
    const body = payload.subarray(8)

    let value = null

    switch (id) {
      case RECORD.CELL_ISST: {
        const index = body.readUInt32LE(0)
        value = sharedStrings[index] ?? ''
        break
      }

      case RECORD.CELL_ST:
      case RECORD.CELL_FMLA_STRING:
        value = readString(body, 0).value
        break

      case RECORD.CELL_RK:
        value = decodeRk(body.readInt32LE(0))
        break

      case RECORD.CELL_REAL:
      case RECORD.CELL_FMLA_NUM:
        value = body.readDoubleLE(0)
        break

      case RECORD.CELL_BOOL:
      case RECORD.CELL_FMLA_BOOL:
        value = body[0] === 1 ? 'TRUE' : 'FALSE'
        break

      case RECORD.CELL_BLANK:
        value = ''
        break

      case RECORD.CELL_ERROR:
      case RECORD.CELL_FMLA_ERROR:
        // Excel error cells (#N/A, #REF!) carry no importable value.
        value = ''
        break

      default:
        return
    }

    grid[rowIndex] ??= []
    grid[rowIndex][columnIndex] = value === null ? '' : String(value)
  })

  return grid
}

/**
 * Reads an XLSB workbook.
 *
 * @param {Buffer} buffer
 * @returns {{ headers: string[], rows: object[], grid: string[][] }}
 */
export function fromXlsb(buffer) {
  const files = readZip(buffer)

  const sheetEntry =
    files.get('xl/worksheets/sheet1.bin') ??
    [...files.entries()].find(([name]) => name.startsWith('xl/worksheets/'))?.[1]

  if (!sheetEntry) throw new Error('The workbook contains no worksheet.')

  const sharedStrings = readSharedStrings(files.get('xl/sharedStrings.bin'))
  const grid = readSheet(sheetEntry, sharedStrings)

  return gridToRows(grid)
}

/**
 * Turns a sparse grid into header-keyed row objects.
 *
 * Shared with the other parsers so every format produces the same shape,
 * including the treatment of blank leading rows — spreadsheets exported from
 * real systems frequently carry a title row or a blank one above the headers.
 *
 * @param {Array<Array<string>>} grid
 * @returns {{ headers: string[], rows: object[], grid: string[][] }}
 */
export function gridToRows(grid) {
  // Sparse arrays leave holes; they are filled so indexing is safe.
  const dense = [...grid].map((row) => [...(row ?? [])].map((cell) => cell ?? ''))

  const firstPopulated = dense.findIndex((row) =>
    row.some((cell) => String(cell ?? '').trim() !== ''),
  )

  if (firstPopulated === -1) return { headers: [], rows: [], grid: [] }

  const body = dense.slice(firstPopulated)
  const headers = (body[0] ?? []).map((header) => String(header ?? '').trim())

  const rows = body
    .slice(1)
    .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    .map((row) => {
      const record = {}
      headers.forEach((header, index) => {
        if (header) record[header] = String(row[index] ?? '').trim()
      })
      return record
    })

  return { headers, rows, grid: body }
}

export default { fromXlsb, gridToRows }
