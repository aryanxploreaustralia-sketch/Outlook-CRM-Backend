/**
 * The morning workbook run.
 *
 *     upload → compare → create the new ones → email only those → report
 *
 * Everything the product exists for. The team uploads today's export; the
 * engine works out which enquiries it has never seen, creates them, and writes
 * to exactly those customers. Nobody has to remember who was emailed yesterday.
 *
 * ## Built on Phase 8, not instead of it
 *
 * `validateLeadRow` and `createResolver` are the same pieces the Phase 8
 * importer uses, so a row parses identically whichever path it takes. That
 * importer is untouched and its endpoint still behaves exactly as before —
 * this is a second, smarter entry point beside it.
 *
 * ## Resume
 *
 * The job records a cursor after every chunk. A run interrupted at row 4,000
 * resumes at 4,000 rather than starting over, and re-running a completed chunk
 * would in any case create nothing and send nothing, because the categoriser
 * would now class those rows as `unchanged`.
 */

import { ImportJob } from '../../../models/importJob.model.js'
import { Lead } from '../../../models/lead.model.js'
import { createContextLogger } from '../../../utils/logger.js'
import { IMPORT_STATUS, IMPORT_STEP } from '../../import/constants/importConstants.js'
import { createResolver } from './companyResolver.service.js'
import { compareWorkbook } from './workbookCompare.service.js'
import { markSkipped, screenForAutoMail, sendIntroduction, DEFAULT_TEMPLATE } from './autoMail.service.js'
import {
  AUTO_MAIL_INTERVAL_MS,
  AUTO_MAIL_STATUS,
  MAX_AUTO_MAILS_PER_RUN,
  ROW_CATEGORY,
  SKIP_REASON,
  SYNC_CHUNK_SIZE,
} from '../constants/syncConstants.js'

const log = createContextLogger('workbook-sync')

