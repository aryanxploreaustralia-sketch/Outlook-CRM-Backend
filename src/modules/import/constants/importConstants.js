/**
 * Import engine vocabulary.
 *
 * Part of the API contract — the wizard matches on these strings — so they must
 * not be renamed once published.
 */

export const SPREADSHEET_FORMAT = Object.freeze({
  XLSX: 'xlsx',
  XLS: 'xls',
  XLSB: 'xlsb',
  CSV: 'csv',
  UNKNOWN: 'unknown',
})

/** The six steps of the upload wizard. */
export const IMPORT_STEP = Object.freeze({
  UPLOAD: 'upload',
  PREVIEW: 'preview',
  MAPPING: 'mapping',
  VALIDATION: 'validation',
  DUPLICATES: 'duplicates',
  IMPORT: 'import',
})

export const IMPORT_STEP_ORDER = Object.freeze(Object.values(IMPORT_STEP))

/**
 * Job lifecycle.
 *
 * `PARTIAL` exists because a chunked import of 5,000 rows can succeed for 4,800
 * and fail for 200. Reporting that as `FAILED` would tell the user to discard
 * 4,800 good contacts.
 */
export const IMPORT_STATUS = Object.freeze({
  /** Uploaded and parsed; waiting for the user to finish the wizard. */
  DRAFT: 'draft',
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  ROLLED_BACK: 'rolled_back',
})

export const IMPORT_STATUS_VALUES = Object.freeze(Object.values(IMPORT_STATUS))

export const IMPORT_STATUS_LABELS = Object.freeze({
  [IMPORT_STATUS.DRAFT]: 'Draft',
  [IMPORT_STATUS.QUEUED]: 'Queued',
  [IMPORT_STATUS.RUNNING]: 'Importing',
  [IMPORT_STATUS.PAUSED]: 'Paused',
  [IMPORT_STATUS.COMPLETED]: 'Completed',
  [IMPORT_STATUS.PARTIAL]: 'Partially imported',
  [IMPORT_STATUS.FAILED]: 'Failed',
  [IMPORT_STATUS.CANCELLED]: 'Cancelled',
  [IMPORT_STATUS.ROLLED_BACK]: 'Rolled back',
})

/** How each row was classified during analysis. */
export const ROW_STATUS = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  DUPLICATE_IN_FILE: 'duplicate_in_file',
  DUPLICATE_EXISTING: 'duplicate_existing',
  MISSING_EMAIL: 'missing_email',
  EMPTY: 'empty',
})

export const ROW_STATUS_VALUES = Object.freeze(Object.values(ROW_STATUS))

/** What to do with a row that matches an existing contact. */
export const DUPLICATE_ACTION = Object.freeze({
  /** Leave the existing contact untouched. The safe default. */
  SKIP: 'skip',
  /** Overwrite the existing contact entirely. */
  REPLACE: 'replace',
  /** Fill blank fields on the existing contact without overwriting values. */
  MERGE: 'merge',
  /** Import anyway, accepting a second record. */
  IMPORT_ANYWAY: 'import_anyway',
})

export const DUPLICATE_ACTION_VALUES = Object.freeze(Object.values(DUPLICATE_ACTION))

/**
 * Canonical import fields.
 *
 * The target of column mapping. Deliberately a superset of the Contact model's
 * addressable fields plus the CRM's lead attributes, because a sales sheet
 * carries both.
 */
export const IMPORT_FIELD = Object.freeze({
  FIRST_NAME: 'firstName',
  LAST_NAME: 'lastName',
  DISPLAY_NAME: 'displayName',
  COMPANY: 'company',
  JOB_TITLE: 'jobTitle',
  PRIMARY_EMAIL: 'primaryEmail',
  SECONDARY_EMAIL: 'secondaryEmail',
  PHONE: 'phone',
  MOBILE: 'mobile',
  BUSINESS_PHONE: 'businessPhone',
  WEBSITE: 'website',
  ADDRESS: 'address',
  CITY: 'city',
  STATE: 'state',
  COUNTRY: 'country',
  POSTAL_CODE: 'postalCode',
  NOTES: 'notes',
  TAGS: 'tags',
  CATEGORY: 'category',
  LEAD_SOURCE: 'leadSource',
  LEAD_STATUS: 'leadStatus',
  /** Ignored on import. Chosen explicitly so an unmapped column is deliberate. */
  IGNORE: '__ignore__',
})

export const IMPORT_FIELD_VALUES = Object.freeze(Object.values(IMPORT_FIELD))

/** Human labels for the mapping UI. */
export const IMPORT_FIELD_LABELS = Object.freeze({
  firstName: 'First Name',
  lastName: 'Last Name',
  displayName: 'Full Name',
  company: 'Company',
  jobTitle: 'Job Title',
  primaryEmail: 'Primary Email',
  secondaryEmail: 'Secondary Email',
  phone: 'Phone',
  mobile: 'Mobile',
  businessPhone: 'Business Phone',
  website: 'Website',
  address: 'Address',
  city: 'City',
  state: 'State',
  country: 'Country',
  postalCode: 'Postal Code',
  notes: 'Notes',
  tags: 'Tags',
  category: 'Category',
  leadSource: 'Lead Source',
  leadStatus: 'Lead Status',
  __ignore__: '— Do not import —',
})

/** Fields an import cannot usefully proceed without. */
export const REQUIRED_FIELDS = Object.freeze([IMPORT_FIELD.PRIMARY_EMAIL])

/** Where a lead came from. Free text is also accepted; these drive the filters. */
export const LEAD_SOURCE = Object.freeze({
  IMPORT: 'import',
  WEBSITE: 'website',
  REFERRAL: 'referral',
  TRADE_SHOW: 'trade_show',
  COLD_OUTREACH: 'cold_outreach',
  LINKEDIN: 'linkedin',
  PARTNER: 'partner',
  OTHER: 'other',
})

export const LEAD_SOURCE_VALUES = Object.freeze(Object.values(LEAD_SOURCE))

/** Position in the sales pipeline. */
export const LEAD_STATUS = Object.freeze({
  NEW: 'new',
  CONTACTED: 'contacted',
  ENGAGED: 'engaged',
  QUALIFIED: 'qualified',
  UNQUALIFIED: 'unqualified',
  CUSTOMER: 'customer',
  DO_NOT_CONTACT: 'do_not_contact',
})

export const LEAD_STATUS_VALUES = Object.freeze(Object.values(LEAD_STATUS))

export const LEAD_STATUS_LABELS = Object.freeze({
  new: 'New',
  contacted: 'Contacted',
  engaged: 'Engaged',
  qualified: 'Qualified',
  unqualified: 'Unqualified',
  customer: 'Customer',
  do_not_contact: 'Do not contact',
})

/**
 * Rows written per chunk.
 *
 * 250 is a deliberate middle: large enough that a 10,000-row import is 40 write
 * batches rather than 10,000 round trips, small enough that a failure loses at
 * most 250 rows of progress and the event loop is never blocked long enough to
 * stall other requests.
 */
export const CHUNK_SIZE = 250

/** Ceiling on one upload. Roughly 50,000 rows of typical sales data. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024

/** Ceiling on rows in a single import, to bound memory and job duration. */
export const MAX_ROWS = 50_000

/** Rows kept in the preview response. */
export const PREVIEW_ROWS = 20

export default IMPORT_STATUS
