/**
 * Automatic column detection.
 *
 * A sales team's spreadsheet names its columns whatever the person who made it
 * felt like: "Contact Person", "Email ID", "Contact Number", "Remark". Making
 * them map twenty columns by hand for every file is the difference between an
 * importer people use and one they avoid.
 *
 * ## Two signals, combined
 *
 * **The header** carries most of the meaning, matched in four passes from exact
 * to fuzzy so a confident match is never beaten by a loose one.
 *
 * **The data** is the tie-breaker, and sometimes the only signal at all. A
 * column of values that all contain `@` is an email column whatever its header
 * says — and a column headed "Contact" holding phone numbers is a phone column,
 * which no amount of header analysis would reveal.
 *
 * Every suggestion carries a confidence and the reason it was made, so the
 * mapping screen can show *why* and the user can disagree cheaply.
 */

import { IMPORT_FIELD } from '../constants/importConstants.js'

/**
 * Exact header spellings, normalised to lower case with punctuation stripped.
 *
 * Drawn from what real exports actually produce — Outlook, Google Contacts,
 * LinkedIn Sales Navigator, Apollo, ZoomInfo and hand-made sheets.
 */
const EXACT_ALIASES = Object.freeze({
  // --- Names -------------------------------------------------------------
  'first name': IMPORT_FIELD.FIRST_NAME,
  firstname: IMPORT_FIELD.FIRST_NAME,
  fname: IMPORT_FIELD.FIRST_NAME,
  'given name': IMPORT_FIELD.FIRST_NAME,
  forename: IMPORT_FIELD.FIRST_NAME,
  // These hold a FULL name in practice, not a first name. Mapping them to
  // displayName lets validateRow split them, which is what {{FirstName}}
  // personalisation needs — "Dear Priya Raman" reads like a broken mail merge.
  'contact person': IMPORT_FIELD.DISPLAY_NAME,
  'contact name': IMPORT_FIELD.DISPLAY_NAME,
  'person name': IMPORT_FIELD.DISPLAY_NAME,
  'client name': IMPORT_FIELD.DISPLAY_NAME,

  'last name': IMPORT_FIELD.LAST_NAME,
  lastname: IMPORT_FIELD.LAST_NAME,
  lname: IMPORT_FIELD.LAST_NAME,
  surname: IMPORT_FIELD.LAST_NAME,
  'family name': IMPORT_FIELD.LAST_NAME,

  name: IMPORT_FIELD.DISPLAY_NAME,
  'full name': IMPORT_FIELD.DISPLAY_NAME,
  fullname: IMPORT_FIELD.DISPLAY_NAME,
  'display name': IMPORT_FIELD.DISPLAY_NAME,
  'lead name': IMPORT_FIELD.DISPLAY_NAME,

  // --- Company -----------------------------------------------------------
  company: IMPORT_FIELD.COMPANY,
  'company name': IMPORT_FIELD.COMPANY,
  organisation: IMPORT_FIELD.COMPANY,
  organization: IMPORT_FIELD.COMPANY,
  org: IMPORT_FIELD.COMPANY,
  employer: IMPORT_FIELD.COMPANY,
  business: IMPORT_FIELD.COMPANY,
  'business name': IMPORT_FIELD.COMPANY,
  firm: IMPORT_FIELD.COMPANY,
  account: IMPORT_FIELD.COMPANY,
  'account name': IMPORT_FIELD.COMPANY,

  'job title': IMPORT_FIELD.JOB_TITLE,
  title: IMPORT_FIELD.JOB_TITLE,
  designation: IMPORT_FIELD.JOB_TITLE,
  position: IMPORT_FIELD.JOB_TITLE,
  role: IMPORT_FIELD.JOB_TITLE,

  // --- Email -------------------------------------------------------------
  email: IMPORT_FIELD.PRIMARY_EMAIL,
  'email id': IMPORT_FIELD.PRIMARY_EMAIL,
  emailid: IMPORT_FIELD.PRIMARY_EMAIL,
  'e mail': IMPORT_FIELD.PRIMARY_EMAIL,
  'email address': IMPORT_FIELD.PRIMARY_EMAIL,
  'e mail address': IMPORT_FIELD.PRIMARY_EMAIL,
  'primary email': IMPORT_FIELD.PRIMARY_EMAIL,
  'email 1': IMPORT_FIELD.PRIMARY_EMAIL,
  'mail id': IMPORT_FIELD.PRIMARY_EMAIL,
  'work email': IMPORT_FIELD.PRIMARY_EMAIL,
  'business email': IMPORT_FIELD.PRIMARY_EMAIL,

  'secondary email': IMPORT_FIELD.SECONDARY_EMAIL,
  'email 2': IMPORT_FIELD.SECONDARY_EMAIL,
  'alternate email': IMPORT_FIELD.SECONDARY_EMAIL,
  'other email': IMPORT_FIELD.SECONDARY_EMAIL,

  // --- Phone -------------------------------------------------------------
  phone: IMPORT_FIELD.PHONE,
  'phone number': IMPORT_FIELD.PHONE,
  'contact number': IMPORT_FIELD.PHONE,
  'contact no': IMPORT_FIELD.PHONE,
  'phone no': IMPORT_FIELD.PHONE,
  telephone: IMPORT_FIELD.PHONE,
  tel: IMPORT_FIELD.PHONE,
  landline: IMPORT_FIELD.PHONE,
  'home phone': IMPORT_FIELD.PHONE,

  mobile: IMPORT_FIELD.MOBILE,
  'mobile number': IMPORT_FIELD.MOBILE,
  'mobile no': IMPORT_FIELD.MOBILE,
  cell: IMPORT_FIELD.MOBILE,
  'cell phone': IMPORT_FIELD.MOBILE,
  cellphone: IMPORT_FIELD.MOBILE,
  whatsapp: IMPORT_FIELD.MOBILE,

  'business phone': IMPORT_FIELD.BUSINESS_PHONE,
  'work phone': IMPORT_FIELD.BUSINESS_PHONE,
  'office phone': IMPORT_FIELD.BUSINESS_PHONE,
  'office number': IMPORT_FIELD.BUSINESS_PHONE,
  'direct dial': IMPORT_FIELD.BUSINESS_PHONE,

  // --- Web and location --------------------------------------------------
  website: IMPORT_FIELD.WEBSITE,
  url: IMPORT_FIELD.WEBSITE,
  'web site': IMPORT_FIELD.WEBSITE,
  'web page': IMPORT_FIELD.WEBSITE,
  webpage: IMPORT_FIELD.WEBSITE,
  domain: IMPORT_FIELD.WEBSITE,
  'company website': IMPORT_FIELD.WEBSITE,

  address: IMPORT_FIELD.ADDRESS,
  'street address': IMPORT_FIELD.ADDRESS,
  street: IMPORT_FIELD.ADDRESS,
  'address line 1': IMPORT_FIELD.ADDRESS,

  city: IMPORT_FIELD.CITY,
  town: IMPORT_FIELD.CITY,
  'city name': IMPORT_FIELD.CITY,
  location: IMPORT_FIELD.CITY,

  state: IMPORT_FIELD.STATE,
  province: IMPORT_FIELD.STATE,
  region: IMPORT_FIELD.STATE,
  county: IMPORT_FIELD.STATE,

  country: IMPORT_FIELD.COUNTRY,
  'country name': IMPORT_FIELD.COUNTRY,
  nation: IMPORT_FIELD.COUNTRY,

  'postal code': IMPORT_FIELD.POSTAL_CODE,
  postcode: IMPORT_FIELD.POSTAL_CODE,
  zip: IMPORT_FIELD.POSTAL_CODE,
  'zip code': IMPORT_FIELD.POSTAL_CODE,
  pincode: IMPORT_FIELD.POSTAL_CODE,
  pin: IMPORT_FIELD.POSTAL_CODE,

  // --- CRM ---------------------------------------------------------------
  notes: IMPORT_FIELD.NOTES,
  note: IMPORT_FIELD.NOTES,
  remark: IMPORT_FIELD.NOTES,
  remarks: IMPORT_FIELD.NOTES,
  comment: IMPORT_FIELD.NOTES,
  comments: IMPORT_FIELD.NOTES,
  description: IMPORT_FIELD.NOTES,
  'additional info': IMPORT_FIELD.NOTES,

  tags: IMPORT_FIELD.TAGS,
  tag: IMPORT_FIELD.TAGS,
  labels: IMPORT_FIELD.TAGS,
  categories: IMPORT_FIELD.TAGS,
  keywords: IMPORT_FIELD.TAGS,

  category: IMPORT_FIELD.CATEGORY,
  type: IMPORT_FIELD.CATEGORY,
  'contact type': IMPORT_FIELD.CATEGORY,

  source: IMPORT_FIELD.LEAD_SOURCE,
  'lead source': IMPORT_FIELD.LEAD_SOURCE,
  'source of lead': IMPORT_FIELD.LEAD_SOURCE,
  channel: IMPORT_FIELD.LEAD_SOURCE,
  campaign: IMPORT_FIELD.LEAD_SOURCE,
  'referred by': IMPORT_FIELD.LEAD_SOURCE,

  status: IMPORT_FIELD.LEAD_STATUS,
  'lead status': IMPORT_FIELD.LEAD_STATUS,
  stage: IMPORT_FIELD.LEAD_STATUS,
  'lead stage': IMPORT_FIELD.LEAD_STATUS,
  'contact status': IMPORT_FIELD.LEAD_STATUS,
})