/** Fields a workbook may write onto an existing lead. */
const WRITABLE_FIELDS = [
  'contactPerson', 'companyName', 'email', 'phones',
  'quoteDate', 'travelDate', 'travelDateText',
  'city', 'paxText', 'adultCount', 'childCount',
  'handledBy', 'internalNotes', 'market',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs one workbook against the database.
 *
 * @param {object} params
 * @param {boolean} [params.dryRun] Compare and report; write nothing, send nothing.
 * @param {boolean} [params.sendMail] Master switch for the run. Default on.
 * @param {boolean} [params.forceResend] Re-send to leads already emailed. Default OFF.
 * @returns {Promise<object>} The import summary.
 */
export async function syncWorkbook({
  rows,
  mapping,
  sheetName,
  headerRowNumber = 1,
  owner,
  createdBy = null,
  importJob = null,
  provider = null,
  mailbox = null,
  template = DEFAULT_TEMPLATE,
  agentName = null,
  dryRun = false,
  sendMail = true,
  forceResend = false,
  onProgress = null,
}) {
  const startedAt = Date.now()

  // --- 1. Compare ----------------------------------------------------------
  const comparison = await compareWorkbook({ rows, mapping, sheetName, headerRowNumber, owner })

  const summary = {
    sheetName,
    total: comparison.counts.total,
    new: comparison.counts.new,
    updated: comparison.counts.updated,
    unchanged: comparison.counts.unchanged,
    invalid: comparison.counts.invalid,
    created: 0,
    modified: 0,
    emailsSent: 0,
    emailsSkipped: 0,
    emailsFailed: 0,
    failed: 0,
    skipReasons: {},
    durationMs: 0,
  }

  if (dryRun) {
    summary.durationMs = Date.now() - startedAt

    return {
      ...summary,
      dryRun: true,
      mailable: sendMail ? comparison.mailable : 0,
      rows: comparison.rows.slice(0, 200),
      issues: comparison.issues,
      issuesTruncated: comparison.issuesTruncated,
    }
  }

  // --- 2. Apply ------------------------------------------------------------
  const resolver = createResolver({ owner, importJob, createdBy })

  /**
   * Only rows that need work.
   *
   * `unchanged` and `invalid` are skipped: an unchanged row has nothing to
   * write, and re-saving it would churn `updatedAt` on thousands of documents
   * every morning for no reason.
   *
   * A predicate rather than a filtered array, deliberately — see the note on
   * the loop below.
   */
  const isActionable = (entry) =>
    entry.category === ROW_CATEGORY.NEW || entry.category === ROW_CATEGORY.UPDATED

  summary.failed = 0
  const issues = [...comparison.issues]

  // Resume point: rows before the cursor were applied by an earlier attempt.
  const resumeFrom = importJob ? ((await ImportJob.findById(importJob))?.cursor ?? 0) : 0

  if (resumeFrom > 0) {
    log.info('Resuming a workbook sync', { importJob: String(importJob), from: resumeFrom })
  }

  const newLeads = []

  /**
   * The loop walks *every* row the sheet carried, not just the actionable ones.
   *
   * ## Why, and what went wrong before
   *
   * `cursor` is an index, and an index only means anything against a list that
   * is identical on every attempt. This used to index a list filtered to the
   * rows needing work — and that list is derived from the comparison, which is
   * derived from the database, which the previous attempt just changed.
   *
   * So a run of 1,700 new enquiries interrupted after 1,200 recorded
   * `cursor: 1200`. On resume those 1,200 leads existed, the comparison
   * therefore categorised them `unchanged`, and the actionable list had shrunk
   * to the 500 still missing. The loop became `for (start = 1200; start < 500)`
   * and never executed: the remaining 500 enquiries were silently never
   * created and never emailed, while the summary cheerfully reported
   * "500 new". They only appeared the next morning, a day late.
   *
   * `comparison.rows` is every non-blank row of the file, in sheet order. Its
   * length and order depend on the *file* and nothing else, so the same file
   * always yields the same list however many times the import is attempted and
   * whatever the database now holds. That is the property an index needs, and
   * it is also what `cursor` was always documented to mean: "rows processed".
   *
   * ## Why this is safe for a job interrupted before this change shipped
   *
   * An old cursor counted actionable rows, which is never more than the number
   * of sheet rows — so re-read as a sheet position it can only point *earlier*
   * than the true one. A resume re-walks rows that were already applied, finds
   * them `unchanged`, and skips them. The worst case is a little wasted
   * comparison, never a duplicate lead and never a duplicate email.
   */
  for (let start = resumeFrom; start < comparison.rows.length; start += SYNC_CHUNK_SIZE) {
    const chunk = comparison.rows.slice(start, start + SYNC_CHUNK_SIZE)

    for (const entry of chunk) {
      // Unchanged and invalid rows advance the cursor without being written.
      if (!isActionable(entry)) continue

      try {
        const data = entry.data

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

        if (entry.category === ROW_CATEGORY.NEW) {
          const lead = await Lead.create({
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
            stageHistory: [
              { to: data.stage, at: new Date(), by: createdBy, reason: 'Created from the daily workbook' },
            ],
            handledBy: data.handledBy,
            internalNotes: data.internalNotes,
            importJob,
            firstImportJob: importJob,
            lastSeenAt: new Date(),
            seenCount: 1,
            sourceSheet: sheetName,
            sourceRow: entry.rowNumber,
          })

          summary.created += 1
          newLeads.push(lead)
        } else {
          const lead = await Lead.findOne({ owner, reference: data.reference, isDeleted: false })
          if (!lead) continue

          for (const field of WRITABLE_FIELDS) {
            // A blank cell never erases a stored value — the same rule the
            // comparison used, applied to the write.
            const incoming = data[field]
            const isBlank =
              incoming === null || incoming === undefined ||
              (typeof incoming === 'string' && incoming.trim() === '') ||
              (Array.isArray(incoming) && incoming.length === 0)

            if (!isBlank) lead[field] = incoming
          }

          // The diff computed during comparison becomes the change history.
          for (const change of entry.changes) {
            lead.fieldHistory.push({
              field: change.field,
              from: change.from,
              to: change.to,
              at: new Date(),
              importJob,
            })
          }

          lead.company = company?._id ?? lead.company
          lead.contact = contact?._id ?? lead.contact
          lead.importJob = importJob ?? lead.importJob
          lead.lastSeenAt = new Date()
          lead.seenCount = (lead.seenCount ?? 1) + 1
          lead.sourceSheet = sheetName
          lead.sourceRow = entry.rowNumber

          await lead.save()
          summary.modified += 1
        }
      } catch (error) {
        summary.failed += 1
        issues.push({
          row: entry.rowNumber,
          field: null,
          severity: 'error',
          message: error?.message ?? 'The row could not be applied.',
        })
        log.warn('Workbook row failed', { row: entry.rowNumber, error: error?.message })
      }
    }

    if (importJob) {
      await ImportJob.updateOne(
        { _id: importJob },
        {
          $set: {
            // A sheet position, matching what the loop indexes.
            cursor: Math.min(start + SYNC_CHUNK_SIZE, comparison.rows.length),
            'progress.imported': summary.created,
            'progress.updated': summary.modified,
            'progress.skipped': summary.unchanged,
            'progress.failed': summary.failed + summary.invalid,
          },
        },
      )
    }

    if (onProgress) {
      await onProgress({
        // Rows of the sheet, which is also what the queue records as
        // `background.totalRows` — so the two now agree.
        processed: Math.min(start + SYNC_CHUNK_SIZE, comparison.rows.length),
        total: comparison.rows.length,
        ...summary,
      })
    }
  }

  // Mark unchanged leads as seen, so "when did this last appear" stays true
  // without rewriting the documents themselves.
  const unchangedReferences = comparison.rows
    .filter((entry) => entry.category === ROW_CATEGORY.UNCHANGED)
    .map((entry) => entry.reference)

  for (let start = 0; start < unchangedReferences.length; start += 1000) {
    await Lead.updateMany(
      { owner, reference: { $in: unchangedReferences.slice(start, start + 1000) }, isDeleted: false },
      { $set: { lastSeenAt: new Date() }, $inc: { seenCount: 1 } },
    )
  }

  await resolver.finalise()

  /**
   * Enquiries this job created but has not yet written to.
   *
   * ## Why the in-memory list is not enough
   *
   * `newLeads` holds only what *this attempt* created. A run interrupted
   * between creating leads and mailing them therefore left every earlier lead
   * unmailed for ever: the resume created the remainder, mailed only those, and
   * the leads from the first attempt stayed `pending`. Nothing swept them up,
   * so unlike a missing row — which the next morning's workbook would create —
   * these already existed, read as `unchanged` the next day, and were never
   * emailed at all.
   *
   * ## Why this query is the right one
   *
   * `firstImportJob` is written once, at creation, and never touched by the
   * update path — so it identifies exactly the enquiries *this* job brought
   * into existence, and can never pick up a lead that was merely modified
   * today. Combined with `autoMail.status: pending` it is precisely "created
   * here, still owed an introduction".
   *
   * It runs on every attempt, not just resumes: on a first run it returns the
   * leads just created, which are already in `newLeads` and are de-duplicated
   * below, so the common path is unchanged. One indexed query is a small price
   * for not having a branch that only executes after a crash — the branch least
   * likely to be exercised and most likely to rot.
   *
   * Sending remains impossible to duplicate: `screenForAutoMail` refuses any
   * lead whose `autoMail.status` is already `sent`, which is the guarantee that
   * has protected this since Phase 10 and is untouched here.
   */
  if (importJob) {
    const seen = new Set(newLeads.map((lead) => String(lead._id)))

    const stillOwed = await Lead.find({
      owner,
      firstImportJob: importJob,
      isDeleted: false,
      'autoMail.status': AUTO_MAIL_STATUS.PENDING,
    })

    let recovered = 0
    for (const lead of stillOwed) {
      if (seen.has(String(lead._id))) continue
      newLeads.push(lead)
      recovered += 1
    }

    // Zero on a first run; only an interrupted attempt leaves anything behind.
    if (recovered > 0) {
      log.info('Recovered enquiries left unmailed by an interrupted attempt', {
        importJob: String(importJob),
        recovered,
      })
    }
  }

  // --- 3. Mail the new leads, and only them --------------------------------
  const mailOutcome = await mailNewLeads({
    owner,
    leads: newLeads,
    provider,
    mailbox,
    template,
    agentName,
    sendMail,
    forceResend,
    actor: createdBy,
    importJob,
    onProgress,
  })

  summary.emailsSent = mailOutcome.sent
  summary.emailsSkipped = mailOutcome.skipped
  summary.emailsFailed = mailOutcome.failed
  summary.skipReasons = mailOutcome.reasons
  summary.durationMs = Date.now() - startedAt

  log.info('Workbook sync complete', {
    sheetName,
    total: summary.total,
    new: summary.new,
    updated: summary.updated,
    unchanged: summary.unchanged,
    invalid: summary.invalid,
    emailsSent: summary.emailsSent,
    durationMs: summary.durationMs,
  })

  return {
    ...summary,
    dryRun: false,
    rows: comparison.rows.slice(0, 200),
    issues: issues.slice(0, 500),
    issuesTruncated: issues.length > 500,
  }
}

/**
 * Sends the introduction to newly created leads.
 *
 * Paced rather than parallel. Exchange Online throttles around 30 messages a
 * minute, and a morning workbook with 120 new leads would trip that in seconds
 * — the resulting backoff takes longer than the pacing it avoided.
 */
async function mailNewLeads({
  owner,
  leads,
  provider,
  mailbox,
  template,
  agentName,
  sendMail,
  forceResend,
  actor,
  importJob,
  onProgress,
}) {
  const outcome = { sent: 0, skipped: 0, failed: 0, reasons: {} }

  const note = (reason) => {
    outcome.skipped += 1
    outcome.reasons[reason] = (outcome.reasons[reason] ?? 0) + 1
  }

  if (!sendMail) {
    for (const lead of leads) {
      note(SKIP_REASON.AUTOMATION_OFF)
      await markSkipped({ lead, reason: SKIP_REASON.AUTOMATION_OFF })
    }
    return outcome
  }

  if (!provider || !mailbox) {
    for (const lead of leads) {
      note(SKIP_REASON.NO_MAILBOX)
      await markSkipped({ lead, reason: SKIP_REASON.NO_MAILBOX })
    }
    return outcome
  }

  let sentThisRun = 0

  for (const [index, lead] of leads.entries()) {
    const screening = screenForAutoMail({ lead, isNew: true, forceResend, automationEnabled: sendMail })

    if (!screening.allowed) {
      note(screening.reason)
      await markSkipped({ lead, reason: screening.reason })
      continue
    }

    /**
     * A hard ceiling per run.
     *
     * A workbook that unexpectedly categorises thousands of rows as new — a
     * changed reference format, say — would otherwise mail the entire customer
     * base before anyone could stop it. The remainder stay `pending` and go out
     * on the next run once the cause has been looked at.
     */
    if (sentThisRun >= MAX_AUTO_MAILS_PER_RUN) {
      note('run_limit')
      continue
    }

    const result = await sendIntroduction({
      lead,
      provider,
      mailbox,
      owner,
      template,
      agentName,
      forceResend,
      actor,
      importJob,
    })

    if (result.sent) {
      outcome.sent += 1
      sentThisRun += 1
    } else {
      outcome.failed += 1
    }

    if (onProgress && index % 10 === 0) {
      await onProgress({ mailing: true, sent: outcome.sent, total: leads.length })
    }

    // Paced, but never after the last one.
    if (index < leads.length - 1) await sleep(AUTO_MAIL_INTERVAL_MS)
  }

  return outcome
}

/**
 * Re-sends the introduction to specific leads.
 *
 * The deliberate override. Separate from the sync so a resend is always an
 * explicit act against named leads, never a side effect of uploading a file.
 */
export async function resendIntroductions({
  owner,
  leadIds,
  provider,
  mailbox,
  template = DEFAULT_TEMPLATE,
  agentName = null,
  actor = null,
}) {
  const leads = await Lead.find({ _id: { $in: leadIds }, owner, isDeleted: false })
  const outcome = { requested: leadIds.length, sent: 0, skipped: 0, failed: 0, reasons: {} }

  for (const [index, lead] of leads.entries()) {
    const screening = screenForAutoMail({ lead, isNew: false, forceResend: true })

    if (!screening.allowed) {
      outcome.skipped += 1
      outcome.reasons[screening.reason] = (outcome.reasons[screening.reason] ?? 0) + 1
      continue
    }

    const result = await sendIntroduction({
      lead, provider, mailbox, owner, template, agentName,
      forceResend: true, actor,
    })

    if (result.sent) outcome.sent += 1
    else outcome.failed += 1

    if (index < leads.length - 1) await sleep(AUTO_MAIL_INTERVAL_MS)
  }

  return outcome
}

/** Leads that still owe an introduction — the "pending emails" widget. */
export async function pendingIntroductions({ owner }) {
  return Lead.countDocuments({
    owner,
    isDeleted: false,
    doNotContact: false,
    email: { $nin: [null, ''] },
    'autoMail.status': { $in: [AUTO_MAIL_STATUS.PENDING, AUTO_MAIL_STATUS.FAILED] },
  })
}

/** Marks a job finished, with the counters the history list reads. */
export async function completeJob({ importJob, summary, status = null }) {
  if (!importJob) return null

  const job = await ImportJob.findById(importJob)
  if (!job) return null

  job.status =
    status ??
    (summary.failed > 0 || summary.invalid > 0 ? IMPORT_STATUS.PARTIAL : IMPORT_STATUS.COMPLETED)
  job.step = IMPORT_STEP.IMPORT
  job.finishedAt = new Date()
  job.durationMs = summary.durationMs
  job.syncSummary = {
    total: summary.total,
    new: summary.new,
    updated: summary.updated,
    unchanged: summary.unchanged,
    invalid: summary.invalid,
    created: summary.created,
    modified: summary.modified,
    emailsSent: summary.emailsSent,
    emailsSkipped: summary.emailsSkipped,
    emailsFailed: summary.emailsFailed,
  }
  job.progress = {
    imported: summary.created,
    updated: summary.modified,
    skipped: summary.unchanged,
    failed: summary.failed + summary.invalid,
  }

  await job.save()
  return job
}

export default { syncWorkbook, resendIntroductions, pendingIntroductions, completeJob }
