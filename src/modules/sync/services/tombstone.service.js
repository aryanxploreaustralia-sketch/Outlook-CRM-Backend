/**
 * Recording physical deletions, so an offline client can learn about them.
 *
 * ## The one rule these functions follow
 *
 * **Recording a tombstone must never prevent a deletion.** The caller's job is
 * to delete; this is bookkeeping that runs alongside. If the write fails —
 * the collection is unreachable, the disk is full, anything — the failure is
 * logged and swallowed, and the deletion proceeds exactly as it did before this
 * module existed.
 *
 * The alternative would be a CRM where "Delete all leads" can fail because a
 * *sync* collection is unhappy, which is a far worse outcome than a client that
 * has to resynchronise.
 *
 * ## Order of operations
 *
 * The tombstone is written **before** the delete. A tombstone for a record that
 * survives is harmless — the next sync sends the record again and the client
 * puts it back. A deletion with no tombstone is invisible forever. Given one
 * has to happen first, it is the recoverable failure that should go second.
 */

import { SyncTombstone, TOMBSTONE_ENTITY } from '../../../models/syncTombstone.model.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('sync-tombstone')

/**
 * Records that every record of one type, for one owner, was removed.
 *
 * Used by the bulk paths — "Delete all leads", and an import rollback that
 * removes more rows than are worth naming. The client's response is to
 * resynchronise that entity from scratch rather than to delete ids one by one.
 *
 * @param {object}  params
 * @param {string}  params.entityType One of `TOMBSTONE_ENTITY`.
 * @param {any}     params.owner
 * @param {?string} [params.reason]
 * @returns {Promise<boolean>} Whether it was recorded. Never throws.
 */
export async function recordPurge({ entityType, owner, reason = null }) {
  try {
    await SyncTombstone.create({ entityType, entityId: null, owner, reason })
    return true
  } catch (error) {
    /*
     * Swallowed on purpose — see the note at the top of this file. The cost of
     * this failure is a client that keeps stale rows until its next full
     * resync. The cost of rethrowing would be a deletion the user asked for
     * that did not happen.
     */
    log.warn('Could not record a purge tombstone', {
      entityType,
      owner: String(owner),
      message: error.message,
    })
    return false
  }
}

/**
 * Records that specific records were removed.
 *
 * For a deletion small enough that naming the ids is cheaper for the client
 * than resynchronising. Above `maxIds` this collapses to a single purge
 * tombstone, because a client handed ten thousand ids will spend longer
 * deleting them than refetching the entity.
 *
 * @param {object}   params
 * @param {string}   params.entityType
 * @param {any[]}    params.entityIds
 * @param {any}      params.owner
 * @param {?string} [params.reason]
 * @param {number}  [params.maxIds]
 * @returns {Promise<boolean>} Never throws.
 */
export async function recordDeletions({ entityType, entityIds, owner, reason = null, maxIds = 1000 }) {
  const ids = (entityIds ?? []).filter(Boolean)
  if (ids.length === 0) return true

  if (ids.length > maxIds) {
    return recordPurge({ entityType, owner, reason: reason ?? `bulk deletion of ${ids.length} records` })
  }

  try {
    const deletedAt = new Date()
    await SyncTombstone.insertMany(
      ids.map((entityId) => ({ entityType, entityId, owner, reason, deletedAt })),
      // One bad row must not discard the rest of the batch.
      { ordered: false },
    )
    return true
  } catch (error) {
    log.warn('Could not record deletion tombstones', {
      entityType,
      count: ids.length,
      owner: String(owner),
      message: error.message,
    })
    return false
  }
}

export { TOMBSTONE_ENTITY }

export default { recordPurge, recordDeletions, TOMBSTONE_ENTITY }
