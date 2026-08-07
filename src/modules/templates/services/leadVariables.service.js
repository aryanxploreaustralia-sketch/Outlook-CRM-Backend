/**
 * Turns a lead into the values a template renders against.
 *
 * ## Why this is separate from the campaign personaliser
 *
 * Phase 7's `personalisation.service` resolves variables for a *contact* — a
 * person in the address book — and gives them friendly fallbacks: an unknown
 * first name becomes "there", an unknown company becomes "your company". That is
 * right for a marketing campaign.
 *
 * A lead is a different subject: it is one quotation enquiry, keyed by
 * reference, and the specification for this engine is explicit that a variable
 * with no value becomes an empty string. So this module produces the values and
 * hands them to the same renderer, rather than reimplementing substitution or
 * changing how campaigns behave.
 *
 * ## The one exception, stated plainly
 *
 * `ContactPerson` falls back to the company name. Everything else resolves from
 * exactly one place and is blank when that place is blank. The exception exists
 * because the greeting is the first line of every message: an enquiry that
 * arrived with a company but no named person would otherwise open "Dear ,",
 * which reads as a mail-merge failure to the customer and costs the reply the
 * whole message is asking for. The company name is real data from the same
 * enquiry, not an invented pleasantry, which is why this is acceptable where a
 * generic "there" would not be.
 */

import { LEAD_VARIABLE_NAMES, LEAD_VARIABLES } from '../constants/templateConstants.js'

/** `15 October 2026` — long form, unambiguous between British and US readers. */
const LONG_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

const formatDate = (value) => {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : LONG_DATE.format(date)
}

/** Trims and coerces, so `null`, `undefined` and `'  '` all become `''`. */
const text = (value) => String(value ?? '').trim()

/**
 * Resolves every supported variable for one lead.
 *
 * @param {object} params
 * @param {object} params.lead      A Lead document or plain object.
 * @param {Date}   [params.now]     Injectable, so a preview and the send it
 *                                  previews can agree on `{{CurrentDate}}`.
 * @returns {Record<string, string>} Every supported name, always present.
 */
export function resolveLeadVariables({ lead, now = new Date() }) {
  const contactPerson = text(lead?.contactPerson)
  const company = text(lead?.companyName)

  /**
   * The workbook's own wording is preferred over the parsed date.
   *
   * A sheet saying "Oct/Nov" or "flexible" carries information the parsed
   * `travelDate` has already thrown away, and repeating the customer's own
   * words back to them is more accurate than a date we inferred.
   */
  const travelDate = text(lead?.travelDateText) || formatDate(lead?.travelDate)

  return {
    ContactPerson: contactPerson || company,
    Company: company,
    Reference: text(lead?.reference),
    Destination: text(lead?.city) || text(lead?.market),
    TravelDate: travelDate,
    HandledBy: text(lead?.handledBy),
    Email: text(lead?.email),
    Phone: text(Array.isArray(lead?.phones) ? lead.phones[0] : lead?.phones),
    Pax: text(lead?.paxText),
    CurrentDate: formatDate(now),
    CurrentYear: String(now.getUTCFullYear()),
  }
}

/**
 * A lead-shaped object for previews and test sends.
 *
 * Deliberately not written to the database and never given an `_id`: a test
 * email must not create, touch or resemble a real enquiry.
 */
export function sampleLead() {
  return {
    reference: 'XAMP001',
    contactPerson: 'Priya Sharma',
    companyName: 'Horizon Travel',
    email: 'priya@horizontravel.example',
    phones: ['+91 98765 43210'],
    city: 'Sydney',
    market: 'australia',
    travelDateText: '15 Oct 2026',
    travelDate: new Date(Date.UTC(2026, 9, 15)),
    paxText: '2 Adults',
    handledBy: 'MP',
  }
}

/**
 * Reports variables a template uses that this engine cannot resolve.
 *
 * Used by validation so a typo is caught while someone is writing the template,
 * not discovered as a blank space in a message already sent to a customer.
 *
 * @param {string[]} used Names extracted from a subject and body.
 * @returns {string[]} Unknown names, in the order encountered.
 */
export function unknownVariables(used) {
  const known = new Set(LEAD_VARIABLE_NAMES)
  return used.filter((name) => !known.has(name))
}

/** The picker's catalogue, with a worked example for each entry. */
export function variableCatalogue() {
  return LEAD_VARIABLES.map((entry) => ({ ...entry, token: `{{${entry.name}}}` }))
}

export default { resolveLeadVariables, sampleLead, unknownVariables, variableCatalogue }
