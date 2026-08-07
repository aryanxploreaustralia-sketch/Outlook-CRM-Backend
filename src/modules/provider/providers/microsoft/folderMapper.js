/**
 * Translation between Graph `mailFolder` resources and canonical folders.
 *
 * The mapping rules themselves live in `constants/folderTypes.js` so they are
 * shared with any future adapter that needs them; this file is the Graph-shaped
 * wrapper around them.
 */

import { FOLDERS, toCanonicalFolder } from '../../constants/folderTypes.js'

/**
 * Graph `mailFolder` → `ProviderFolder`.
 *
 * @param {object} folder
 * @returns {import('../../interfaces/EmailProvider.js').ProviderFolder}
 */
export function toProviderFolder(folder) {
  return {
    providerFolderId: folder?.id ?? null,
    displayName: folder?.displayName ?? 'Unnamed folder',
    canonical: toCanonicalFolder({
      wellKnownName: folder?.wellKnownName,
      displayName: folder?.displayName,
    }),
    wellKnownName: folder?.wellKnownName ?? null,
    parentFolderId: folder?.parentFolderId ?? null,
    totalItemCount: folder?.totalItemCount ?? 0,
    unreadItemCount: folder?.unreadItemCount ?? 0,
  }
}

/**
 * Graph's well-known folder alias for a canonical folder.
 *
 * Graph accepts these directly in a path — `/me/mailFolders/inbox/messages` —
 * which avoids a lookup call purely to turn "inbox" into an opaque folder id.
 * Returns null for folders with no alias, which then need a real id.
 *
 * @param {string} canonical
 * @returns {?string}
 */
export function toGraphWellKnownName(canonical) {
  return (
    {
      [FOLDERS.INBOX]: 'inbox',
      [FOLDERS.SENT]: 'sentitems',
      [FOLDERS.DRAFTS]: 'drafts',
      [FOLDERS.TRASH]: 'deleteditems',
      [FOLDERS.ARCHIVE]: 'archive',
      [FOLDERS.SPAM]: 'junkemail',
      [FOLDERS.OUTBOX]: 'outbox',
    }[canonical] ?? null
  )
}

/**
 * Resolves the path segment to address a folder by.
 *
 * Prefers an explicit provider id, since a custom folder has no alias. Falls
 * back to the well-known name, which is what makes a first sync possible before
 * folders have ever been enumerated.
 *
 * @param {{ canonical?: string, providerFolderId?: ?string }} folder
 * @returns {?string}
 */
export function resolveFolderPath(folder = {}) {
  if (folder.providerFolderId) return folder.providerFolderId
  return toGraphWellKnownName(folder.canonical)
}

export default { toProviderFolder, toGraphWellKnownName, resolveFolderPath }