/**
 * Substrings checked when no exact match is found, longest first.
 *
 * Order matters enormously: "email" must be tested before "mail", or
 * "Email Address" would match the shorter token and could be misrouted. Longest
 * first makes the most specific rule win by construction.
 */
const CONTAINS_RULES = Object.freeze(
  [
    ['secondaryemail', IMPORT_FIELD.SECONDARY_EMAIL],
    ['alternateemail', IMPORT_FIELD.SECONDARY_EMAIL],
    ['businessphone', IMPORT_FIELD.BUSINESS_PHONE],
    ['contactnumber', IMPORT_FIELD.PHONE],
    ['contactperson', IMPORT_FIELD.DISPLAY_NAME],
    ['mobilenumber', IMPORT_FIELD.MOBILE],
    ['leadsource', IMPORT_FIELD.LEAD_SOURCE],
    ['leadstatus', IMPORT_FIELD.LEAD_STATUS],
    ['companyname', IMPORT_FIELD.COMPANY],
    ['postalcode', IMPORT_FIELD.POSTAL_CODE],
    ['jobtitle', IMPORT_FIELD.JOB_TITLE],
    ['lastname', IMPORT_FIELD.LAST_NAME],
    ['firstname', IMPORT_FIELD.FIRST_NAME],
    ['fullname', IMPORT_FIELD.DISPLAY_NAME],
    ['emailid', IMPORT_FIELD.PRIMARY_EMAIL],
    ['website', IMPORT_FIELD.WEBSITE],
    ['company', IMPORT_FIELD.COMPANY],
    ['country', IMPORT_FIELD.COUNTRY],
    ['address', IMPORT_FIELD.ADDRESS],
    ['zipcode', IMPORT_FIELD.POSTAL_CODE],
    ['email', IMPORT_FIELD.PRIMARY_EMAIL],
    ['mobile', IMPORT_FIELD.MOBILE],
    ['remark', IMPORT_FIELD.NOTES],
    ['source', IMPORT_FIELD.LEAD_SOURCE],
    ['status', IMPORT_FIELD.LEAD_STATUS],
    ['phone', IMPORT_FIELD.PHONE],
    ['state', IMPORT_FIELD.STATE],
    ['notes', IMPORT_FIELD.NOTES],
    ['city', IMPORT_FIELD.CITY],
    ['name', IMPORT_FIELD.DISPLAY_NAME],
    ['tel', IMPORT_FIELD.PHONE],
    ['org', IMPORT_FIELD.COMPANY],
    ['url', IMPORT_FIELD.WEBSITE],
    ['zip', IMPORT_FIELD.POSTAL_CODE],
  ].sort((a, b) => b[0].length - a[0].length),
)

