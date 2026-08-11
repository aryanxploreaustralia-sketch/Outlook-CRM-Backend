/**
 * Travel sales vocabulary.
 *
 * Part of the API contract — the pipeline board, the campaign audience builder
 * and the import mapper all match on these strings — so they must not be
 * renamed once published.
 *
 * These deliberately replace the generic CRM statuses used elsewhere. A travel
 * enquiry does not move `new → contacted → qualified → customer`; it moves
 * through quoting, visa paperwork and a booking. Forcing the real workflow into
 * generic stages is what makes a CRM unusable for the team that has to live in
 * it.
 */

// ---------------------------------------------------------------------------
// Lead pipeline
// ---------------------------------------------------------------------------

/**
 * Stages of a travel enquiry.
 *
 * These are the values the sales workbook records in its `Status` column, and
 * they are the CRM's whole vocabulary. The register is
 * a record of enquiries the office already tracks this way; a longer pipeline
 * invented stages nobody maintained, and forced every imported historical
 * enquiry through a translation that lost the office's own word for it.
 *
 * Stored lower case and displayed through `LEAD_STAGE_LABELS`, which is the
 * convention every other enum in this codebase follows — the stored token is
 * never what the user reads.
 *
 * ## Replacing the previous ten stages
 *
 * `new`, `quoted`, `follow_up`, `interested`, `negotiation`, `visa_process`,
 * `booked`, `completed`, `cancelled` and `lost` are gone. Documents written
 * before this change still hold those strings, so `LEGACY_STAGE_ALIASES` below
 * maps every one of them onto its replacement. Nothing reads a stage without
 * going through that map, and `scripts/migrate-lead-stages.js` rewrites stored
 * documents when you choose to run it.
 */
export const LEAD_STAGE = Object.freeze({
  ACTIVE: 'active',
  CONFIRMED: 'confirmed',
  INACTIVE: 'inactive',
  CLOSED: 'closed',

  /**
   * The agency or contact is no longer trading.
   *
   * Added alongside the original four rather than replacing any of them. It
   * describes the *counterparty*, not the progress of the enquiry, which is why
   * it is not a synonym for `closed`: a closed enquiry reached an outcome, this
   * one cannot reach any.
   *
   * `not_operating` follows the snake_case the stored vocabulary has always
   * used for multi-word values. The workbook writes it as "Not operating".
   */
  NOT_OPERATING: 'not_operating',
})

export const LEAD_STAGE_VALUES = Object.freeze(Object.values(LEAD_STAGE))

export const LEAD_STAGE_LABELS = Object.freeze({
  active: 'Active',
  confirmed: 'Confirmed',
  inactive: 'Inactive',
  closed: 'Closed',
  not_operating: 'Not operating',
})

/**
 * Every stage this application has ever stored, mapped onto the current ones.
 *
 * Two jobs. It lets `normaliseStage` read a document written before the
 * vocabulary changed without that lead disappearing from a filter or crashing a
 * badge, and it is the table `scripts/migrate-lead-stages.js` rewrites with.
 *
 * The mapping preserves what each old stage *meant*, not where it sat in the
 * old ordering: everything before a booking is work in progress (`active`),
 * a chase is `inactive`, a booking is `confirmed`, and every terminal outcome
 * — completed, cancelled or lost — is `closed`. That last collapse is lossy and
 * deliberately so; the workbook has never distinguished them.
 */
export const LEGACY_STAGE_ALIASES = Object.freeze({
  new: LEAD_STAGE.ACTIVE,
  quoted: LEAD_STAGE.ACTIVE,
  interested: LEAD_STAGE.ACTIVE,
  negotiation: LEAD_STAGE.ACTIVE,
  visa_process: LEAD_STAGE.ACTIVE,
  follow_up: LEAD_STAGE.INACTIVE,
  booked: LEAD_STAGE.CONFIRMED,
  completed: LEAD_STAGE.CLOSED,
  cancelled: LEAD_STAGE.CLOSED,
  lost: LEAD_STAGE.CLOSED,
})

