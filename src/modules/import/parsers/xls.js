/**
 * XLS (Excel 97–2003) reader — no dependencies.
 *
 * A `.xls` file is an **OLE2 Compound File**: a FAT-like filesystem inside a
 * single file, holding named streams. The spreadsheet lives in a stream called
 * `Workbook` (or `Book` in very old files), encoded as BIFF8 records.
 *
 * So there are two layers to decode, and both are implemented here:
 *
 *   1. **The container** — header, sector allocation table, directory, and the
 *      separate "mini stream" that small entries live in.
 *   2. **The records** — BOF/EOF, the shared string table, and the half-dozen
 *      cell record types Excel actually emits.
 *
 * ## Why this is written out rather than imported
 *
 * The maintained JavaScript reader for this format is distributed outside npm;
 * the npm package of the same name is stale and carries known advisories. Since
 * `exceljs` was already rejected in Phase 6 for introducing nine high-severity
 * CVEs, pulling in another spreadsheet dependency would undo that decision for
 * a legacy format. This is roughly 300 lines and reads the subset that matters:
 * strings, numbers, dates and formula results.
 *
 * ## Deliberate limitations
 *
 * Read-only, first worksheet, no formulas (cached results are used instead), no
 * styles, and **encrypted workbooks are rejected with a clear message** rather
 * than producing silent garbage. Files newer than Excel 2003 should be `.xlsx`,
 * which the primary parser handles.
 */

/** OLE2 compound-file signature: D0 CF 11 E0 A1 B1 1A E1. */
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** Sector chain terminators. */
const END_OF_CHAIN = 0xff_ff_ff_fe
const FREE_SECTOR = 0xff_ff_ff_ff

/** BIFF8 record ids this reader acts on. */
const BIFF = Object.freeze({
  BOF: 0x00_9,
  EOF: 0x00_a,
  SST: 0x0f_c,
  CONTINUE: 0x03_c,
  LABELSST: 0x0f_d,
  LABEL: 0x20_4,
  RK: 0x27_e,
  MULRK: 0x0b_d,
  NUMBER: 0x20_3,
  BOOLERR: 0x20_5,
  FORMULA: 0x00_6,
  STRING: 0x20_7,
  BLANK: 0x20_1,
  MULBLANK: 0x0b_e,
  ROW: 0x20_8,
  FILEPASS: 0x02_f,
  DATE1904: 0x02_2,
})

// ---------------------------------------------------------------------------
// Layer 1 — OLE2 compound file
// ---------------------------------------------------------------------------

