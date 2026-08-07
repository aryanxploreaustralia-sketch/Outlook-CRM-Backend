/**
 * The employee profile vocabulary, and the completion rule.
 *
 * ## Why completion is computed, never stored
 *
 * The brief lists `profileCompletion` as a `User` field. It is derived here
 * instead, on every read. A stored percentage is a cached aggregate of eleven
 * other fields, and every one of them can be written by a path that forgets to
 * recompute it — a partial update, a script, an admin edit. The failure is
 * silent and permanent: a profile that says 78% forever while the person fills
 * the rest in.
 *
 * Deriving costs one pass over an object already in memory. It cannot drift.
 *
 * ## Why these fields and not every field
 *
 * Completion counts what a person can actually supply. `email`, `role` and
 * `joiningDate` are read-only to the employee, so including them would credit
 * somebody for information they never provided — and worse, would make a brand
 * new profile read as 30% complete before it has anything in it.
 */

/** Gender is deliberately open beyond the binary, and declining is a valid answer. */
export const GENDER = Object.freeze({
  FEMALE: 'female',
  MALE: 'male',
  OTHER: 'other',
  UNDISCLOSED: 'undisclosed',
})

export const GENDER_VALUES = Object.freeze(Object.values(GENDER))

export const GENDER_LABELS = Object.freeze({
  [GENDER.FEMALE]: 'Female',
  [GENDER.MALE]: 'Male',
  [GENDER.OTHER]: 'Other',
  [GENDER.UNDISCLOSED]: 'Prefer not to say',
})

/** Document categories the upload form offers. */
export const DOCUMENT_CATEGORY = Object.freeze({
  AADHAAR: 'aadhaar',
  PAN: 'pan',
  PASSPORT: 'passport',
  RESUME: 'resume',
  OTHER: 'other',
})

export const DOCUMENT_CATEGORY_VALUES = Object.freeze(Object.values(DOCUMENT_CATEGORY))

export const DOCUMENT_CATEGORY_LABELS = Object.freeze({
  [DOCUMENT_CATEGORY.AADHAAR]: 'Aadhaar card',
  [DOCUMENT_CATEGORY.PAN]: 'PAN card',
  [DOCUMENT_CATEGORY.PASSPORT]: 'Passport',
  [DOCUMENT_CATEGORY.RESUME]: 'Résumé',
  [DOCUMENT_CATEGORY.OTHER]: 'Other',
})

/** Verification lifecycle. */
export const DOCUMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
})

export const DOCUMENT_STATUS_VALUES = Object.freeze(Object.values(DOCUMENT_STATUS))

export const DOCUMENT_STATUS_LABELS = Object.freeze({
  [DOCUMENT_STATUS.PENDING]: 'Pending review',
  [DOCUMENT_STATUS.VERIFIED]: 'Verified',
  [DOCUMENT_STATUS.REJECTED]: 'Rejected',
})

/**
 * Upload limits.
 *
 * The MIME allowlist is checked against the *sniffed* bytes, not the declared
 * header — a client controls the header, and "it says it is a PDF" is not the
 * same as "it is a PDF".
 */
export const MAX_DOCUMENTS_PER_USER = 5
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024

export const DOCUMENT_MIME_TYPES = Object.freeze({
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
})

export const PHOTO_MIME_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
})

/**
 * The fields completion is measured against, grouped the way the UI groups them.
 *
 * A flat list would make the percentage arithmetic simpler and the *feedback*
 * useless: an employee at 60% needs to know which section to open, not that
 * four unnamed things are missing.
 */
export const PROFILE_COMPLETION_FIELDS = Object.freeze([
  { key: 'profilePhoto', label: 'Profile photo', group: 'basic' },
  { key: 'phone', label: 'Mobile number', group: 'basic' },
  { key: 'employeeId', label: 'Employee ID', group: 'basic' },
  { key: 'department', label: 'Department', group: 'basic' },
  { key: 'designation', label: 'Designation', group: 'basic' },
  { key: 'dateOfBirth', label: 'Date of birth', group: 'personal' },
  { key: 'gender', label: 'Gender', group: 'personal' },
  { key: 'address.line1', label: 'Address', group: 'personal' },
  { key: 'address.city', label: 'City', group: 'personal' },
  { key: 'address.country', label: 'Country', group: 'personal' },
  { key: 'emergencyContact.name', label: 'Emergency contact', group: 'personal' },
  { key: 'emergencyContact.phone', label: 'Emergency contact number', group: 'personal' },
])

/** Reads `a.b.c` off an object without throwing on a missing branch. */
function at(source, path) {
  return path
    .split('.')
    // Explicit rather than `== null`: this must stop on both null and
    // undefined, and the loose form is the kind of shortcut a linter is right
    // to flag even when it happens to be correct.
    .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), source)
}

/**
 * Whether a value counts as supplied.
 *
 * A whitespace-only string is not an answer, and `undisclosed` for gender *is*
 * one — declining to say is a deliberate choice and should not hold somebody
 * at 92% forever.
 */
function isProvided(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (value instanceof Date) return !Number.isNaN(value.getTime())

  return true
}

/**
 * Computes profile completion.
 *
 * @param {object} user A `User` document or lean object.
 * @returns {{ percentage: number, completed: number, total: number, missing: object[] }}
 */
export function profileCompletion(user) {
  const missing = []
  let completed = 0

  for (const field of PROFILE_COMPLETION_FIELDS) {
    if (isProvided(at(user, field.key))) completed += 1
    else missing.push(field)
  }

  const total = PROFILE_COMPLETION_FIELDS.length

  return {
    // Rounded, but never rounded *up to 100* while something is missing —
    // 11 of 12 is 91.7%, and showing "100%" beside an empty field is the one
    // number this widget must never print.
    percentage: completed === total ? 100 : Math.min(99, Math.round((completed / total) * 100)),
    completed,
    total,
    missing,
  }
}

export default { DOCUMENT_CATEGORY, DOCUMENT_STATUS, GENDER, profileCompletion }
