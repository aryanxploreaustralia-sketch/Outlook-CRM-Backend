/**
 * The import engine: analysis, chunked execution, resume and rollback.
 *
 * ## Analysis is separate from import
 *
 * Every row is classified and every duplicate found *before* anything is
 * written, because the wizard shows the user those numbers and asks them to
 * approve. An engine that discovered problems mid-write could not offer that
 * choice, and a bulk import is precisely where being asked first matters.
 *
 * ## Chunking
 *
 * Rows are processed in batches of `CHUNK_SIZE` with the cursor persisted after
 * each. That gives three properties at once: bounded memory on a 50,000-row
 * file, a progress figure that is real rather than estimated, and a resume point
 * if the process dies. The alternative — one enormous transaction — fails all
 * three.
 *
 * ## Rollback removes exactly what was created
 *
 * `createdContactIds` is recorded as the import runs, so a rollback deletes
 * those records and nothing else. Deleting "everything imported today" would
 * take contacts a user had since edited, and contacts another import created.
 */

import crypto from 'node:crypto'

import { Contact } from '../../../models/contact.model.js'
import { ImportJob, IMPORT_LOCK_TTL_MS } from '../../../models/importJob.model.js'
import { CONTACT_SOURCE, CONTACT_SYNC_STATUS } from '../../contacts/constants/contactConstants.js'
import { deriveContactFields, normaliseEmail, normalisePhone } from '../../../models/contact.model.js'
import {
  CHUNK_SIZE,
  DUPLICATE_ACTION,
  IMPORT_STATUS,
  IMPORT_STEP,
  ROW_STATUS,
} from '../constants/importConstants.js'
import { validateRow } from './validation.service.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('import-engine')

/** Issues retained per job. Beyond this the list stops informing and starts bloating. */
const MAX_STORED_ISSUES = 500

/**
 * Classifies every row without writing anything.
 *
 * Existing-contact detection is done with **two bulk queries** rather than one
 * lookup per row. On a 5,000-row file the per-row approach is 10,000 round trips
 * and takes minutes; this takes one round trip per key type.
 *
 * @param {object} params
 * @returns {Promise<object>} The analysis summary, with per-row detail attached.
 */