/**
 * Resolves any stored or supplied stage to a current one.
 *
 * Returns `null` for a value that is neither current nor legacy, so a caller
 * can tell "unrecognised" from "defaulted" and refuse rather than silently
 * filing an arbitrary string.
 *
 * @param {unknown} value
 * @returns {?string}
 */
export function normaliseStage(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return null
  if (LEAD_STAGE_VALUES.includes(text)) return text
  return LEGACY_STAGE_ALIASES[text] ?? null
}

/**
 * Order for the pipeline board.
 *
 * Held separately from `LEAD_STAGE_VALUES` because the enum's job is validation
 * and this one's job is presentation; conflating them means a new stage cannot
 * be added without silently reordering the board.
 */
export const LEAD_STAGE_ORDER = Object.freeze([
  LEAD_STAGE.ACTIVE,
  LEAD_STAGE.INACTIVE,
  LEAD_STAGE.CONFIRMED,
  LEAD_STAGE.CLOSED,
  LEAD_STAGE.NOT_OPERATING,
])

/**
 * Stages a campaign may target.
 *
 * The exclusions are the point. Emailing a `confirmed` traveller a "still
 * interested?" offer is an embarrassment; emailing a `closed` enquiry is how a
 * sending domain earns spam complaints. This set is enforced in the audience
 * resolver, not merely suggested in the UI, because the UI is not the only way
 * an audience gets built.
 *
 * `inactive` is included, and that is the one entry worth defending: it is
 * where the old `follow_up` stage landed, which was targetable, and a dormant
 * enquiry is precisely the audience a re-engagement campaign exists for. The
 * eligible/blocked split therefore means exactly what it meant before the
 * vocabulary changed — no lead became mailable, and none stopped being so.
 *
 * `not_operating` is deliberately absent, and therefore blocked.
 * `CAMPAIGN_BLOCKED_STAGES` below is derived as "everything not listed here",
 * so a stage added to the vocabulary is un-mailable until somebody decides
 * otherwise. That default is the right way round, and for this stage it is also
 * the right answer: an agency that has stopped trading is the one audience a
 * re-engagement campaign must not reach.
 */
export const CAMPAIGN_ELIGIBLE_STAGES = Object.freeze([
  LEAD_STAGE.ACTIVE,
  LEAD_STAGE.INACTIVE,
])

/** Stages that must never receive campaign mail. */
export const CAMPAIGN_BLOCKED_STAGES = Object.freeze(
  LEAD_STAGE_VALUES.filter((stage) => !CAMPAIGN_ELIGIBLE_STAGES.includes(stage)),
)

/**
 * Stages meaning the enquiry is finished, one way or another.
 *
 * `not_operating` is **not** listed, and that is a decision rather than an
 * oversight. This set feeds the conversion-rate denominator in
 * `leadStatistics`, so adding a stage to it silently revises every historical
 * figure the business has been reading. Whether an enquiry lost because the
 * agency shut down should count against the conversion rate is a commercial
 * question, not a technical one, so the existing calculation is left exactly as
 * it was and the question is left open.
 *
 * The practical effect of the omission is small and safe: a reply arriving on a
 * `not_operating` enquiry does not reopen it either, because
 * `REPLY_STAGE_TRANSITIONS` has no entry for the stage and falls through to no
 * transition.
 */
export const TERMINAL_STAGES = Object.freeze([LEAD_STAGE.CLOSED])

/**
 * Stages counting as commercially won.
 *
 * `confirmed` only. It is the one word in the vocabulary that unambiguously
 * means a booking was taken.
 *
 * `closed` is deliberately excluded, and this is a real loss of reporting
 * precision worth stating plainly: the old `completed` (a finished trip, won)
 * and the old `cancelled`/`lost` (not won) all collapse into it, so a closed
 * enquiry cannot be attributed either way. Counting them all as won would
 * inflate the figure with abandoned enquiries; counting none of them loses the
 * completed trips. The narrower, defensible reading is taken here, and
 * separating the two again needs a fifth word in the workbook rather than a
 * guess in this file.
 */
