/**
 * Imports a worksheet into Companies, Contacts and Leads.
 *
 * The pipeline the business actually needs:
 *
 *     workbook → sheet → classify → map → validate → resolve → upsert
 *
 * Each row yields **one lead**. The company and the contact behind it are
 * resolved, not created blindly — see `companyResolver.service.js` for why
 * identity is a domain first and a name second.
 *
 * ## Re-importing is safe by construction
 *
 * The team maintains this workbook continuously and will upload it again every
 * month. Leads are keyed on `reference`, so a second upload updates the rows
 * that changed, inserts the ones that are new, and touches nothing else. That
 * is the difference between a tool the team uses and one they upload to once.
 */

import { Lead } from '../../../models/lead.model.js'
import { createContextLogger } from '../../../utils/logger.js'
import { createResolver } from './companyResolver.service.js'
import { validateLeadRow } from './leadValidation.service.js'
import { LEAD_CHUNK_SIZE } from '../constants/leadConstants.js'

const log = createContextLogger('lead-import')

/**
 * Fields a re-import is allowed to overwrite on an existing lead.
 *
 * `stage` is deliberately absent by default. Once the CRM is live the pipeline
 * is maintained here, not in the spreadsheet: a lead moved to `negotiation` by
 * a salesperson must not be dragged back to `new` because the sheet still says
 * "Active". `overwriteStage` opts into the other behaviour for a first import.
 */
const REFRESHABLE_FIELDS = [
  'contactPerson', 'companyName', 'email', 'phones',
  'quoteDate', 'travelDate', 'travelDateText',
  'city', 'paxText', 'adultCount', 'childCount',
  'handledBy', 'internalNotes', 'market',
]

/**
 * Drops rows that hold nothing at all.
 *
 * A worksheet's used range routinely extends past the last real entry — the
 * sales workbook declares 1,881 rows for 1,698 of data. Counting those blanks
 * as "invalid" would report 199 problems for a perfectly clean file and train
 * the user to ignore the error count.
 */
function withoutBlankRows(rows, mapping) {
  const mappedIndexes = mapping
    .filter((entry) => entry.field !== '__ignore__')
    .map((entry) => entry.index)

  return rows.filter((row) => {
    if (!row) return false
    return mappedIndexes.some((index) => String(row[index] ?? '').trim() !== '')
  })
}

/**
 * Validates every row without writing anything.
 *
 * Powers the preview screen: the user sees exactly what will happen before it
 * happens, including which rows will be rejected and why.
 *
 * @param {{ rows: string[][], mapping: object[], sheetName: string,
 *           headerRowNumber?: number, owner: any, limit?: number }} params
 */
export async function analyseSheet({
  rows: allRows,
  mapping,
  sheetName,
  headerRowNumber = 1,
  owner,
  limit = 20,
}) {
  const rows = withoutBlankRows(allRows, mapping)

  const issues = []
  const samples = []
  const seenReferences = new Map()

  const counts = {
    total: rows.length,
    valid: 0,
    invalid: 0,
    duplicateInFile: 0,
    existing: 0,
    new: 0,
  }


  for (const [index, row] of rows.entries()) {
    const rowNumber = headerRowNumber + index + 1
    const result = validateLeadRow({ row, mapping, rowNumber, sheetName })

    if (!result.valid) {
      counts.invalid += 1
      issues.push(...result.issues.filter((issue) => issue.severity === 'error'))
      continue
    }

    counts.valid += 1
    if (result.issues.length > 0) issues.push(...result.issues)

    const previous = seenReferences.get(result.lead.reference)
    if (previous !== undefined) {
      counts.duplicateInFile += 1
      issues.push({
        row: rowNumber,
        field: 'reference',
        severity: 'warning',
        message: `Reference ${result.lead.reference} also appears on row ${previous}; the later row wins.`,
      })
    }
    seenReferences.set(result.lead.reference, rowNumber)


    if (samples.length < limit) samples.push(result.lead)
  }

  // How many of these already exist, so the preview can say "update" rather
  // than "create" honestly.
  const references = [...seenReferences.keys()]

  for (let start = 0; start < references.length; start += 1000) {
    const slice = references.slice(start, start + 1000)
    const found = await Lead.find({ owner, reference: { $in: slice }, isDeleted: false })
      .select('reference')
      .lean()
    counts.existing += found.length
  }

  counts.new = counts.valid - counts.duplicateInFile - counts.existing

  return {
    counts,
    samples,
    // Capped so a wholly broken sheet cannot return a 50 MB response.
    issues: issues.slice(0, 500),
    issuesTruncated: issues.length > 500,
    distinctReferences: references.length,
  }
}