export async function analyseJob({ job, rows, owner }) {
  const analysis = {
    totalRows: rows.length,
    validRows: 0,
    invalidRows: 0,
    duplicateInFile: 0,
    duplicateExisting: 0,
    missingEmail: 0,
    emptyRows: 0,
    analysedAt: new Date(),
  }

  const issues = []
  const prepared = []

  // --- Pass 1: validate and normalise --------------------------------------
  const seenEmails = new Set()
  const seenPhones = new Set()

  for (const [index, row] of rows.entries()) {
    // 1-based, counting the header, so it matches what the user sees in Excel.
    const rowNumber = index + 2

    const { contact, status, issues: rowIssues, custom } = validateRow({
      row,
      mapping: job.mapping,
      rowNumber,
    })

    let finalStatus = status

    // --- Duplicates within the file itself ---------------------------------
    //
    // Checked before the database: a file containing the same lead twice is
    // extremely common, and importing both then deduplicating afterwards would
    // leave the user with a mess they did not create.
    if (status === ROW_STATUS.VALID) {
      const email = normaliseEmail(contact.primaryEmail)
      const phone = normalisePhone(contact.mobile ?? contact.phone ?? contact.businessPhone)

      if (email && seenEmails.has(email)) {
        finalStatus = ROW_STATUS.DUPLICATE_IN_FILE
        rowIssues.push({
          row: rowNumber,
          status: ROW_STATUS.DUPLICATE_IN_FILE,
          field: 'primaryEmail',
          message: `"${email}" appears earlier in this file.`,
          value: email,
        })
      } else if (!email && phone && seenPhones.has(phone)) {
        finalStatus = ROW_STATUS.DUPLICATE_IN_FILE
        rowIssues.push({
          row: rowNumber,
          status: ROW_STATUS.DUPLICATE_IN_FILE,
          field: 'phone',
          message: 'This phone number appears earlier in this file.',
          value: phone,
        })
      }

      if (email) seenEmails.add(email)
      if (phone) seenPhones.add(phone)
    }

    prepared.push({ rowNumber, contact, custom, status: finalStatus })

    for (const issue of rowIssues) {
      if (issues.length < MAX_STORED_ISSUES) issues.push(issue)
    }
  }

  // --- Pass 2: existing contacts, in bulk ----------------------------------
  const candidateEmails = [
    ...new Set(
      prepared
        .filter((entry) => entry.status === ROW_STATUS.VALID)
        .map((entry) => normaliseEmail(entry.contact.primaryEmail))
        .filter(Boolean),
    ),
  ]

  const existingByEmail = new Map()

  if (candidateEmails.length > 0) {
    // Chunked because a `$in` with 50,000 terms exceeds MongoDB's query limit.
    for (let start = 0; start < candidateEmails.length; start += 5000) {
      const slice = candidateEmails.slice(start, start + 5000)

      const found = await Contact.find({
        owner,
        isDeleted: false,
        matchEmails: { $in: slice },
      }).select('_id displayName primaryEmail matchEmails')

      for (const contact of found) {
        for (const email of contact.matchEmails) existingByEmail.set(email, contact)
      }
    }
  }

  // --- Tally ---------------------------------------------------------------
  for (const entry of prepared) {
    if (entry.status === ROW_STATUS.VALID) {
      const email = normaliseEmail(entry.contact.primaryEmail)
      const existing = email ? existingByEmail.get(email) : null

      if (existing) {
        entry.status = ROW_STATUS.DUPLICATE_EXISTING
        entry.existingId = existing._id

        if (issues.length < MAX_STORED_ISSUES) {
          issues.push({
            row: entry.rowNumber,
            status: ROW_STATUS.DUPLICATE_EXISTING,
            field: 'primaryEmail',
            message: `Already in your contacts as "${existing.displayName}".`,
            value: email,
          })
        }
      }
    }

    switch (entry.status) {
      case ROW_STATUS.VALID: analysis.validRows += 1; break
      case ROW_STATUS.INVALID: analysis.invalidRows += 1; break
      case ROW_STATUS.DUPLICATE_IN_FILE: analysis.duplicateInFile += 1; break
      case ROW_STATUS.DUPLICATE_EXISTING: analysis.duplicateExisting += 1; break
      case ROW_STATUS.MISSING_EMAIL: analysis.missingEmail += 1; break
      case ROW_STATUS.EMPTY: analysis.emptyRows += 1; break
      default: break
    }
  }

  log.info('Import analysed', {
    jobId: job._id.toString(),
    ...analysis,
    issuesRecorded: issues.length,
  })

  return { analysis, issues, prepared }
}

/**
 * Builds the Contact document for one prepared row.
 */
function toContactDocument({ entry, job, owner }) {
  return {
    ...entry.contact,
    owner,
    createdBy: job.createdBy ?? owner,
    updatedBy: job.createdBy ?? owner,

    uuid: crypto.randomUUID(),

    // Import-supplied tags are combined with the job's defaults.
    tags: [...new Set([...(entry.contact.tags ?? []), ...(job.defaultTags ?? [])])],

    leadSource: entry.contact.leadSource ?? job.defaultLeadSource ?? 'import',
    leadStatus: entry.contact.leadStatus ?? job.defaultLeadStatus ?? 'new',

    source: CONTACT_SOURCE.IMPORT,
    syncStatus: CONTACT_SYNC_STATUS.LOCAL,

    importJob: job._id,
    importRow: entry.rowNumber,

    customFields: Object.keys(entry.custom).length > 0 ? entry.custom : undefined,
  }
}

/**
 * Runs one chunk of an import.
 *
 * Returns the counters for that chunk rather than mutating the job, so the
 * caller decides when to persist — which keeps the write pattern one update per
 * chunk rather than one per row.
 *
 * @returns {Promise<{ imported: number, updated: number, skipped: number, failed: number, createdIds: object[], issues: object[] }>}
 */
