/**
 * Creating one enquiry by hand.
 *
 *     form → validate → resolve company → resolve contact → create → email
 *
 * The same five steps the morning workbook performs for each of its rows, in
 * the same order, through the same services. This module contributes the
 * sequencing and nothing else — there is no second validator, no second company
 * matcher and no second mail path anywhere in it.
 *
 * ## How the importer's validation is reused for a form
 *
 * `validateLeadRow` takes a spreadsheet row and a column mapping, not an
 * object. Rather than write a parallel validator that would drift from it, the
 * form's fields are assembled into a synthetic single-row sheet and handed to
 * that exact function. Everything it knows comes free and stays in step
 * forever: multi-address email cells, the phone parser that survives
 * `91 9100951112 ; 040 39555671 EXT 232`, day-first date reading, the fourteen
 * shapes of `Pax`, the status vocabulary, honorific stripping, and the rule
 * that discards a `Handled By` which is really a date.
 *
 * A form field and a spreadsheet cell are the same thing — a string somebody
 * typed — so this is not a trick; it is the honest observation that both
 * entry points have identical parsing needs.
 *
 * ## What this module is not allowed to do
 *
 * Touch the workbook path. `syncWorkbook` is not imported, not called and not
 * modified. The two entry points meet at `validateLeadRow`, `createResolver`
 * and `sendIntroduction`, which is precisely where they should.
 */

import { Lead } from '../../../models/lead.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { LEAD_FIELD, LEAD_STAGE, MARKET, MARKET_VALUES } from '../constants/leadConstants.js'
import { AUTO_MAIL_STATUS, SKIP_REASON } from '../constants/syncConstants.js'
import { markSkipped, screenForAutoMail, sendIntroduction } from './autoMail.service.js'
import { createResolver } from './companyResolver.service.js'
import { validateLeadRow } from './leadValidation.service.js'
import { nextReference, referenceExists } from './referenceGenerator.service.js'

const log = createContextLogger('manual-lead')

/**
 * Form field → importer field, and the column order of the synthetic row.
 *
 * The importer addresses columns by index, so this array is both the mapping
 * and the row layout. Keeping them as one structure means they cannot fall out
 * of alignment, which is the one way a synthetic row can go quietly wrong.
 */
const FORM_COLUMNS = Object.freeze([
  { form: 'reference', field: LEAD_FIELD.REFERENCE },
  { form: 'companyName', field: LEAD_FIELD.COMPANY_NAME },
  { form: 'contactPerson', field: LEAD_FIELD.CONTACT_PERSON },
  { form: 'email', field: LEAD_FIELD.EMAIL },
  { form: 'phone', field: LEAD_FIELD.PHONE },
  { form: 'quoteDate', field: LEAD_FIELD.QUOTE_DATE },
  { form: 'travelDate', field: LEAD_FIELD.TRAVEL_DATE },
  { form: 'pax', field: LEAD_FIELD.PAX },
  { form: 'city', field: LEAD_FIELD.CITY },
  { form: 'handledBy', field: LEAD_FIELD.HANDLED_BY },
  { form: 'stage', field: LEAD_FIELD.STAGE },
  { form: 'notes', field: LEAD_FIELD.NOTES },
])

/** Builds the one-row sheet and the mapping that describes it. */
function asSyntheticRow(form) {
  return {
    row: FORM_COLUMNS.map(({ form: key }) => String(form[key] ?? '').trim()),
    mapping: FORM_COLUMNS.map(({ field }, index) => ({
      column: field,
      index,
      field,
    })),
  }
}

/**
 * Turns the importer's issue list into an API error the form can render.
 *
 * Only `error` severity blocks. Warnings — an unreadable second phone number,
 * an unrecognised status word — are returned alongside the created lead so the
 * user learns what was adjusted without being stopped by it.
 */
function toValidationError(issues) {
  const errors = issues.filter((issue) => issue.severity === 'error')

  return ApiError.badRequest(
    errors.map((issue) => issue.message).join(' '),
    {
      details: {
        fields: errors.map((issue) => ({ field: issue.field, message: issue.message })),
      },
    },
  )
}

/**
 * Creates one enquiry from the form, and emails it if it qualifies.
 *
 * @param {object}   params
 * @param {any}      params.owner       Workspace user id.
 * @param {any}     [params.createdBy]  Who pressed Create.
 * @param {object}   params.form        Raw form values, all strings.
 * @param {boolean} [params.sendMail]   Master switch for this creation.
 * @param {?object} [params.template]   ACTIVE template, resolved by the caller.
 * @param {?object} [params.provider]   Mail adapter, resolved by the caller.
 * @param {?object} [params.mailbox]    Sending mailbox, resolved by the caller.
 * @param {?string} [params.agentName]  Fills `{{HandledBy}}`.
 * @returns {Promise<{ lead, company, contact, warnings, mail }>}
 */