export const WON_STAGES = Object.freeze([LEAD_STAGE.CONFIRMED])

/**
 * How the workbook's `Status` column maps onto a stage.
 *
 * The first entries are the whole point of the vocabulary: the sheet's
 * words *are* the CRM's stages, so an imported historical enquiry keeps the
 * office's own description of it and nothing is translated or inferred.
 *
 * The rest are the ten stages this application used previously, kept so a
 * workbook exported from an older build — where the `Status` column was written
 * as "Follow Up" or "Booked" — still imports onto the right stage instead of
 * being reported as unrecognised.
 */
export const SHEET_STATUS_TO_STAGE = Object.freeze({
  // The workbook's own vocabulary, one to one.
  active: LEAD_STAGE.ACTIVE,
  inactive: LEAD_STAGE.INACTIVE,
  confirmed: LEAD_STAGE.CONFIRMED,
  closed: LEAD_STAGE.CLOSED,

  /**
   * "Not operating", as the sheet writes it.
   *
   * `parseStage` lower-cases and trims before looking a value up, so this one
   * key already covers "Not Operating", "NOT OPERATING" and stray surrounding
   * whitespace — the same tolerance every other entry here relies on. It does
   * not strip punctuation, so the underscored form is listed separately: that
   * is the value this application itself writes on an export, and a workbook
   * exported from the CRM has to import back into it.
   */
  'not operating': LEAD_STAGE.NOT_OPERATING,
  not_operating: LEAD_STAGE.NOT_OPERATING,

  // Superseded stages, so an older export still imports.
  ...LEGACY_STAGE_ALIASES,
  'follow up': LEAD_STAGE.INACTIVE,
  followup: LEAD_STAGE.INACTIVE,
  visa: LEAD_STAGE.ACTIVE,
  'visa process': LEAD_STAGE.ACTIVE,
})

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

/** A B2B partner's standing. */
export const COMPANY_STATUS = Object.freeze({
  ACTIVE: 'active',
  DORMANT: 'dormant',
  BLOCKED: 'blocked',
})

export const COMPANY_STATUS_VALUES = Object.freeze(Object.values(COMPANY_STATUS))

export const COMPANY_STATUS_LABELS = Object.freeze({
  active: 'Active',
  dormant: 'Dormant',
  blocked: 'Blocked',
})

/**
 * Mail domains that identify a person, not an organisation.
 *
 * 330 of 1,698 rows in the workbook use one. Treating `gmail.com` as a company
 * key would merge several hundred unrelated agencies into a single "Gmail"
 * company, so these force a fall back to the normalised trading name.
 */
export const GENERIC_EMAIL_DOMAINS = Object.freeze(
  new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'yahoo.co.uk',
    'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'icloud.com',
    'me.com', 'aol.com', 'rediffmail.com', 'rediff.com', 'protonmail.com', 'proton.me',
    'zoho.com', 'mail.com', 'ymail.com', 'gmx.com',
  ]),
)

/**
 * Words dropped when normalising a trading name.
 *
 * Only legal-form and industry filler. Deliberately conservative: stripping too
 * much merges distinct firms — measured on the workbook, aggressive stripping
 * collapses five separate Akbar entities into one.
 */
export const COMPANY_NAME_NOISE = Object.freeze([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated', 'corp',
  'corporation', 'co', 'company', 'and', 'the',
])

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

/**
 * Destination markets, derived from the worksheet a row came from.
 *
 * The workbook keeps Australia and New Zealand on separate tabs and encodes the
 * same split in the reference prefix (`XAMP…` versus `XNMP…`/`XNZMP…`).
 */
export const MARKET = Object.freeze({
  AU: 'AU',
  NZ: 'NZ',
  OTHER: 'OTHER',
})

export const MARKET_VALUES = Object.freeze(Object.values(MARKET))