/**
 * Lower-cases and strips punctuation, so "E-Mail_ID" and "email id" agree.
 *
 * Exported because template matching must normalise identically — two separate
 * implementations would drift, and the symptom would be a saved template
 * silently failing to match the sheet it was built from.
 */
export function normaliseHeader(header) {
  return String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\-./\\]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The same, with spaces removed, for substring matching. */
const compact = (header) => normaliseHeader(header).replace(/\s/g, '')

/**
 * Content-based classifiers.
 *
 * Each returns the proportion of non-empty samples that look like the field.
 * Deliberately conservative: a rule that fires on ambiguous data is worse than
 * one that stays silent, because a wrong automatic mapping is harder to notice
 * than a missing one.
 */
const CONTENT_RULES = Object.freeze([
  {
    field: IMPORT_FIELD.PRIMARY_EMAIL,
    test: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value),
    minimum: 0.6,
  },
  {
    field: IMPORT_FIELD.WEBSITE,
    test: (value) => /^(https?:\/\/|www\.)\S+$/i.test(value) || /^[\w-]+\.(com|net|org|io|co)\b/i.test(value),
    minimum: 0.6,
  },
  {
    field: IMPORT_FIELD.PHONE,
    // Digits, separators and an optional leading +, with enough digits to be a
    // real number. Deliberately requires 7+ so postal codes and years do not match.
    test: (value) => /^\+?[\d\s()\-.]{7,}$/.test(value) && (value.match(/\d/g) ?? []).length >= 7,
    minimum: 0.7,
  },
])

