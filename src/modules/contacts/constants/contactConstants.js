/**
 * Contact vocabulary.
 *
 * Every value here is part of the API contract — the UI filters on them and the
 * import/export formats round-trip them — so they must not be renamed once
 * published.
 */

/**
 * Where a contact came from.
 *
 * The distinction drives real behaviour, not just display: a `crm` contact is
 * never overwritten by a sync, and an `outlook` contact is never deleted
 * locally when it disappears upstream without the deletion being recorded.
 */
export const CONTACT_SOURCE = Object.freeze({
  /** Synchronised from a mail provider. */
  OUTLOOK: 'outlook',
  /** Created in this CRM. Exists nowhere else. */
  CRM: 'crm',
  /** Loaded from a CSV, vCard or spreadsheet. */
  IMPORT: 'import',
  /** Created through the API by an integration. */
  API: 'api',
})

export const CONTACT_SOURCE_VALUES = Object.freeze(Object.values(CONTACT_SOURCE))

export const CONTACT_SOURCE_LABELS = Object.freeze({
  [CONTACT_SOURCE.OUTLOOK]: 'Outlook',
  [CONTACT_SOURCE.CRM]: 'CRM',
  [CONTACT_SOURCE.IMPORT]: 'Imported',
  [CONTACT_SOURCE.API]: 'API',
})

/** Relationship classification. */
export const CONTACT_CATEGORY = Object.freeze({
  CUSTOMER: 'customer',
  LEAD: 'lead',
  PARTNER: 'partner',
  VENDOR: 'vendor',
  PERSONAL: 'personal',
  OTHER: 'other',
})

export const CONTACT_CATEGORY_VALUES = Object.freeze(Object.values(CONTACT_CATEGORY))

export const CONTACT_CATEGORY_LABELS = Object.freeze({
  [CONTACT_CATEGORY.CUSTOMER]: 'Customer',
  [CONTACT_CATEGORY.LEAD]: 'Lead',
  [CONTACT_CATEGORY.PARTNER]: 'Partner',
  [CONTACT_CATEGORY.VENDOR]: 'Vendor',
  [CONTACT_CATEGORY.PERSONAL]: 'Personal',
  [CONTACT_CATEGORY.OTHER]: 'Other',
})

/** Per-contact synchronisation state. */
export const CONTACT_SYNC_STATUS = Object.freeze({
  /** Local only; nothing upstream to reconcile with. */
  LOCAL: 'local',
  /** In step with the provider. */
  SYNCED: 'synced',
  /** Edited locally since the last sync; owes an upstream write. */
  PENDING: 'pending',
  /** Changed in both places; needs a decision. */
  CONFLICT: 'conflict',
  /** Removed at the provider but retained here. */
  DELETED_REMOTE: 'deleted_remote',
  /** The last sync attempt failed for this record. */
  FAILED: 'failed',
})

export const CONTACT_SYNC_STATUS_VALUES = Object.freeze(Object.values(CONTACT_SYNC_STATUS))

export const CONTACT_SYNC_STATUS_LABELS = Object.freeze({
  [CONTACT_SYNC_STATUS.LOCAL]: 'CRM only',
  [CONTACT_SYNC_STATUS.SYNCED]: 'Synced',
  [CONTACT_SYNC_STATUS.PENDING]: 'Pending upload',
  [CONTACT_SYNC_STATUS.CONFLICT]: 'Conflict',
  [CONTACT_SYNC_STATUS.DELETED_REMOTE]: 'Deleted in Outlook',
  [CONTACT_SYNC_STATUS.FAILED]: 'Sync failed',
})

/**
 * How a duplicate was identified.
 *
 * Recorded on every match so a merge is auditable — "these were joined because
 * the primary emails matched" is a very different claim from "the display names
 * looked alike", and the second warrants review.
 */
export const MATCH_STRATEGY = Object.freeze({
  PROVIDER_ID: 'provider_id',
  EMAIL: 'email',
  PHONE: 'phone',
  DISPLAY_NAME: 'display_name',
})

export const MATCH_STRATEGY_VALUES = Object.freeze(Object.values(MATCH_STRATEGY))

/**
 * Confidence attached to each strategy, highest first.
 *
 * A provider id is an exact identity claim. An email is very nearly one — two
 * people rarely share a mailbox. A phone number is weaker, since households and
 * switchboards are shared. A display name is the weakest of all: "John Smith"
 * is not evidence, which is why name matches are surfaced for review rather
 * than merged automatically.
 */
export const MATCH_CONFIDENCE = Object.freeze({
  [MATCH_STRATEGY.PROVIDER_ID]: 1.0,
  [MATCH_STRATEGY.EMAIL]: 0.95,
  [MATCH_STRATEGY.PHONE]: 0.75,
  [MATCH_STRATEGY.DISPLAY_NAME]: 0.4,
})

/** At or above this, a duplicate may be merged without asking. */
export const AUTO_MERGE_THRESHOLD = 0.9

/** How a conflict between local and remote versions was settled. */
export const MERGE_STRATEGY = Object.freeze({
  /** Provider state wins. Default for provider-owned fields. */
  REMOTE_WINS: 'remote_wins',
  /** Local edit was newer and is preserved. */
  LOCAL_WINS: 'local_wins',
  /** Field-by-field: whichever side has a value, preferring the newer. */
  FIELD_UNION: 'field_union',
  /** Both changed the same field differently; a human must choose. */
  MANUAL: 'manual',
})

export const MERGE_STRATEGY_VALUES = Object.freeze(Object.values(MERGE_STRATEGY))

/** Named filters the contacts list offers. */
export const CONTACT_FILTER = Object.freeze({
  ALL: 'all',
  FAVORITES: 'favorites',
  RECENTLY_ADDED: 'recently_added',
  RECENTLY_CONTACTED: 'recently_contacted',
  CRM_ONLY: 'crm_only',
  OUTLOOK_ONLY: 'outlook_only',
  HAS_CONFLICT: 'has_conflict',
})

export const CONTACT_FILTER_VALUES = Object.freeze(Object.values(CONTACT_FILTER))

/** "Recently added" and "recently contacted" both mean within this window. */
export const RECENT_WINDOW_DAYS = 30

/** Import/export formats. */
export const TRANSFER_FORMAT = Object.freeze({
  CSV: 'csv',
  VCF: 'vcf',
  XLSX: 'xlsx',
  JSON: 'json',
})

export const TRANSFER_FORMAT_VALUES = Object.freeze(Object.values(TRANSFER_FORMAT))

export const TRANSFER_MIME_TYPES = Object.freeze({
  [TRANSFER_FORMAT.CSV]: 'text/csv; charset=utf-8',
  [TRANSFER_FORMAT.VCF]: 'text/vcard; charset=utf-8',
  [TRANSFER_FORMAT.XLSX]:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  [TRANSFER_FORMAT.JSON]: 'application/json; charset=utf-8',
})

/**
 * How an import treats a row matching an existing contact.
 */
export const IMPORT_MODE = Object.freeze({
  /** Add new contacts, leave matches untouched. The safe default. */
  SKIP_DUPLICATES: 'skip_duplicates',
  /** Add new, and fill blank fields on matches without overwriting values. */
  MERGE: 'merge',
  /** Add new, and overwrite matches entirely. */
  OVERWRITE: 'overwrite',
})

export const IMPORT_MODE_VALUES = Object.freeze(Object.values(IMPORT_MODE))

/** Preset colours offered for contact groups. */
export const GROUP_COLORS = Object.freeze([
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
  '#475569',
])

export default CONTACT_SOURCE