export const MARKET_LABELS = Object.freeze({
  AU: 'Australia',
  NZ: 'New Zealand',
  OTHER: 'Other',
})

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Fields the lead importer can map a column onto. */
export const LEAD_FIELD = Object.freeze({
  REFERENCE: 'reference',
  QUOTE_DATE: 'quoteDate',
  TRAVEL_DATE: 'travelDate',
  CITY: 'city',
  COMPANY_NAME: 'companyName',
  CONTACT_PERSON: 'contactPerson',
  EMAIL: 'email',
  PHONE: 'phone',
  PAX: 'pax',
  HANDLED_BY: 'handledBy',
  STAGE: 'stage',
  NOTES: 'notes',
  IGNORE: '__ignore__',
})

export const LEAD_FIELD_VALUES = Object.freeze(Object.values(LEAD_FIELD))

export const LEAD_FIELD_LABELS = Object.freeze({
  reference: 'Reference (business key)',
  quoteDate: 'Query Date',
  travelDate: 'Travel Date',
  city: 'Departure City',
  companyName: 'Company / Source',
  contactPerson: 'Contact Person',
  email: 'Email Address',
  phone: 'Contact Number',
  pax: 'Pax',
  handledBy: 'Handled By',
  stage: 'Status',
  notes: 'Remark',
  __ignore__: '— Do not import —',
})

/**
 * A lead cannot be created without these.
 *
 * `reference` because it is the deduplication key and a lead without one cannot
 * be re-imported idempotently. `email` because the entire purpose of the CRM is
 * to campaign to these people. `contactPerson` because a campaign addressed to
 * nobody by name is worse than none at all.
 */
export const REQUIRED_LEAD_FIELDS = Object.freeze([
  LEAD_FIELD.REFERENCE,
  LEAD_FIELD.EMAIL,
  LEAD_FIELD.CONTACT_PERSON,
])

/**
 * Header synonyms observed in the real workbook, plus the obvious variants.
 *
 * Keys are normalised headers (lower case, punctuation and spaces removed).
 */
