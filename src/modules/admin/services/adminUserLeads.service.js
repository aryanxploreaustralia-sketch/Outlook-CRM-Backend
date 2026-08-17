/**
 * Assigning a starting book of enquiries to a user.
 *
 * An administrator hiring somebody uploads the workbook of enquiries that
 * person is taking over, and those enquiries become theirs.
 *
 * ## This file imports nothing of its own
 *
 * Every rule that decides what a row means already exists and is in production:
 * `fromXlsx` reads the workbook, `classifyWorkbook` decides which sheets are
 * lead registers and how their columns map, and `importSheet` validates,
 * de-duplicates and writes. Query Date parsing, the four-stage `Status`
 * mapping, Remarks, phones, pax and company resolution all live there and are
 * called, not reimplemented.
 *
 * What is genuinely new is one line of intent: `owner` is the **new user's**
 * id rather than the caller's. Everything else is orchestration.
 *
 * ## Why `owner` is the assignment
 *
 * `Lead.owner` is the only ownership field on the model, and every read path in
 * the application scopes by it — `ownerOf(req)` is `req.auth.user._id`. A lead
 * is therefore visible to exactly one user: its owner. Setting `owner` to the
 * new account is not merely how they are assigned, it is the only thing that
 * makes them visible to that person at all.
 *
 * A consequence worth stating plainly: these enquiries move *into* the new
 * user's register and are not visible in the administrator's own. That is the
 * existing data model, not a decision taken here.
 *
 * ## Why every lead sheet is imported
 *
 * The ordinary importer asks the user to choose a sheet, because they are
 * standing in a wizard. This runs during account creation, where there is no
 * wizard and no sensible moment to ask. So the same classifier the wizard uses
 * picks the sheets for it: those it identifies as lead registers are imported
 * and the rest — hotel operations tabs, empty tabs — are reported as skipped
 * rather than guessed at.
 */

import { ImportJob } from '../../../models/importJob.model.js'
import { Lead } from '../../../models/lead.model.js'
import { User } from '../../../models/user.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { fromXlsx, listSheets } from '../../contacts/utils/xlsx.js'
import { IMPORT_STATUS, IMPORT_STEP } from '../../import/constants/importConstants.js'
import { SHEET_KIND } from '../../leads/constants/leadConstants.js'
import { analyseSheet, importSheet } from '../../leads/services/leadImport.service.js'
import { purgeLeads } from '../../leads/services/leadPurge.service.js'
import { classifyWorkbook } from '../../leads/services/worksheetClassifier.service.js'

const log = createContextLogger('admin-user-leads')

/**
 * Resolves the account the enquiries are for.
 *
 * The id arrives in the URL from a browser, so it is re-read from the database
 * rather than trusted: a caller holding `users.invite` must not be able to move
 * enquiries onto an account that does not exist, or onto one that has been
 * deleted and would hide them from everybody.
 *
 * @param {string} userId
 * @returns {Promise<import('mongoose').Document>}
 */
async function resolveTargetUser(userId) {
  const user = await User.findById(userId)

  if (!user || user.isDeleted) {
    throw ApiError.notFound('That user does not exist.', { code: 'USER_NOT_FOUND' })
  }

  return user
}

/**
 * Imports a workbook and assigns every enquiry in it to one user.
 *
 * @param {{
 *   userId: string,
 *   buffer: Buffer,
 *   filename: string,
 *   actor: object,
 * }} params
 * @returns {Promise<{
 *   user: { id: string, email: string, fullName: ?string },
 *   created: number, updated: number, invalid: number, duplicate: number,
 *   failed: number, total: number,
 *   sheets: Array<{ name: string, kind: string, imported: boolean, reason: ?string,
 *                   created: number, updated: number, invalid: number, failed: number }>,
 *   importJob: ?string,
 *   issues: Array<object>,
 * }>}
 */
