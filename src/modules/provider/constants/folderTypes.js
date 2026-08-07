/**
 * Canonical folder vocabulary and the provider mappings onto it.
 *
 * ## Why a canonical set exists
 *
 * Every provider names its folders differently — Outlook says "Deleted Items",
 * Gmail calls the same concept a `TRASH` label, IMAP servers use `\Deleted`.
 * Business logic must not branch on any of those. It reads `folder: 'trash'`
 * and the adapter is responsible for translating.
 *
 * The mapping is keyed on the **well-known name** Graph returns rather than the
 * display name, because display names are localised: a mailbox set to French
 * reports "Éléments supprimés", and matching on that would silently break
 * folder mapping for every non-English user.
 */

/** Provider-independent folder identities. */
export const FOLDERS = Object.freeze({
  INBOX: 'inbox',
  SENT: 'sent',
  DRAFTS: 'drafts',
  TRASH: 'trash',
  ARCHIVE: 'archive',
  SPAM: 'spam',
  OUTBOX: 'outbox',
  /** Anything the provider offers that has no canonical equivalent. */
  CUSTOM: 'custom',
})

export const FOLDER_VALUES = Object.freeze(Object.values(FOLDERS))

export const FOLDER_LABELS = Object.freeze({
  [FOLDERS.INBOX]: 'Inbox',
  [FOLDERS.SENT]: 'Sent Items',
  [FOLDERS.DRAFTS]: 'Drafts',
  [FOLDERS.TRASH]: 'Deleted Items',
  [FOLDERS.ARCHIVE]: 'Archive',
  [FOLDERS.SPAM]: 'Junk Email',
  [FOLDERS.OUTBOX]: 'Outbox',
  [FOLDERS.CUSTOM]: 'Custom folder',
})

/**
 * Microsoft Graph `wellKnownName` → canonical folder.
 *
 * Graph exposes these lowercase on `mailFolders`. Both `junkemail` and
 * `deleteditems` are included under their exact Graph spellings; guessing at
 * `junk` or `deleted` would map nothing.
 */
export const GRAPH_WELL_KNOWN_TO_CANONICAL = Object.freeze({
  inbox: FOLDERS.INBOX,
  sentitems: FOLDERS.SENT,
  drafts: FOLDERS.DRAFTS,
  deleteditems: FOLDERS.TRASH,
  recoverableitemsdeletions: FOLDERS.TRASH,
  archive: FOLDERS.ARCHIVE,
  junkemail: FOLDERS.SPAM,
  outbox: FOLDERS.OUTBOX,
  // Present in every mailbox but not a destination this application syncs.
  msgfolderroot: FOLDERS.CUSTOM,
  searchfolders: FOLDERS.CUSTOM,
  conversationhistory: FOLDERS.CUSTOM,
  clutter: FOLDERS.CUSTOM,
  serverfailures: FOLDERS.CUSTOM,
  syncissues: FOLDERS.CUSTOM,
})

/**
 * Fallback used when `wellKnownName` is absent.
 *
 * Graph omits it for user-created folders, and older mailboxes sometimes omit it
 * for standard ones too. Matching the English display name recovers the common
 * case; anything else is correctly classified as custom.
 */
export const DISPLAY_NAME_TO_CANONICAL = Object.freeze({
  inbox: FOLDERS.INBOX,
  'sent items': FOLDERS.SENT,
  sent: FOLDERS.SENT,
  drafts: FOLDERS.DRAFTS,
  'deleted items': FOLDERS.TRASH,
  trash: FOLDERS.TRASH,
  archive: FOLDERS.ARCHIVE,
  'junk email': FOLDERS.SPAM,
  junk: FOLDERS.SPAM,
  spam: FOLDERS.SPAM,
  outbox: FOLDERS.OUTBOX,
})

/**
 * Folders synchronised by a full sync, in order.
 *
 * Inbox first because it is what a user opens the app to see; trash last because
 * it is the least urgent and the most likely to be large.
 */
export const SYNCABLE_FOLDERS = Object.freeze([
  FOLDERS.INBOX,
  FOLDERS.SENT,
  FOLDERS.DRAFTS,
  FOLDERS.ARCHIVE,
  FOLDERS.TRASH,
])

/**
 * Resolves a provider folder to its canonical identity.
 *
 * @param {{ wellKnownName?: ?string, displayName?: ?string }} folder
 * @returns {string} One of FOLDERS.
 */
export function toCanonicalFolder(folder = {}) {
  const wellKnown = folder.wellKnownName?.toLowerCase()
  if (wellKnown && GRAPH_WELL_KNOWN_TO_CANONICAL[wellKnown]) {
    return GRAPH_WELL_KNOWN_TO_CANONICAL[wellKnown]
  }

  const display = folder.displayName?.trim().toLowerCase()
  if (display && DISPLAY_NAME_TO_CANONICAL[display]) {
    return DISPLAY_NAME_TO_CANONICAL[display]
  }

  return FOLDERS.CUSTOM
}

export default FOLDERS
