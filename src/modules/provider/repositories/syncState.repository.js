/**
 * Persistence for per-folder sync state and run history.
 *
 * The locking helpers matter most. Two sync runs against one folder would
 * double-write every message and race on the delta token, leaving a token that
 * describes neither run — so acquisition is a single atomic update rather than
 * a read-then-write, which two processes could both pass.
 */

import { SyncState, SYNC_LOCK_TTL_MS } from '../../../models/syncState.model.js'
import { SyncHistory } from '../../../models/syncHistory.model.js'
import { SYNC_STATUS } from '../constants/syncStatus.js'

/**
 * Finds or creates the state record for a folder.
 *
 * @returns {Promise<object>}
 */
export async function ensureState({ user, mailboxId, folder, providerFolderId = null }) {
  return SyncState.findOneAndUpdate(
    { mailbox: mailboxId, folder },
    {
      $setOnInsert: { user, mailbox: mailboxId, folder, syncStatus: SYNC_STATUS.IDLE },
      ...(providerFolderId ? { $set: { providerFolderId } } : {}),
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )
}

/**
 * Takes the lock for a folder, if it is free.
 *
 * Atomic by construction: the filter requires the lock to be absent or stale,
 * and MongoDB applies filter and update as one operation. A second caller
 * arriving concurrently matches nothing and gets null — which is the correct
 * answer, not an error.
 *
 * @returns {Promise<?object>} The locked record, or null if another run holds it.
 */
export async function acquireLock({ mailboxId, folder }) {
  const staleBefore = new Date(Date.now() - SYNC_LOCK_TTL_MS)

  return SyncState.findOneAndUpdate(
    {
      mailbox: mailboxId,
      folder,
      // Free, never locked, or abandoned by a crashed process.
      $or: [{ lockedAt: null }, { lockedAt: { $lt: staleBefore } }],
    },
    { $set: { lockedAt: new Date(), syncStatus: SYNC_STATUS.RUNNING } },
    { new: true },
  )
}

/** Releases the lock and records the outcome. */
export async function releaseLock({ mailboxId, folder, status, error = null, deltaToken }) {
  const update = {
    $set: {
      lockedAt: null,
      syncStatus: status,
      lastSyncAt: new Date(),
    },
  }

  if (status === SYNC_STATUS.SUCCESS) {
    update.$set.lastSuccessfulSyncAt = new Date()
    update.$set.lastError = { code: null, message: null, occurredAt: null }
    update.$set.consecutiveFailures = 0
    // Cleared only on success: a failed run must keep the flag so the next
    // attempt still knows a full resync is owed.
    update.$set.fullResyncRequired = false
  } else if (status === SYNC_STATUS.FAILED) {
    update.$set.lastError = {
      code: error?.code ?? null,
      message: error?.message ?? null,
      occurredAt: new Date(),
    }
    update.$inc = { consecutiveFailures: 1 }
  }

  // `undefined` means "unchanged"; null means "explicitly cleared", which is how
  // an expired delta token is discarded.
  if (deltaToken !== undefined) update.$set.lastDeltaToken = deltaToken

  return SyncState.findOneAndUpdate({ mailbox: mailboxId, folder }, update, { new: true })
}

/** Marks a folder as needing a full resync, discarding its delta token. */
export async function requireFullResync({ mailboxId, folder }) {
  return SyncState.findOneAndUpdate(
    { mailbox: mailboxId, folder },
    { $set: { fullResyncRequired: true, lastDeltaToken: null } },
    { new: true },
  )
}

/** Adds to a folder's cumulative message counter. */
export async function incrementMessagesSynced({ mailboxId, folder, count }) {
  if (count <= 0) return null

  return SyncState.findOneAndUpdate(
    { mailbox: mailboxId, folder },
    { $inc: { messagesSynced: count } },
    { new: true },
  )
}

/** @returns {Promise<object[]>} */
export async function listStates({ user, mailboxId }) {
  return SyncState.find({ user, mailbox: mailboxId }).sort({ folder: 1 })
}

/**
 * Releases every lock held by a mailbox.
 *
 * Called during graceful shutdown so an interrupted run does not leave folders
 * locked for the full TTL after a restart.
 */
export async function releaseAllLocks({ mailboxId }) {
  const { modifiedCount } = await SyncState.updateMany(
    { mailbox: mailboxId, lockedAt: { $ne: null } },
    { $set: { lockedAt: null, syncStatus: SYNC_STATUS.CANCELLED } },
  )

  return modifiedCount ?? 0
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Opens a history record for a run. */
export async function startRun({ user, mailboxId, provider, trigger, mode, folders, correlationId }) {
  return SyncHistory.create({
    user,
    mailbox: mailboxId,
    provider,
    trigger,
    mode,
    folders,
    correlationId,
    status: SYNC_STATUS.RUNNING,
    startedAt: new Date(),
  })
}

/** Closes a run, computing totals and the overall status from its results. */
export async function finishRun({ run, results, errors = [] }) {
  run.results = results
  run.runErrors = errors
  run.finishedAt = new Date()
  run.durationMs = run.finishedAt.getTime() - run.startedAt.getTime()

  run.summarise()

  await run.save()
  return run
}

/**
 * Paginated run history for a mailbox.
 *
 * @returns {Promise<{ items: object[], total: number }>}
 */
export async function listHistory({ user, mailboxId, page = 1, limit = 20 }) {
  const filter = { user }
  if (mailboxId) filter.mailbox = mailboxId

  const skip = (page - 1) * limit

  // Run together — the count does not depend on the page, and serialising them
  // would double the latency of every history request.
  const [items, total] = await Promise.all([
    SyncHistory.find(filter)
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      // Only the address, so a workspace-wide list can label each row without
      // pulling the whole mailbox document into the response.
      .populate('mailbox', 'emailAddress'),
    SyncHistory.countDocuments(filter),
  ])

  return { items, total }
}

export default {
  ensureState,
  acquireLock,
  releaseLock,
  requireFullResync,
  incrementMessagesSynced,
  listStates,
  releaseAllLocks,
  startRun,
  finishRun,
  listHistory,
}