export async function assignWorkbookToUser({
  userId,
  buffer,
  filename,
  actor,
  sheets = null,
  mapping = null,
  dryRun = false,
}) {
  const user = await resolveTargetUser(userId)

  // Read the workbook once and classify every tab, exactly as the import wizard
  // does on its first step.
  let names
  try {
    names = listSheets(buffer).map((sheet) => sheet.name)
  } catch (error) {
    throw ApiError.badRequest(
      'That file could not be read as an .xlsx workbook.',
      { code: 'WORKBOOK_UNREADABLE', cause: error },
    )
  }

  if (names.length === 0) {
    throw ApiError.badRequest('That workbook contains no worksheets.', { code: 'WORKBOOK_EMPTY' })
  }

  const parsedSheets = names.map((name) => {
    const parsed = fromXlsx(buffer, { sheet: name })
    return { name, parsed, rows: parsed.grid.slice(parsed.headerRowNumber) }
  })

  const classified = classifyWorkbook(
    parsedSheets.map(({ name, parsed, rows }) => ({ name, headers: parsed.headers, rows })),
  )

  /**
   * Which sheets the caller asked for.
   *
   * `sheets` is the wizard's selection, made after the admin has seen the
   * classification. Omitting it keeps the original behaviour — every sheet the
   * classifier calls a lead register — which is what the invitation flow relies
   * on, since it has no wizard and no moment to ask.
   *
   * A named sheet the classifier did *not* call a lead register is refused
   * rather than imported on request: the classification is the same judgement
   * the preview showed, and quietly overriding it would import a hotel
   * operations tab as enquiries.
   */
  const chosen = Array.isArray(sheets) && sheets.length > 0 ? new Set(sheets) : null

  if (chosen) {
    const known = new Set(classified.sheets.map((sheet) => sheet.name))
    const unknown = [...chosen].filter((name) => !known.has(name))

    if (unknown.length > 0) {
      throw ApiError.badRequest(
        `"${filename}" has no worksheet named ${unknown.map((n) => `"${n}"`).join(', ')}.`,
        { code: 'SHEET_NOT_FOUND' },
      )
    }
  }

  const leadSheets = classified.sheets.filter(
    (sheet) => sheet.kind === SHEET_KIND.LEADS && (!chosen || chosen.has(sheet.name)),
  )

  if (chosen && leadSheets.length === 0) {
    throw ApiError.badRequest(
      'None of the selected worksheets is a lead register, so nothing would be imported.',
      { code: 'NO_LEAD_SHEETS' },
    )
  }

  /**
   * A mapping the admin corrected, merged over the detected one.
   *
   * Applied by column index and only to the sheet it was reviewed against, so
   * a correction cannot leak onto a different sheet with different columns.
   * The same merge the CRM importer performs, for the same reason: a supplied
   * mapping is an override of the classifier, never a replacement for it.
   */
  const mappingFor = (sheet) => {
    if (!mapping || !Array.isArray(mapping)) return sheet.mapping
    if (chosen && chosen.size !== 1) return sheet.mapping

    return sheet.mapping.map((entry) => {
      const override = mapping.find((candidate) => candidate.index === entry.index)
      return override ? { ...entry, field: override.field, source: 'manual' } : entry
    })
  }

  /**
   * Preview: validate every selected sheet and write nothing.
   *
   * Runs `analyseSheet` — the same function the CRM wizard's preview step uses
   * — against the **target** user, so "already on file" counts reflect that
   * user's register rather than the administrator's.
   */
  if (dryRun) {
    const previews = []

    for (const sheet of leadSheets) {
      const source = parsedSheets.find((entry) => entry.name === sheet.name)
      const analysis = await analyseSheet({
        rows: source.rows,
        mapping: mappingFor(sheet),
        sheetName: sheet.name,
        headerRowNumber: source.parsed.headerRowNumber,
        owner: user._id,
      })

      previews.push({ name: sheet.name, mapping: mappingFor(sheet), ...analysis })
    }

    return {
      dryRun: true,
      user: {
        id: String(user._id),
        email: user.email,
        displayName: user.displayName ?? null,
      },
      sheets: classified.sheets.map((sheet) => ({
        name: sheet.name,
        kind: sheet.kind,
        reason: sheet.reason ?? null,
        rowCount: sheet.rowCount ?? 0,
        selectable: sheet.kind === SHEET_KIND.LEADS,
        mapping: sheet.mapping,
      })),
      previews,
    }
  }

  if (leadSheets.length === 0) {
    throw ApiError.badRequest(
      `No worksheet in "${filename}" looks like a lead register, so nothing was imported. ` +
        'Check that the file is the sales workbook and that its columns are named as usual.',
      { code: 'NO_LEAD_SHEETS' },
    )
  }

  /**
   * One job row for the whole upload.
   *
   * `owner` is the new user, matching the enquiries the job produced, so the
   * import appears in *their* workbook history rather than the administrator's.
   * `createdBy` records who actually performed it.
   */
  const job = await ImportJob.create({
    owner: user._id,
    createdBy: actor._id,
    filename,
    fileSize: buffer.length,
    format: 'xlsx',
    status: IMPORT_STATUS.RUNNING,
    step: IMPORT_STEP.IMPORT,
    headers: parsedSheets[0]?.parsed?.headers ?? [],
    startedAt: new Date(),
  })

  const totals = { total: 0, created: 0, updated: 0, invalid: 0, duplicate: 0, failed: 0 }
  const perSheet = []
  const issues = []

  try {
    for (const sheet of classified.sheets) {
      const source = parsedSheets.find((entry) => entry.name === sheet.name)

      // A sheet the admin did not select is reported as skipped, not silently
      // dropped — the result must account for every tab in the file.
      if (chosen && !chosen.has(sheet.name)) {
        perSheet.push({
          name: sheet.name,
          kind: sheet.kind,
          imported: false,
          reason: 'Not selected for import.',
          created: 0,
          updated: 0,
          invalid: 0,
          failed: 0,
        })
        continue
      }

      if (sheet.kind !== SHEET_KIND.LEADS) {
        perSheet.push({
          name: sheet.name,
          kind: sheet.kind,
          imported: false,
          reason: sheet.reason ?? 'Not a lead register.',
          created: 0,
          updated: 0,
          invalid: 0,
          failed: 0,
        })
        continue
      }

      // The same call the ordinary importer makes. `owner` is the only
      // difference, and it is the whole feature.
      const result = await importSheet({
        rows: source.rows,
        mapping: mappingFor(sheet),
        sheetName: sheet.name,
        headerRowNumber: source.parsed.headerRowNumber,
        owner: user._id,
        createdBy: actor._id,
        importJob: job._id,
      })

      for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0
      issues.push(...(result.issues ?? []).slice(0, 100))

      perSheet.push({
        name: sheet.name,
        kind: sheet.kind,
        imported: true,
        reason: null,
        created: result.created,
        updated: result.updated,
        invalid: result.invalid,
        failed: result.failed,
      })
    }

    job.status =
      totals.failed > 0 || totals.invalid > 0 ? IMPORT_STATUS.PARTIAL : IMPORT_STATUS.COMPLETED
    job.cursor = totals.total
    job.progress = {
      imported: totals.created,
      updated: totals.updated,
      skipped: totals.duplicate,
      failed: totals.failed + totals.invalid,
    }
    job.finishedAt = new Date()
    await job.save()
  } catch (error) {
    // The job is marked failed and the error re-thrown. Leaving it RUNNING
    // would show a permanently in-flight import in the new user's history.
    job.status = IMPORT_STATUS.FAILED
    // `lastError`, matching how `workbookQueue.service` records a failure.
    job.lastError = {
      message: error.message?.slice(0, 512) ?? 'The import failed.',
      occurredAt: new Date(),
    }
    job.finishedAt = new Date()
    await job.save().catch(() => {})

    log.error('Assigning a workbook to a new user failed', {
      userId: String(user._id),
      filename,
      error: error.message,
    })

    throw error
  }

  log.info('Workbook assigned to user', {
    userId: String(user._id),
    filename,
    created: totals.created,
    updated: totals.updated,
  })

  return {
    user: {
      id: String(user._id),
      email: user.email,
      // `displayName` is the User model's name field; there is no `fullName`.
      displayName: user.displayName ?? null,
    },
    ...totals,
    sheets: perSheet,
    importJob: String(job._id),
    issues: issues.slice(0, 200),
  }
}