async function processChunk({ chunk, job, owner }) {
  const result = { imported: 0, updated: 0, skipped: 0, failed: 0, createdIds: [], issues: [] }

  const toInsert = []

  for (const entry of chunk) {
    // Rows that cannot become contacts are counted and passed over.
    if ([ROW_STATUS.EMPTY, ROW_STATUS.INVALID, ROW_STATUS.MISSING_EMAIL].includes(entry.status)) {
      result.skipped += 1
      continue
    }

    if (entry.status === ROW_STATUS.DUPLICATE_IN_FILE) {
      result.skipped += 1
      continue
    }

    if (entry.status === ROW_STATUS.DUPLICATE_EXISTING) {
      const action = job.duplicateAction ?? DUPLICATE_ACTION.SKIP

      if (action === DUPLICATE_ACTION.SKIP) {
        result.skipped += 1
        continue
      }

      if (action === DUPLICATE_ACTION.REPLACE || action === DUPLICATE_ACTION.MERGE) {
        try {
          const existing = await Contact.findOne({ _id: entry.existingId, owner })

          if (!existing) {
            result.failed += 1
            continue
          }

          for (const [field, value] of Object.entries(entry.contact)) {
            if (value === null || value === undefined || value === '') continue

            // Merge fills blanks only; replace overwrites. Tags are unioned in
            // both cases, because a tag the user applied is theirs to keep.
            if (field === 'tags') {
              existing.tags = [...new Set([...(existing.tags ?? []), ...value])]
              continue
            }

            const isBlank = existing[field] === null || existing[field] === undefined || existing[field] === ''

            if (action === DUPLICATE_ACTION.REPLACE || isBlank) {
              existing[field] = value
            }
          }

          existing.updatedBy = job.createdBy ?? owner
          await existing.save()

          result.updated += 1
        } catch (error) {
          result.failed += 1
          result.issues.push({
            row: entry.rowNumber,
            status: ROW_STATUS.INVALID,
            field: null,
            message: error?.message ?? String(error),
            value: null,
          })
        }
        continue
      }

      // IMPORT_ANYWAY falls through to insertion.
    }

    toInsert.push(toContactDocument({ entry, job, owner }))
  }

  // --- Bulk insert ---------------------------------------------------------
  if (toInsert.length > 0) {
    try {
      /**
       * `ordered: false` so one bad document does not abandon the rest of the
       * batch — which is exactly what happens with the default, and would mean a
       * single duplicate key silently dropping 249 good contacts.
       */
      /**
       * Derived fields are computed explicitly because `insertMany` bypasses
       * document middleware. Without this the imported contacts would carry no
       * `matchEmails`, making them invisible to duplicate detection — so the
       * very next import of the same file would insert every row again.
       */
      const inserted = await Contact.insertMany(toInsert.map(deriveContactFields), {
        ordered: false,
        rawResult: false,
      })

      result.imported += inserted.length
      result.createdIds.push(...inserted.map((doc) => doc._id))
    } catch (error) {
      // A partial failure reports which documents landed; the rest are counted
      // as failures with their reasons preserved.
      const inserted = error?.insertedDocs ?? []
      result.imported += inserted.length
      result.createdIds.push(...inserted.map((doc) => doc._id))

      const writeErrors = error?.writeErrors ?? []
      result.failed += writeErrors.length || Math.max(0, toInsert.length - inserted.length)

      for (const writeError of writeErrors.slice(0, 20)) {
        result.issues.push({
          row: chunk[writeError.index]?.rowNumber ?? 0,
          status: ROW_STATUS.INVALID,
          field: null,
          message: writeError.errmsg ?? 'Write failed.',
          value: null,
        })
      }
    }
  }

  return result
}

/**
 * Executes an import, chunk by chunk.
 *
 * Resumable: called again on a job with a cursor, it continues from there rather
 * than starting over.
 *
 * @param {object} params
 * @param {object} params.job
 * @param {Array} params.prepared Output of `analyseJob`.
 * @param {import('mongoose').Types.ObjectId} params.owner
 * @param {(progress: object) => void} [params.onProgress]
 * @returns {Promise<object>} The finished job.
 */