/**
 * Reads the compound-file container and returns its named streams.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
function readCompoundFile(buffer) {
  if (buffer.length < 512 || !buffer.subarray(0, 8).equals(OLE_SIGNATURE)) {
    throw new Error('Not a valid Excel 97–2003 file (missing OLE2 signature).')
  }

  const sectorShift = buffer.readUInt16LE(30)
  const miniSectorShift = buffer.readUInt16LE(32)
  const sectorSize = 1 << sectorShift
  const miniSectorSize = 1 << miniSectorShift

  const fatSectorCount = buffer.readUInt32LE(44)
  const directoryStart = buffer.readUInt32LE(48)
  const miniCutoff = buffer.readUInt32LE(56)
  const miniFatStart = buffer.readUInt32LE(60)
  const difatStart = buffer.readUInt32LE(68)
  const difatCount = buffer.readUInt32LE(72)

  /** Byte offset of a sector. Sector 0 begins immediately after the 512-byte header. */
  const sectorOffset = (sector) => (sector + 1) * sectorSize

  const readSector = (sector) => {
    const start = sectorOffset(sector)
    return buffer.subarray(start, Math.min(start + sectorSize, buffer.length))
  }

  // --- Assemble the FAT ----------------------------------------------------
  // The first 109 FAT sector numbers live in the header; the rest are chained
  // through DIFAT sectors. Files under ~7 MB use only the header entries.
  const fatSectors = []

  for (let index = 0; index < Math.min(fatSectorCount, 109); index += 1) {
    const sector = buffer.readUInt32LE(76 + index * 4)
    if (sector !== FREE_SECTOR) fatSectors.push(sector)
  }

  let difatSector = difatStart
  let guard = 0

  while (difatSector !== END_OF_CHAIN && difatSector !== FREE_SECTOR && guard < difatCount + 10) {
    const sectorData = readSector(difatSector)
    const entries = sectorSize / 4 - 1

    for (let index = 0; index < entries; index += 1) {
      const value = sectorData.readUInt32LE(index * 4)
      if (value !== FREE_SECTOR && value !== END_OF_CHAIN) fatSectors.push(value)
    }

    difatSector = sectorData.readUInt32LE(sectorSize - 4)
    guard += 1
  }

  const fat = []
  for (const sector of fatSectors) {
    const sectorData = readSector(sector)
    for (let index = 0; index + 4 <= sectorData.length; index += 4) {
      fat.push(sectorData.readUInt32LE(index))
    }
  }

  /** Follows a sector chain, guarding against the cycles a corrupt FAT can contain. */
  const followChain = (start, table) => {
    const chain = []
    const seen = new Set()
    let sector = start

    while (sector !== END_OF_CHAIN && sector !== FREE_SECTOR && sector < table.length) {
      if (seen.has(sector)) break
      seen.add(sector)
      chain.push(sector)
      sector = table[sector]
    }

    return chain
  }

  const readChain = (start, table, reader) =>
    Buffer.concat(followChain(start, table).map((sector) => reader(sector)))

  // --- Directory -----------------------------------------------------------
  const directory = readChain(directoryStart, fat, readSector)

  const entries = []
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameLength = directory.readUInt16LE(offset + 64)
    if (nameLength === 0) continue

    // The name is UTF-16LE and includes a trailing null in the length.
    const name = directory.toString('utf16le', offset, offset + Math.max(0, nameLength - 2))

    entries.push({
      name,
      type: directory[offset + 66],
      startSector: directory.readUInt32LE(offset + 116),
      size: directory.readUInt32LE(offset + 120),
    })
  }

  // --- Mini stream ---------------------------------------------------------
  // Entries smaller than `miniCutoff` are packed into the root entry's stream
  // and indexed by a separate mini-FAT. Ignoring this loses every small stream.
  const root = entries.find((entry) => entry.type === 5)

  let miniStream = Buffer.alloc(0)
  const miniFat = []

  if (root && root.size > 0) {
    miniStream = readChain(root.startSector, fat, readSector)

    const miniFatData = readChain(miniFatStart, fat, readSector)
    for (let index = 0; index + 4 <= miniFatData.length; index += 4) {
      miniFat.push(miniFatData.readUInt32LE(index))
    }
  }

  const readMiniSector = (sector) => {
    const start = sector * miniSectorSize
    return miniStream.subarray(start, Math.min(start + miniSectorSize, miniStream.length))
  }

  // --- Extract streams -----------------------------------------------------
  const streams = new Map()

  for (const entry of entries) {
    if (entry.type !== 2 || entry.size === 0) continue

    const data =
      entry.size < miniCutoff
        ? readChain(entry.startSector, miniFat, readMiniSector)
        : readChain(entry.startSector, fat, readSector)

    streams.set(entry.name, data.subarray(0, entry.size))
  }

  return streams
}

// ---------------------------------------------------------------------------
// Layer 2 — BIFF8 records
// ---------------------------------------------------------------------------

/**
 * Reads a BIFF8 Unicode string.
 *
 * The encoding is awkward: a character count, then a flags byte saying whether
 * the characters are 8-bit compressed Latin-1 or 16-bit UTF-16, then optional
 * rich-text and far-East extension blocks that must be skipped by length.
 * Assuming UTF-16 throughout — the common shortcut — mangles every compressed
 * string, which is most of them.
 *
 * @returns {{ value: string, bytesRead: number }}
 */