export async function createLeadManually({
  owner,
  createdBy = null,
  form,
  sendMail = true,
  template = null,
  provider = null,
  mailbox = null,
  agentName = null,
}) {
  // --- 1. Reference --------------------------------------------------------
  //
  // Settled before validation, because `validateLeadRow` treats a missing
  // reference as a fatal row error — correctly, for a spreadsheet, where
  // nothing can invent one.
  const supplied = String(form.reference ?? '').trim().toUpperCase()

  /**
   * The market the reference is allocated under.
   *
   * Taken from the form when given. It is not derived from a supplied
   * reference here because `validateLeadRow` already does exactly that, and
   * doing it twice in two places is how the two answers start disagreeing.
   */
  const requestedMarket = MARKET_VALUES.includes(form.market) ? form.market : MARKET.OTHER

  if (supplied && (await referenceExists({ owner, reference: supplied }))) {
    throw ApiError.conflict(
      `Reference "${supplied}" is already used by another enquiry. ` +
        'Leave the field empty to have the next one allocated automatically.',
      { details: { fields: [{ field: 'reference', message: 'Already in use.' }] } },
    )
  }

  const reference = supplied || (await nextReference({ owner, market: requestedMarket }))

  // --- 2. Validate, through the importer's own validator --------------------
  const { row, mapping } = asSyntheticRow({ ...form, reference })

  const { valid, lead: data, issues } = validateLeadRow({
    row,
    mapping,
    rowNumber: 1,
    // Deliberately blank: with no sheet name, `deriveMarket` falls back to the
    // reference prefix, which is the only signal a manual entry carries.
    sheetName: '',
  })

  if (!valid) throw toValidationError(issues)

  // An explicit choice on the form outranks the prefix inference.
  if (MARKET_VALUES.includes(form.market)) data.market = form.market

  // --- 3. Company and contact, through the import resolver ------------------
  //
  // `importJob: null` is what marks this lead as hand-entered. Every downstream
  // query that means "created by an upload" keys on `firstImportJob`, so a
  // manual lead is correctly invisible to them.
  const resolver = createResolver({ owner, importJob: null, createdBy })

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

  // --- 4. Create ------------------------------------------------------------
  let lead
  try {
    lead = await Lead.create({
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
      stage: data.stage ?? LEAD_STAGE.ACTIVE,
      stageHistory: [
        { to: data.stage ?? LEAD_STAGE.ACTIVE, at: new Date(), by: createdBy, reason: 'Created manually' },
      ],
      handledBy: data.handledBy,
      internalNotes: data.internalNotes,
      // No import job, no sheet, no row — this enquiry came from a person.
      importJob: null,
      firstImportJob: null,
      lastSeenAt: new Date(),
      seenCount: 1,
      sourceSheet: null,
      sourceRow: null,
    })
  } catch (error) {
    // The unique partial index is the real guard against a duplicate
    // reference; the pre-check above only produces a better message when it
    // wins the race.
    if (error?.code === 11_000) {
      throw ApiError.conflict(
        `Reference "${data.reference}" was taken while this form was open. Try again.`,
        { details: { fields: [{ field: 'reference', message: 'Already in use.' }] } },
      )
    }
    throw error
  }

  // Keeps company and contact lead counters honest, exactly as an import does.
  await resolver.finalise()

  log.info('Lead created manually', {
    lead: String(lead._id),
    reference: lead.reference,
    company: company ? String(company._id) : null,
    contact: contact ? String(contact._id) : null,
  })

  // --- 5. The introduction, through the same mail engine --------------------
  const mail = await introduce({
    lead,
    owner,
    sendMail,
    template,
    provider,
    mailbox,
    agentName,
    actor: createdBy,
  })

  return {
    lead,
    company,
    contact,
    // Non-fatal notes from the validator: "ignored an unreadable address",
    // "status not recognised, filed as New".
    warnings: issues.filter((issue) => issue.severity !== 'error'),
    mail,
  }
}

/**
 * Sends the introduction to a freshly created lead.
 *
 * `screenForAutoMail` and `sendIntroduction` are the workbook's own functions,
 * called with `isNew: true` and `forceResend: false` — the same arguments
 * `mailNewLeads` passes. Every duplicate guard therefore applies unchanged:
 * the persisted `autoMail.status === 'sent'` check refuses a second
 * introduction, and nothing here can override it because `forceResend` is not
 * a parameter this path exposes.
 *
 * @returns {{ sent: boolean, reason: ?string, error: ?string }}
 */
async function introduce({ lead, owner, sendMail, template, provider, mailbox, agentName, actor }) {
  if (!sendMail) {
    await markSkipped({ lead, reason: SKIP_REASON.AUTOMATION_OFF })
    return { sent: false, reason: SKIP_REASON.AUTOMATION_OFF, error: null }
  }

  if (!provider || !mailbox) {
    await markSkipped({ lead, reason: SKIP_REASON.NO_MAILBOX })
    return { sent: false, reason: SKIP_REASON.NO_MAILBOX, error: null }
  }

  const screening = screenForAutoMail({
    lead,
    isNew: true,
    forceResend: false,
    automationEnabled: sendMail,
  })

  if (!screening.allowed) {
    await markSkipped({ lead, reason: screening.reason })
    return { sent: false, reason: screening.reason, error: null }
  }

  const result = await sendIntroduction({
    lead,
    provider,
    mailbox,
    owner,
    template,
    agentName,
    forceResend: false,
    actor,
    importJob: null,
  })

  return { sent: result.sent, reason: null, error: result.error }
}

/**
 * Whether a reference is free, for the form's inline check.
 *
 * @returns {Promise<{ reference: string, available: boolean }>}
 */
export async function checkReference({ owner, reference }) {
  const value = String(reference ?? '').trim().toUpperCase()
  return { reference: value, available: value ? !(await referenceExists({ owner, reference: value })) : false }
}

/** The next reference this workspace would allocate, for the form's placeholder. */
export async function peekNextReference({ owner, market = MARKET.OTHER }) {
  return nextReference({ owner, market })
}

export { AUTO_MAIL_STATUS }

export default { createLeadManually, checkReference, peekNextReference }
