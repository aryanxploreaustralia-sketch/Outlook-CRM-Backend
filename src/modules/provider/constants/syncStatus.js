/**
 * Synchronisation vocabulary.
 *
 * Reported by `/provider/status` and `/provider/history`, so these strings are
 * part of the API contract.
 */

/** State of a sync run, and of the `SyncState` record between runs. */
export const SYNC_STATUS = Object.freeze({
  /** Never synchronised. */
  IDLE: 'idle',
  RUNNING: 'running',
  SUCCESS: 'success',
  /**
   * Some folders synced, others failed.
   *
   * Distinct from `FAILED` because the data that did arrive is usable, and
   * reporting a partial run as a total failure would tell the user to discard
   * results that are fine.
   */
  PARTIAL: 'partial',
  FAILED: 'failed',
  /** Superseded or shut down mid-run. */
  CANCELLED: 'cancelled',
})

export const SYNC_STATUS_VALUES = Object.freeze(Object.values(SYNC_STATUS))

export const SYNC_STATUS_LABELS = Object.freeze({
  [SYNC_STATUS.IDLE]: 'Never synced',
  [SYNC_STATUS.RUNNING]: 'Syncing',
  [SYNC_STATUS.SUCCESS]: 'Up to date',
  [SYNC_STATUS.PARTIAL]: 'Partially synced',
  [SYNC_STATUS.FAILED]: 'Sync failed',
  [SYNC_STATUS.CANCELLED]: 'Cancelled',
})

/** How a run was started. */
export const SYNC_TRIGGER = Object.freeze({
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
  /** Run automatically the first time a mailbox is connected. */
  INITIAL: 'initial',
  WEBHOOK: 'webhook',
})

export const SYNC_TRIGGER_VALUES = Object.freeze(Object.values(SYNC_TRIGGER))

/**
 * Sync strategy.
 *
 * `INCREMENTAL` replays a provider delta token and transfers only what changed.
 * `FULL` ignores any stored token and re-reads the folder — needed after a
 * delta token expires, which Graph does after roughly 30 days of disuse.
 */
export const SYNC_MODE = Object.freeze({
  FULL: 'full',
  INCREMENTAL: 'incremental',
})

export const SYNC_MODE_VALUES = Object.freeze(Object.values(SYNC_MODE))

/**
 * How a collision between local and remote state is settled.
 *
 * Recorded per conflict so the resolution is auditable rather than implicit.
 */
export const CONFLICT_RESOLUTION = Object.freeze({
  /** Provider state won — the default, since the mailbox is authoritative. */
  REMOTE_WINS: 'remote_wins',
  /** Local edit was newer and was preserved. */
  LOCAL_WINS: 'local_wins',
  /** Both changed and neither could be safely discarded. */
  MANUAL: 'manual_required',
  /** Values matched; nothing to settle. */
  NONE: 'none',
})

export const CONFLICT_RESOLUTION_VALUES = Object.freeze(Object.values(CONFLICT_RESOLUTION))

export default SYNC_STATUS
