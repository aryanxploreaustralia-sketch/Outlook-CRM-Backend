/**
 * Where employee documents live on disk.
 *
 * Reuses the strategy the CRM already has: bytes on local disk under a
 * configured root, a **relative** path in Mongo. Identical to
 * `conversations/attachment.service.js`, including the traversal guard — this
 * is not a new upload mechanism, it is the existing one pointed at a new tree.
 */

import { createHash } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { config } from '../../../config/index.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import { generateOpaqueToken } from '../../../utils/crypto.js'

const log = createContextLogger('document-storage')

export const STORAGE_ROOT = config.storage.documents

/**
 * Sniffs the real type from the leading bytes.
 *
 * The `Content-Type` header is supplied by the client and is a claim, not a
 * fact. Accepting it would let somebody upload an executable labelled
 * `application/pdf`, which the download endpoint would then serve back with
 * that content type. Magic numbers are what the file actually is.
 */
export function sniffMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null

  // %PDF
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf'

  // \x89PNG
  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString('ascii') === 'PNG') return 'image/png'

  // JPEG SOI marker
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'

  return null
}

/**
 * Builds a storage path that cannot escape the root.
 *
 * The name is generated, never derived from what the user called the file: a
 * filename is attacker-controlled text and must not reach the filesystem. The
 * `startsWith` check is the same belt-and-braces guard the attachment store
 * uses — even a generated name is verified before it is written to.
 */
function resolvePath(userId, extension) {
  const relative = path.join(String(userId), `${Date.now()}-${generateOpaqueToken(8)}.${extension}`)
  const absolute = path.resolve(STORAGE_ROOT, relative)

  if (!absolute.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) {
    throw ApiError.badRequest('That storage path is not valid.')
  }

  return { relative, absolute }
}

/**
 * Writes bytes and returns what the metadata row needs.
 *
 * @param {{ userId: string, buffer: Buffer, extension: string }} params
 */
export async function storeFile({ userId, buffer, extension }) {
  const { relative, absolute } = resolvePath(userId, extension)

  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, buffer)

  return {
    storageKey: relative,
    size: buffer.length,
    checksum: createHash('sha256').update(buffer).digest('hex'),
  }
}

/**
 * Resolves a stored key back to an absolute path, re-checking the boundary.
 *
 * Re-checked on read as well as on write: a row could have been written by an
 * older version, or edited directly in the database, and the guard is worthless
 * if it only runs on the path nobody attacks.
 */
export function resolveStoredPath(storageKey) {
  const absolute = path.resolve(STORAGE_ROOT, storageKey)

  if (!absolute.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) {
    throw ApiError.badRequest('That document path is not valid.')
  }

  return absolute
}

/**
 * Removes bytes from disk.
 *
 * Never throws. The metadata row is the record; a file already gone is the
 * desired end state, and failing the request because the disk had already lost
 * it would leave a row the employee cannot clear.
 */
export async function removeFile(storageKey) {
  if (!storageKey) return false

  try {
    await unlink(resolveStoredPath(storageKey))
    return true
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log.warn('Document bytes could not be removed', { storageKey, message: error.message })
    }
    return false
  }
}

export default { removeFile, resolveStoredPath, sniffMimeType, storeFile }