/**
 * Suggests a mapping for one column.
 *
 * @param {string} header
 * @param {string[]} samples Non-empty values from that column.
 * @returns {{ field: string, confidence: number, reason: string }}
 */
export function detectColumn(header, samples = []) {
  const normalised = normaliseHeader(header)
  const compacted = compact(header)

  const values = samples.map((value) => String(value ?? '').trim()).filter(Boolean)

  // --- Pass 1: exact header match ------------------------------------------
  if (EXACT_ALIASES[normalised]) {
    return {
      field: EXACT_ALIASES[normalised],
      confidence: 1,
      reason: `Header "${header}" is a known column name.`,
    }
  }

  // --- Pass 2: exact match once spaces are removed -------------------------
  const compactMatch = Object.entries(EXACT_ALIASES).find(
    ([alias]) => alias.replace(/\s/g, '') === compacted,
  )

  if (compactMatch) {
    return {
      field: compactMatch[1],
      confidence: 0.95,
      reason: `Header "${header}" matches "${compactMatch[0]}".`,
    }
  }

  // --- Pass 3: content, before fuzzy header matching -----------------------
  //
  // Ordered ahead of substring matching on purpose. A column headed "Contact"
  // full of email addresses is an email column, and the data says so far more
  // reliably than the ambiguous word does.
  for (const rule of CONTENT_RULES) {
    if (values.length < 3) break

    const matches = values.filter((value) => rule.test(value)).length
    const ratio = matches / values.length

    if (ratio >= rule.minimum) {
      return {
        field: rule.field,
        confidence: Math.min(0.9, 0.6 + ratio * 0.3),
        reason: `${Math.round(ratio * 100)}% of values look like ${rule.field === IMPORT_FIELD.PRIMARY_EMAIL ? 'email addresses' : rule.field === IMPORT_FIELD.PHONE ? 'phone numbers' : 'web addresses'}.`,
      }
    }
  }

  // --- Pass 4: substring, longest rule first -------------------------------
  for (const [needle, field] of CONTAINS_RULES) {
    if (compacted.includes(needle)) {
      return {
        field,
        confidence: 0.7,
        reason: `Header "${header}" contains "${needle}".`,
      }
    }
  }

  return {
    field: IMPORT_FIELD.IGNORE,
    confidence: 0,
    reason: `No rule matched "${header}". Map it manually if it should be imported.`,
  }
}