export default { assignWorkbookToUser, deleteUserLeads }

/**
 * Deletes enquiries belonging to one user, on an administrator's behalf.
 *
 * ## Two deletion models, both pre-existing
 *
 * The CRM already deletes leads two different ways and this endpoint reuses
 * both rather than inventing a third:
 *
 *   - a named set is **soft** deleted (`isDeleted = true`), matching
 *     `DELETE /v1/leads/:id`;
 *   - `all` runs `purgeLeads`, the **hard** purge behind `DELETE /v1/leads/all`,
 *     which also unlinks the timeline, tasks and conversations.
 *
 * The asymmetry is the existing convention, not a decision taken here. It is
 * reported back as `mode` so the caller can say which happened.
 *
 * ## Why a foreign id cannot be deleted
 *
 * `owner: user._id` is part of the **query**, not a check performed before it.
 * An id belonging to somebody else simply matches nothing, so no amount of
 * crafting the request body can reach another user's register. Ids that matched
 * nothing are returned in `skipped`, and are never counted as deleted.
 *
 * @param {{ userId: string, leadIds?: string[], all?: boolean, actor: object }} params
 * @returns {Promise<object>}
 */
export async function deleteUserLeads({ userId, leadIds = [], all = false, actor }) {
  const user = await resolveTargetUser(userId)

  const target = {
    id: String(user._id),
    email: user.email,
    displayName: user.displayName ?? null,
  }

  if (all) {
    const result = await purgeLeads({ owner: user._id })

    log.warn('Administrator purged a user\'s register', {
      userId: target.id,
      actor: String(actor._id),
      deleted: result.deletedLeads,
    })

    return {
      mode: 'purge',
      user: target,
      deleted: result.deletedLeads,
      requested: null,
      skipped: [],
      detail: result.detail ?? null,
    }
  }

  const ids = [...new Set(leadIds.map(String))]

  // Scoped by owner in the query itself — see the note above.
  const scope = { _id: { $in: ids }, owner: user._id, isDeleted: false }

  // Read first, so the response can name exactly which ids were acted on and
  // which were not. `updateMany` reports a count and nothing else.
  const matched = await Lead.find(scope).select('_id').lean()
  const matchedIds = matched.map((lead) => String(lead._id))

  const result = matchedIds.length
    ? await Lead.updateMany(scope, { $set: { isDeleted: true } })
    : { modifiedCount: 0 }

  log.warn('Administrator deleted leads for a user', {
    userId: target.id,
    actor: String(actor._id),
    requested: ids.length,
    deleted: result.modifiedCount ?? 0,
  })

  return {
    mode: 'soft',
    user: target,
    deleted: result.modifiedCount ?? 0,
    requested: ids.length,
    /**
     * Ids that changed nothing: another user's, already deleted, or unknown.
     *
     * Reported rather than silently dropped — an administrator who selected
     * fifty rows and deleted forty-eight needs to know which two, and why the
     * numbers differ.
     */
    skipped: ids.filter((id) => !matchedIds.includes(id)),
  }
}