function readUnicodeString(buffer, offset, lengthBytes = 2) {
  if (offset + lengthBytes + 1 > buffer.length) return { value: '', bytesRead: 0 }

  const charCount = lengthBytes === 2 ? buffer.readUInt16LE(offset) : buffer[offset]
  let cursor = offset + lengthBytes

  const flags = buffer[cursor]
  cursor += 1

  const isWide = (flags & 0x01) !== 0
  const hasFarEast = (flags & 0x04) !== 0
  const hasRichText = (flags & 0x08) !== 0

  let richRuns = 0
  let farEastSize = 0

  if (hasRichText) {
    richRuns = buffer.readUInt16LE(cursor)
    cursor += 2
  }

  if (hasFarEast) {
    farEastSize = buffer.readUInt32LE(cursor)
    cursor += 4
  }

  const byteLength = isWide ? charCount * 2 : charCount
  const end = Math.min(cursor + byteLength, buffer.length)

  const value = isWide
    ? buffer.toString('utf16le', cursor, end)
    : buffer.toString('latin1', cursor, end)

  cursor = end + richRuns * 4 + farEastSize

  return { value, bytesRead: cursor - offset }
}

/**
 * Reassembles the shared string table.
 *
 * The SST routinely exceeds one record's 8,224-byte ceiling and spills into
 * CONTINUE records, and a string may be split *across* that boundary — with a
 * fresh flags byte at the start of the continuation. Concatenating the payloads
 * first sidesteps the split-string problem entirely, which is far more reliable
 * than trying to resume mid-string.
 */
function readSharedStrings(records) {
  const sstIndex = records.findIndex((record) => record.id === BIFF.SST)
  if (sstIndex === -1) return []

  const parts = [records[sstIndex].data]

  for (let index = sstIndex + 1; index < records.length; index += 1) {
    if (records[index].id !== BIFF.CONTINUE) break
    parts.push(records[index].data)
  }

  const buffer = Buffer.concat(parts)
  const uniqueCount = buffer.readUInt32LE(4)

  const strings = []
  let offset = 8

  for (let index = 0; index < uniqueCount && offset < buffer.length; index += 1) {
    const { value, bytesRead } = readUnicodeString(buffer, offset)
    if (bytesRead === 0) break

    strings.push(value)
    offset += bytesRead
  }

  return strings
}

/** Decodes an RK value. See `xlsb.js` for the flag semantics. */
function decodeRk(raw) {
  const isMultiplied = (raw & 0x01) !== 0
  const isInteger = (raw & 0x02) !== 0

  let value

  if (isInteger) {
    value = raw >> 2
  } else {
    const buffer = Buffer.alloc(8)
    buffer.writeInt32LE(0, 0)
    buffer.writeInt32LE(raw & 0xff_ff_ff_fc, 4)
    value = buffer.readDoubleLE(0)
  }

  return isMultiplied ? value / 100 : value
}

/** Splits a BIFF stream into records. */
function splitRecords(stream) {
  const records = []
  let offset = 0

  while (offset + 4 <= stream.length) {
    const id = stream.readUInt16LE(offset)
    const size = stream.readUInt16LE(offset + 2)

    if (offset + 4 + size > stream.length) break

    records.push({ id, data: stream.subarray(offset + 4, offset + 4 + size) })
    offset += 4 + size
  }

  return records
}

/**
 * Reads an XLS workbook.
 *
 * @param {Buffer} buffer
 * @returns {{ headers: string[], rows: object[], grid: string[][] }}
 */