/**
 * Imports validated rows.
 *
 * @param {{ rows, mapping, sheetName, headerRowNumber, owner, createdBy,
 *           importJob, overwriteStage?, onProgress? }} params
 */
export async function importSheet({
  rows: allRows,
  mapping,
  sheetName,
  headerRowNumber = 1,
  owner,
  createdBy = null,
  importJob = null,
  overwriteStage = false,
  onProgress = null,
}) {
  const rows = withoutBlankRows(allRows, mapping)

  const resolver = createResolver({ owner, importJob, createdBy })

  const outcome = {
    total: rows.length,
    created: 0,
    updated: 0,
    invalid: 0,
    duplicate: 0,
    failed: 0,
    skipped: 0,
  }

  const issues = []
  const seen = new Set()

  for (let start = 0; start < rows.length; start += LEAD_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + LEAD_CHUNK_SIZE)

    for (const [offset, row] of chunk.entries()) {
      const index = start + offset
      const rowNumber = headerRowNumber + index + 1

      try {
        const result = validateLeadRow({ row, mapping, rowNumber, sheetName })

        if (!result.valid) {
          outcome.invalid += 1
          issues.push(...result.issues.filter((issue) => issue.severity === 'error'))
          continue
        }

        if (result.issues.length > 0) issues.push(...result.issues)

        const data = result.lead

        // A reference repeated inside one file is counted once; the later row
        // still updates, because the newer entry is the current truth.
        if (seen.has(data.reference)) outcome.duplicate += 1
        seen.add(data.reference)

        const company = await resolver.resolveCompany({
          companyName: data.companyName,
          email: data.email,
          city: data.city,
        })

        const contact = await resolver.resolveContact({
          email: data.email,
          displayName: data.displayName,
          firstName: data.firstName,
          lastName: data.lastName,
          companyName: data.companyName,
          company,
          phones: data.phones,
          additionalEmails: data.additionalEmails,
          city: data.city,
        })

        const existing = await Lead.findOne({ owner, reference: data.reference, isDeleted: false })

        if (existing) {
          for (const field of REFRESHABLE_FIELDS) {
            if (data[field] !== null && data[field] !== undefined) existing[field] = data[field]
          }

          existing.company = company?._id ?? existing.company
          existing.contact = contact?._id ?? existing.contact
          existing.importJob = importJob ?? existing.importJob
          existing.sourceSheet = sheetName
          existing.sourceRow = rowNumber

          if (overwriteStage && data.stage !== existing.stage) {
            existing.moveToStage(data.stage, { by: createdBy, reason: 'Updated from spreadsheet import' })
          }

          await existing.save()
          outcome.updated += 1
        } else {
          await Lead.create({
            owner,
            createdBy,
            reference: data.reference,
            market: data.market,
            company: company?._id ?? null,
            contact: contact?._id ?? null,
            contactPerson: data.contactPerson,
            companyName: data.companyName,
            email: data.email,
            phones: data.phones,
            quoteDate: data.quoteDate,
            travelDate: data.travelDate,
            travelDateText: data.travelDateText,
            city: data.city,
            paxText: data.paxText,
            adultCount: data.adultCount,
            childCount: data.childCount,
            stage: data.stage,
            stageHistory: [{ to: data.stage, at: new Date(), by: createdBy, reason: 'Created from spreadsheet import' }],
            handledBy: data.handledBy,
            internalNotes: data.internalNotes,
            importJob,
            sourceSheet: sheetName,
            sourceRow: rowNumber,
          })
          outcome.created += 1
        }
      } catch (error) {
        outcome.failed += 1
        issues.push({
          row: rowNumber,
          field: null,
          severity: 'error',
          message: error?.message ?? 'The row could not be imported.',
        })
        log.warn('Lead row failed', { rowNumber, sheetName, error: error?.message })
      }
    }

    if (onProgress) {
      await onProgress({
        processed: Math.min(start + LEAD_CHUNK_SIZE, rows.length),
        total: rows.length,
        ...outcome,
      })
    }
  }

  const resolution = await resolver.finalise()

  log.info('Sheet imported', { sheetName, ...outcome, ...resolution })

  return {
    ...outcome,
    ...resolution,
    issues: issues.slice(0, 500),
    issuesTruncated: issues.length > 500,
  }
}