export const LEAD_HEADER_SYNONYMS = Object.freeze({
  // Reference
  reference: LEAD_FIELD.REFERENCE, ref: LEAD_FIELD.REFERENCE,
  refno: LEAD_FIELD.REFERENCE, referenceno: LEAD_FIELD.REFERENCE,
  referencenumber: LEAD_FIELD.REFERENCE, quoteref: LEAD_FIELD.REFERENCE,
  fileno: LEAD_FIELD.REFERENCE, filenumber: LEAD_FIELD.REFERENCE,

  /**
   * Query date — shown to users as "Query Date", stored as `quoteDate`.
   *
   * `querydate` is the header this application now *writes* on an export.
   * Every older spelling is kept, and deliberately: customer spreadsheets in
   * circulation are headed "Q Date", "Quote Date" or "Quotation Date", and
   * dropping any of them would silently map that column to "do not import" —
   * the enquiry dates would vanish from the import with no error raised.
   */
  querydate: LEAD_FIELD.QUOTE_DATE,
  qdate: LEAD_FIELD.QUOTE_DATE, quotedate: LEAD_FIELD.QUOTE_DATE,
  quotationdate: LEAD_FIELD.QUOTE_DATE, enquirydate: LEAD_FIELD.QUOTE_DATE,
  inquirydate: LEAD_FIELD.QUOTE_DATE, date: LEAD_FIELD.QUOTE_DATE,

  // Travel date
  trvldate: LEAD_FIELD.TRAVEL_DATE, traveldate: LEAD_FIELD.TRAVEL_DATE,
  travellingdate: LEAD_FIELD.TRAVEL_DATE, departuredate: LEAD_FIELD.TRAVEL_DATE,
  tourdate: LEAD_FIELD.TRAVEL_DATE, travel: LEAD_FIELD.TRAVEL_DATE,

  // City
  city: LEAD_FIELD.CITY, town: LEAD_FIELD.CITY, location: LEAD_FIELD.CITY,
  departurecity: LEAD_FIELD.CITY,

  // Company
  source: LEAD_FIELD.COMPANY_NAME, company: LEAD_FIELD.COMPANY_NAME,
  companyname: LEAD_FIELD.COMPANY_NAME, agency: LEAD_FIELD.COMPANY_NAME,
  agencyname: LEAD_FIELD.COMPANY_NAME, agent: LEAD_FIELD.COMPANY_NAME,
  organisation: LEAD_FIELD.COMPANY_NAME, organization: LEAD_FIELD.COMPANY_NAME,
  firm: LEAD_FIELD.COMPANY_NAME,

  // Contact person
  contactperson: LEAD_FIELD.CONTACT_PERSON, contactname: LEAD_FIELD.CONTACT_PERSON,
  person: LEAD_FIELD.CONTACT_PERSON, name: LEAD_FIELD.CONTACT_PERSON,
  clientname: LEAD_FIELD.CONTACT_PERSON, passengername: LEAD_FIELD.CONTACT_PERSON,

  // Email
  emailid: LEAD_FIELD.EMAIL, email: LEAD_FIELD.EMAIL,
  emailaddress: LEAD_FIELD.EMAIL, mail: LEAD_FIELD.EMAIL, mailid: LEAD_FIELD.EMAIL,

  // Phone
  contactno: LEAD_FIELD.PHONE, contactnumber: LEAD_FIELD.PHONE,
  phone: LEAD_FIELD.PHONE, phoneno: LEAD_FIELD.PHONE, mobile: LEAD_FIELD.PHONE,
  mobileno: LEAD_FIELD.PHONE, contact: LEAD_FIELD.PHONE, telephone: LEAD_FIELD.PHONE,

  // Pax
  pax: LEAD_FIELD.PAX, paxcount: LEAD_FIELD.PAX, passengers: LEAD_FIELD.PAX,
  noofpax: LEAD_FIELD.PAX, travellers: LEAD_FIELD.PAX, travelers: LEAD_FIELD.PAX,

  // Handled by
  handledby: LEAD_FIELD.HANDLED_BY, handler: LEAD_FIELD.HANDLED_BY,
  salesexecutive: LEAD_FIELD.HANDLED_BY, executive: LEAD_FIELD.HANDLED_BY,
  assignedto: LEAD_FIELD.HANDLED_BY, owner: LEAD_FIELD.HANDLED_BY,

  // Stage
  status: LEAD_FIELD.STAGE, leadstatus: LEAD_FIELD.STAGE, stage: LEAD_FIELD.STAGE,
  pipeline: LEAD_FIELD.STAGE,

  // Notes
  remark: LEAD_FIELD.NOTES, remarks: LEAD_FIELD.NOTES, notes: LEAD_FIELD.NOTES,
  note: LEAD_FIELD.NOTES, comment: LEAD_FIELD.NOTES, comments: LEAD_FIELD.NOTES,
})

/**
 * Headers that positively identify a sheet as hotel operations rather than
 * sales.
 *
 * The workbook's "Hotels Block" and "December" tabs carry no person and no
 * email; importing them would create leads for hotel room blocks. Recognising
 * them by their own vocabulary is more honest than inferring from what they
 * lack.
 */
export const OPERATIONS_HEADER_MARKERS = Object.freeze([
  'hotelname', 'checkin', 'checkout', 'confirmationnumber', 'releasedbooked',
  'timelimit', 'cancellationnumber', 'paxname', 'roomtype', 'nights',
])

/** How a worksheet was classified. */
export const SHEET_KIND = Object.freeze({
  LEADS: 'leads',
  OPERATIONS: 'operations',
  UNKNOWN: 'unknown',
  EMPTY: 'empty',
})

export const SHEET_KIND_VALUES = Object.freeze(Object.values(SHEET_KIND))

/** Outcome of one imported row. */
export const ROW_OUTCOME = Object.freeze({
  CREATED: 'created',
  UPDATED: 'updated',
  DUPLICATE: 'duplicate',
  INVALID: 'invalid',
  SKIPPED: 'skipped',
  FAILED: 'failed',
})

export const ROW_OUTCOME_VALUES = Object.freeze(Object.values(ROW_OUTCOME))

/** Rows written per chunk. Matches the Phase 6 import engine. */
export const LEAD_CHUNK_SIZE = 250

export default LEAD_STAGE