export function fromXls(buffer) {
  const streams = readCompoundFile(buffer)

  const workbook = streams.get('Workbook') ?? streams.get('Book')

  if (!workbook) {
    throw new Error('No workbook stream found. The file may be corrupt or not a spreadsheet.')
  }

  const records = splitRecords(workbook)

  // FILEPASS means the workbook is encrypted. Every subsequent record would
  // decode to noise, so this is reported plainly rather than producing a
  // spreadsheet full of nonsense.
  if (records.some((record) => record.id === BIFF.FILEPASS)) {
    throw new Error(
      'This workbook is password-protected. Remove the password in Excel and upload it again.',
    )
  }

  const sharedStrings = readSharedStrings(records)

  const grid = []
  const setCell = (row, column, value) => {
    grid[row] ??= []
    grid[row][column] = value === null || value === undefined ? '' : String(value)
  }

  /**
   * Cells appear in the stream for every worksheet, one after another. Only the
   * first sheet is imported, so reading stops at the substream boundary — the
   * second BOF after cell data has begun.
   */
  let sheetsSeen = 0
  let sawCells = false

  for (let index = 0; index < records.length; index += 1) {
    const { id, data } = records[index]

    if (id === BIFF.BOF) {
      sheetsSeen += 1
      if (sawCells && sheetsSeen > 1) break
      continue
    }

    if (data.length < 4) continue

    const row = data.readUInt16LE(0)
    const column = data.readUInt16LE(2)

    switch (id) {
      case BIFF.LABELSST: {
        const stringIndex = data.readUInt32LE(6)
        setCell(row, column, sharedStrings[stringIndex] ?? '')
        sawCells = true
        break
      }

      case BIFF.LABEL: {
        // An inline string, used by writers that do not build an SST.
        setCell(row, column, readUnicodeString(data, 6).value)
        sawCells = true
        break
      }

      case BIFF.RK: {
        setCell(row, column, decodeRk(data.readInt32LE(6)))
        sawCells = true
        break
      }

      case BIFF.MULRK: {
        // One record carrying a run of RK cells across consecutive columns.
        const lastColumn = data.readUInt16LE(data.length - 2)
        let cursor = 4

        for (let current = column; current <= lastColumn && cursor + 6 <= data.length; current += 1) {
          setCell(row, current, decodeRk(data.readInt32LE(cursor + 2)))
          cursor += 6
        }

        sawCells = true
        break
      }

      case BIFF.NUMBER: {
        setCell(row, column, data.readDoubleLE(6))
        sawCells = true
        break
      }

      case BIFF.BOOLERR: {
        // Byte 7 distinguishes a boolean from an error; errors carry no value.
        setCell(row, column, data[7] === 0 ? (data[6] === 1 ? 'TRUE' : 'FALSE') : '')
        sawCells = true
        break
      }

      case BIFF.FORMULA: {
        /**
         * A formula's cached result is what matters — the CRM imports values,
         * not expressions. A string result is carried in the STRING record that
         * immediately follows; anything else is a double in place.
         */
        const isStringResult =
          data.length >= 14 && data.readUInt16LE(12) === 0xff_ff && data[6] === 0x00

        if (isStringResult) {
          const next = records[index + 1]
          setCell(row, column, next?.id === BIFF.STRING ? readUnicodeString(next.data, 0).value : '')
        } else {
          const value = data.readDoubleLE(6)
          setCell(row, column, Number.isNaN(value) ? '' : value)
        }

        sawCells = true
        break
      }

      case BIFF.BLANK: {
        setCell(row, column, '')
        break
      }

      case BIFF.MULBLANK: {
        const lastColumn = data.readUInt16LE(data.length - 2)
        for (let current = column; current <= lastColumn; current += 1) setCell(row, current, '')
        break
      }

      default:
        break
    }
  }

  // Shared with the other parsers so every format yields the same shape.
  return gridToRowsLocal(grid)
}

/**
 * Turns a sparse grid into header-keyed rows.
 *
 * Duplicated deliberately rather than imported from `xlsb.js`: that would make
 * the legacy parser depend on the modern one, and these two files are the ones
 * most likely to be extracted into a standalone package later.
 */
function gridToRowsLocal(grid) {
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

export default { fromXls }
