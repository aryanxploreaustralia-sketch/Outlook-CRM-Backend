/**
 * Exports the enquiry register to a workbook.
 *
 * ## Why this reuses `buildLeadFilter`
 *
 * "Export what I am looking at" is the only behaviour anybody expects from an
 * export button, and the only way to guarantee it is for the export and the
 * list to resolve their criteria through the *same* function. A second filter
 * builder would agree with the list on the day it was written and drift the
 * first time a filter was added to one and not the other — and the failure mode
 * is silent: a workbook that quietly omits rows the screen was showing.
 *
 * So the criteria arrive here exactly as the list receives them, go through
 * `buildLeadFilter`, and the only thing this module owns is the column layout.
 *
 * ## Why the writer is the contacts one
 *
 * `toXlsx` already builds a valid single-sheet workbook without a spreadsheet
 * dependency, and the contacts export has shipped on it. It gained optional
 * presentation for this phase — styled header, measured widths, real date
 * cells — all defaulted off, so the contacts export is untouched.
 */

import { Lead } from '../../../models/lead.model.js'
import { toXlsx } from '../../contacts/utils/xlsx.js'
import { AUTO_MAIL_STATUS } from '../constants/syncConstants.js'
import { LEAD_STAGE_LABELS, MARKET_LABELS } from '../constants/leadConstants.js'
import { buildLeadFilter, resolveCompanyScopeForExport } from './lead.service.js'

/**
 * Column order of the exported sheet.
 *
 * Chosen to read like the register the office already keeps: identity first,
 * then the enquiry, then how the automation has treated it, then provenance.
 */
export const EXPORT_COLUMNS = Object.freeze([
  'Reference',
  'Company',
  'Contact Person',
  'Email',
  'Phone',
  'Destination',
  'Quote Date',
  'Travel Date',
  'Pax',
  'City',
  'Source',
  'Handled By',
  'Stage',
  'Mail Status',
  'Mail Sent At',
  'Reply Status',
  'Replies',
  'Last Reply At',
  'Do Not Contact',
  'Created Date',
  'Updated Date',
])

/** Columns written as real Excel dates rather than text. */
const DATE_COLUMNS = Object.freeze([
  'Quote Date',
  'Travel Date',
  'Mail Sent At',
  'Last Reply At',
  'Created Date',
  'Updated Date',
])

/** Hard ceiling on one export, matching the importer's own row limit. */
export const MAX_EXPORT_ROWS = 50_000

/** Human wording for the automatic introduction's state. */
const MAIL_STATUS_LABELS = Object.freeze({
  [AUTO_MAIL_STATUS.PENDING]: 'Not sent',
  [AUTO_MAIL_STATUS.SENT]: 'Sent',
  [AUTO_MAIL_STATUS.FAILED]: 'Failed',
  [AUTO_MAIL_STATUS.SKIPPED]: 'Skipped',
})

/** A Date the writer can format, or null. Guards against invalid stored dates. */
function asDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Flattens one lead into its exported row.
 *
 * Every value comes from a field the register already stores. Nothing is
 * computed, inferred or invented — an export that disagrees with the screen is
 * worse than no export.
 */
function toRow(lead) {
  const travelDate = asDate(lead.travelDate)

  return {
    Reference: lead.reference ?? '',
    Company: lead.companyName ?? '',
    'Contact Person': lead.contactPerson ?? '',
    Email: lead.email ?? '',
    Phone: (lead.phones ?? []).join(', '),
    Destination: MARKET_LABELS[lead.market] ?? lead.market ?? '',
    'Quote Date': asDate(lead.quoteDate),

    /**
     * The parsed date when there is one, the prose when there is not.
     *
     * 24 travel dates in the register are values like "Low Season" or
     * "Oct '19 - Mar '20". They are stored in `travelDateText` precisely
     * because they are not dates, and dropping them from the export would lose
     * the only timing signal those enquiries carry.
     */
    'Travel Date': travelDate ?? lead.travelDateText ?? '',

    Pax: lead.paxText ?? '',
    City: lead.city ?? '',
    Source: lead.sourceSheet ? `Workbook — ${lead.sourceSheet}` : 'Manual entry',
    'Handled By': lead.handledBy ?? '',
    Stage: LEAD_STAGE_LABELS[lead.stage] ?? lead.stage ?? '',

    'Mail Status': MAIL_STATUS_LABELS[lead.autoMail?.status] ?? 'Not sent',
    'Mail Sent At': asDate(lead.autoMail?.sentAt),

    'Reply Status': lead.replyReceived ? 'Replied' : 'Awaiting reply',
    Replies: lead.replyCount ? String(lead.replyCount) : '0',
    'Last Reply At': asDate(lead.lastReplyAt),

    'Do Not Contact': lead.doNotContact ? 'Yes' : '',
    'Created Date': asDate(lead.createdAt),
    'Updated Date': asDate(lead.updatedAt),
  }
}

/**
 * Builds the workbook for a filtered set of leads.
 *
 * @param {object} params
 * @param {any}    params.owner
 * @param {object} params.criteria  The same shape `listLeads` accepts.
 * @returns {Promise<{ buffer: Buffer, filename: string, contentType: string, count: number, truncated: boolean }>}
 */
export async function exportLeadsWorkbook({ owner, criteria = {} }) {
  const filter = buildLeadFilter({ owner, ...criteria })

  // Country and state live on the company, so the list resolves them into a
  // company id set. The export must do the same or those two filters would
  // silently widen the file — which is the exact class of bug this module's
  // reuse of `buildLeadFilter` exists to prevent.
  if (filter._companyScope) {
    const ids = await resolveCompanyScopeForExport(owner, filter._companyScope)
    delete filter._companyScope
    filter.company = filter.company ? filter.company : { $in: ids }
  }

  const leads = await Lead.find(filter)
    .sort({ quoteDate: -1, createdAt: -1 })
    // One more than the ceiling, so the caller can report truncation honestly
    // rather than silently handing over a partial register.
    .limit(MAX_EXPORT_ROWS + 1)
    .lean()

  const truncated = leads.length > MAX_EXPORT_ROWS
  const rows = (truncated ? leads.slice(0, MAX_EXPORT_ROWS) : leads).map(toRow)

  const buffer = toXlsx([...EXPORT_COLUMNS], rows, 'Leads', {
    headerStyle: true,
    autoWidth: true,
    freezeHeader: true,
    dateColumns: [...DATE_COLUMNS],
  })

  const stamp = new Date().toISOString().slice(0, 10)

  return {
    buffer,
    filename: `leads-${stamp}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    count: rows.length,
    truncated,
  }
}

export default { exportLeadsWorkbook, EXPORT_COLUMNS, MAX_EXPORT_ROWS }