/**
 * Suggests a mapping for every column, resolving collisions.
 *
 * Two columns cannot both map to `primaryEmail` — the second would overwrite the
 * first, silently. When it happens, the higher-confidence column keeps the
 * field. The loser is retried against its remaining candidates rather than being
 * dropped, so an "Email 2" column beaten to `primaryEmail` still lands on
 * `secondaryEmail` instead of being ignored.
 *
 * @param {string[]} headers
 * @param {Array<object>} rows Used for content sampling.
 * @returns {Array<{ column: string, index: number, field: string, confidence: number, reason: string }>}
 */
export function detectColumns(headers, rows = []) {
  const SAMPLE_SIZE = 25

  const suggestions = headers.map((header, index) => {
    const samples = rows
      .slice(0, SAMPLE_SIZE)
      .map((row) => row[header])
      .filter((value) => String(value ?? '').trim() !== '')

    return { column: header, index, ...detectColumn(header, samples) }
  })

  // --- Resolve collisions ---------------------------------------------------
  const claimed = new Map()

  // Strongest first, so the best candidate for a field claims it.
  const ordered = [...suggestions].sort((a, b) => b.confidence - a.confidence)

  for (const suggestion of ordered) {
    if (suggestion.field === IMPORT_FIELD.IGNORE) continue

    const holder = claimed.get(suggestion.field)

    if (!holder) {
      claimed.set(suggestion.field, suggestion)
      continue
    }

    // Beaten to this field. Fall back to a related one where that makes sense.
    const fallback = {
      [IMPORT_FIELD.PRIMARY_EMAIL]: IMPORT_FIELD.SECONDARY_EMAIL,
      [IMPORT_FIELD.PHONE]: IMPORT_FIELD.MOBILE,
      [IMPORT_FIELD.MOBILE]: IMPORT_FIELD.BUSINESS_PHONE,
      [IMPORT_FIELD.BUSINESS_PHONE]: IMPORT_FIELD.PHONE,
      [IMPORT_FIELD.DISPLAY_NAME]: IMPORT_FIELD.FIRST_NAME,
    }[suggestion.field]

    if (fallback && !claimed.has(fallback)) {
      suggestion.field = fallback
      suggestion.confidence = Math.max(0.5, suggestion.confidence - 0.2)
      suggestion.reason += ` "${holder.column}" was a stronger match for the original field.`
      claimed.set(fallback, suggestion)
    } else {
      suggestion.field = IMPORT_FIELD.IGNORE
      suggestion.confidence = 0
      suggestion.reason = `"${holder.column}" already maps to that field.`
    }
  }

  // Returned in the file's own column order, which is what the UI displays.
  return suggestions.sort((a, b) => a.index - b.index)
}

/**
 * Reports whether a mapping can be imported.
 *
 * @param {Array<{ column: string, field: string }>} mapping
 * @returns {{ ok: boolean, missing: string[], mappedFields: string[] }}
 */
export function validateMapping(mapping) {
  const mappedFields = mapping
    .map((entry) => entry.field)
    .filter((field) => field && field !== IMPORT_FIELD.IGNORE)

  // An email is required: it is the deduplication key and the address a campaign
  // sends to. Rows without one cannot participate in the workflow this CRM exists for.
  const missing = []
  if (!mappedFields.includes(IMPORT_FIELD.PRIMARY_EMAIL)) {
    missing.push(IMPORT_FIELD.PRIMARY_EMAIL)
  }

  return { ok: missing.length === 0, missing, mappedFields: [...new Set(mappedFields)] }
}

export default { detectColumn, detectColumns, validateMapping, normaliseHeader }
