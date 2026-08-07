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

/** Stages of a travel enquiry, in pipeline order. */
export const LEAD_STAGE = Object.freeze({
  NEW: 'new',
  QUOTED: 'quoted',
  FOLLOW_UP: 'follow_up',
  INTERESTED: 'interested',
  NEGOTIATION: 'negotiation',
  VISA_PROCESS: 'visa_process',
  BOOKED: 'booked',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  LOST: 'lost',
})

export const LEAD_STAGE_VALUES = Object.freeze(Object.values(LEAD_STAGE))

export const LEAD_STAGE_LABELS = Object.freeze({
  new: 'New',
  quoted: 'Quoted',
  follow_up: 'Follow Up',
  interested: 'Interested',
  negotiation: 'Negotiation',
  visa_process: 'Visa Process',
  booked: 'Booked',
  completed: 'Completed',
  cancelled: 'Cancelled',
  lost: 'Lost',
})

/**
 * Order for the pipeline board.
 *
 * Held separately from `LEAD_STAGE_VALUES` because the enum's job is validation
 * and this one's job is presentation; conflating them means a new stage cannot
 * be added without silently reordering the board.
 */
export const LEAD_STAGE_ORDER = Object.freeze([
  LEAD_STAGE.NEW,
  LEAD_STAGE.QUOTED,
  LEAD_STAGE.FOLLOW_UP,
  LEAD_STAGE.INTERESTED,
  LEAD_STAGE.NEGOTIATION,
  LEAD_STAGE.VISA_PROCESS,
  LEAD_STAGE.BOOKED,
  LEAD_STAGE.COMPLETED,
  LEAD_STAGE.CANCELLED,
  LEAD_STAGE.LOST,
])

/**
 * Stages a campaign may target.
 *
 * The exclusions are the point. Emailing a `booked` traveller a "still
 * interested?" offer is an embarrassment; emailing a `lost` or `cancelled` lead
 * is how a sending domain earns spam complaints. This set is enforced in the
 * audience resolver, not merely suggested in the UI, because the UI is not the
 * only way an audience gets built.
 */
export const CAMPAIGN_ELIGIBLE_STAGES = Object.freeze([
  LEAD_STAGE.NEW,
  LEAD_STAGE.QUOTED,
  LEAD_STAGE.FOLLOW_UP,
  LEAD_STAGE.INTERESTED,
  LEAD_STAGE.NEGOTIATION,
])

/** Stages that must never receive campaign mail. */
export const CAMPAIGN_BLOCKED_STAGES = Object.freeze(
  LEAD_STAGE_VALUES.filter((stage) => !CAMPAIGN_ELIGIBLE_STAGES.includes(stage)),
)

/** Stages meaning the enquiry is finished, one way or another. */
export const TERMINAL_STAGES = Object.freeze([
  LEAD_STAGE.COMPLETED,
  LEAD_STAGE.CANCELLED,
  LEAD_STAGE.LOST,
])

/** Stages counting as commercially won. */
export const WON_STAGES = Object.freeze([LEAD_STAGE.BOOKED, LEAD_STAGE.COMPLETED])

/**
 * How the workbook's `Status` column maps onto the pipeline.
 *
 * The sheet carries only five values across 1,698 rows — `Active`, `Inactive`,
 * `Closed`, `closed`, `Confirmed` — because it was never a pipeline, just a
 * flag. The mapping is therefore lossy in one direction only: it never invents
 * a stage the sheet cannot justify.
 *
 * `Active` becomes `new` rather than a later stage: the sheet does not record
 * whether a quote was sent, and guessing `quoted` would show revenue movement
 * that never happened.
 */
export const SHEET_STATUS_TO_STAGE = Object.freeze({
  active: LEAD_STAGE.NEW,
  inactive: LEAD_STAGE.FOLLOW_UP,
  confirmed: LEAD_STAGE.BOOKED,
  closed: LEAD_STAGE.COMPLETED,
  cancelled: LEAD_STAGE.CANCELLED,
  lost: LEAD_STAGE.LOST,
  // Values the team may start typing once the CRM is live.
  quoted: LEAD_STAGE.QUOTED,
  'follow up': LEAD_STAGE.FOLLOW_UP,
  followup: LEAD_STAGE.FOLLOW_UP,
  interested: LEAD_STAGE.INTERESTED,
  negotiation: LEAD_STAGE.NEGOTIATION,
  visa: LEAD_STAGE.VISA_PROCESS,
  'visa process': LEAD_STAGE.VISA_PROCESS,
  booked: LEAD_STAGE.BOOKED,
  completed: LEAD_STAGE.COMPLETED,
  new: LEAD_STAGE.NEW,
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
  quoteDate: 'Quotation Date',
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

  // Quotation date
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