export async function runImport({ job, prepared, owner, onProgress = null }) {
  const startedAt = Date.now()

  // Atomic lock acquisition: the filter requires the lock to be free or stale,
  // so two workers cannot both pass it.
  const staleBefore = new Date(Date.now() - IMPORT_LOCK_TTL_MS)

  const locked = await ImportJob.findOneAndUpdate(
    {
      _id: job._id,
      $or: [{ lockedAt: null }, { lockedAt: { $lt: staleBefore } }],
    },
    { $set: { lockedAt: new Date(), status: IMPORT_STATUS.RUNNING, startedAt: job.startedAt ?? new Date() } },
    { new: true },
  )

  if (!locked) {
    throw new Error('This import is already running.')
  }

  let cursor = job.cursor ?? 0
  const totals = { ...job.progress.toObject?.() ?? job.progress }
  const createdIds = []
  const newIssues = []

  try {
    while (cursor < prepared.length) {
      const chunk = prepared.slice(cursor, cursor + CHUNK_SIZE)

      const result = await processChunk({ chunk, job: locked, owner })

      totals.imported += result.imported
      totals.updated += result.updated
      totals.skipped += result.skipped
      totals.failed += result.failed

      createdIds.push(...result.createdIds)
      newIssues.push(...result.issues)

      cursor += chunk.length

      // Persisted after every chunk, so a crash loses at most one chunk of
      // progress and the resume point is always accurate.
      await ImportJob.updateOne(
        { _id: job._id },
        {
          $set: { cursor, progress: totals, lockedAt: new Date() },
          $push: { createdContactIds: { $each: result.createdIds } },
        },
      )

      onProgress?.({ cursor, total: prepared.length, ...totals })
    }

    /**
     * `partial` when some rows failed. Reporting a run that imported 4,800 of
     * 5,000 as `failed` would tell the user to discard 4,800 good contacts.
     */
    const status = totals.failed > 0 ? IMPORT_STATUS.PARTIAL : IMPORT_STATUS.COMPLETED
    const durationMs = Date.now() - startedAt

    const finished = await ImportJob.findOneAndUpdate(
      { _id: job._id },
      {
        $set: {
          status,
          step: IMPORT_STEP.IMPORT,
          cursor,
          progress: totals,
          finishedAt: new Date(),
          durationMs,
          lockedAt: null,
          // The parsed rows have served their purpose; keeping them would grow
          // the collection without bound.
          rows: [],
        },
        $push: { issues: { $each: newIssues.slice(0, 100) } },
      },
      { new: true },
    )

    log.info('Import completed', {
      jobId: job._id.toString(),
      status,
      ...totals,
      durationMs,
      rowsPerSecond: durationMs > 0 ? Math.round((cursor / durationMs) * 1000) : 0,
    })

    return finished
  } catch (error) {
    await ImportJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: IMPORT_STATUS.FAILED,
          cursor,
          progress: totals,
          lockedAt: null,
          lastError: { message: error?.message ?? String(error), occurredAt: new Date() },
        },
      },
    )

    log.error('Import failed', {
      jobId: job._id.toString(),
      cursor,
      message: error?.message,
    })

    throw error
  }
}

/**
 * Removes every contact an import created.
 *
 * Deletes exactly the recorded ids — not "everything imported today", which
 * would take contacts the user has since edited and contacts another job
 * created. The job is retained and marked, so the history shows it happened.
 *
 * @returns {Promise<{ removed: number, job: object }>}
 */
export async function rollbackImport({ jobId, owner }) {
  const job = await ImportJob.findOne({ _id: jobId, owner }).select('+createdContactIds')

  if (!job) throw new Error('No import with that id exists.')

  if (job.rolledBackAt) {
    throw new Error(`This import was already rolled back on ${job.rolledBackAt.toISOString()}.`)
  }

  const ids = job.createdContactIds ?? []

  if (ids.length === 0) {
    job.rolledBackAt = new Date()
    job.status = IMPORT_STATUS.ROLLED_BACK
    await job.save()
    return { removed: 0, job }
  }

  /**
   * Soft-deleted, not removed.
   *
   * A rollback is itself an action that can be regretted, and these contacts may
   * already carry campaign history. Marking them keeps that recoverable.
   */
  const { modifiedCount } = await Contact.updateMany(
    { _id: { $in: ids }, owner, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date() } },
  )

  job.rolledBackAt = new Date()
  job.rolledBackCount = modifiedCount ?? 0
  job.status = IMPORT_STATUS.ROLLED_BACK
  await job.save()

  log.warn('Import rolled back', {
    jobId: job._id.toString(),
    removed: modifiedCount,
    ofCreated: ids.length,
  })

  return { removed: modifiedCount ?? 0, job }
}

export default { analyseJob, runImport, rollbackImport }