/**
 * Undoes an import.
 *
 * Leads are removed outright because they were created by this run and have no
 * independent history. Companies and contacts are only removed when the run
 * created them **and** nothing else now references them — a contact that has
 * since been emailed, or a company that another import also touched, is left
 * alone. A rollback that deleted those would destroy work the import did not do.
 */
export async function rollbackImport({ owner, importJob }) {
  const { Company } = await import('../../../models/company.model.js')
  const { Contact } = await import('../../../models/contact.model.js')

  const leads = await Lead.deleteMany({ owner, importJob })

  const candidateContacts = await Contact.find({ owner, importJob, isDeleted: false }).select('_id')

  /*
   * Which of this job's contacts still have an enquiry, in one query.
   *
   * This asked per contact and updated per contact — the same N+1 the main
   * import had. `$group` returns the ids that still have at least one live
   * lead; every candidate absent from that set has none left and is soft
   * deleted together.
   *
   * The leads were removed immediately above, so this runs against the state
   * after deletion — same ordering as before.
   */
  let contactsRemoved = 0

  if (candidateContacts.length > 0) {
    const candidateIds = candidateContacts.map((contact) => contact._id)

    const stillReferenced = await Lead.aggregate([
      { $match: { contact: { $in: candidateIds }, isDeleted: false } },
      { $group: { _id: '$contact' } },
    ])

    const keep = new Set(stillReferenced.map((row) => String(row._id)))
    const orphaned = candidateIds.filter((id) => !keep.has(String(id)))

    if (orphaned.length > 0) {
      // `updateMany`, not `bulkWrite`: every one of these gets the identical
      // change, so a single filtered update expresses it exactly.
      await Contact.updateMany({ _id: { $in: orphaned } }, { $set: { isDeleted: true } })
      contactsRemoved = orphaned.length
    }
  }

  const candidateCompanies = await Company.find({ owner, importJob, isDeleted: false }).select('_id')
  let companiesRemoved = 0

  for (const company of candidateCompanies) {
    const [leadsLeft, contactsLeft] = await Promise.all([
      Lead.countDocuments({ company: company._id, isDeleted: false }),
      Contact.countDocuments({ companyId: company._id, isDeleted: false }),
    ])

    if (leadsLeft === 0 && contactsLeft === 0) {
      await Company.updateOne({ _id: company._id }, { $set: { isDeleted: true } })
      companiesRemoved += 1
    } else {
      await company.recount()
    }
  }

  log.info('Import rolled back', {
    importJob: String(importJob),
    leads: leads.deletedCount,
    contactsRemoved,
    companiesRemoved,
  })

  return { leads: leads.deletedCount, contactsRemoved, companiesRemoved }
}

export default { analyseSheet, importSheet, rollbackImport }
