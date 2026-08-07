/**
 * Resumable synchronisation state, one record per folder.
 *
 * ## Why per-folder rather than per-mailbox
 *
 * Delta tokens are issued per folder by every provider that offers them. A
 * single mailbox-level token could not express "inbox is current but archive
 * failed halfway", so a failure in one folder would force a full resync of all
 * of them — turning a transient error into hours of redundant transfer.
 *
 * ## Delta tokens expire
 *
 * Graph invalidates a delta token after roughly 30 days, and immediately if the
 * mailbox is moved between servers. Replaying a stale one returns HTTP 410, which
 * the adapter translates to `DELTA_TOKEN_EXPIRED`. That is a normal, expected
 * event — not an error — and the engine responds by clearing the token and
 * falling back to a full sync. `fullResyncRequired` records that intent so the
 * fallback survives a restart.
 */

import mongoose from 'mongoose'

import { SYNC_STATUS, SYNC_STATUS_VALUES } from '../modules/provider/constants/syncStatus.js'
import { FOLDER_VALUES } from '../modules/provider/constants/folderTypes.js'

const { Schema } = mongoose

const syncStateSchema = new Schema(
  {
    mailbox: {
      type: Schema.Types.ObjectId,
      ref: 'Mailbox',
      required: true,
      index: true,
    },

    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    folder: {
      type: String,
      enum: FOLDER_VALUES,
      required: true,
    },

    /** Provider folder id, so the adapter can address it without a join. */
    providerFolderId: { type: String, trim: true, default: null },

    /**
     * Opaque resume token from the provider.
     *
     * Never parsed. Graph embeds a `$deltatoken` query parameter in a URL;
     * treating it as anything other than a string to hand back verbatim would
     * break the moment Microsoft changed the format.
     */
    lastDeltaToken: { type: String, default: null },

    lastSyncAt: { type: Date, default: null },
    lastSuccessfulSyncAt: { type: Date, default: null },

    syncStatus: {
      type: String,
      enum: SYNC_STATUS_VALUES,
      default: SYNC_STATUS.IDLE,
      index: true,
    },

    lastError: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      occurredAt: { type: Date, default: null },
    },

    /** Set when the delta token was rejected; cleared once a full sync completes. */
    fullResyncRequired: { type: Boolean, default: false },

    /** Cumulative counters across all runs for this folder. */
    messagesSynced: { type: Number, default: 0, min: 0 },
    consecutiveFailures: { type: Number, default: 0, min: 0 },

    /**
     * Guards against two runs syncing one folder at once.
     *
     * Held as a timestamp rather than a boolean so a lock left behind by a
     * crashed process expires on its own — a boolean would wedge the folder
     * permanently and require manual intervention.
     */
    lockedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
)

/** One state record per folder per mailbox. */
syncStateSchema.index({ mailbox: 1, folder: 1 }, { unique: true })

/** Locks older than this are treated as abandoned. */
export const SYNC_LOCK_TTL_MS = 15 * 60 * 1000

syncStateSchema.methods.isLocked = function isLocked() {
  if (!this.lockedAt) return false
  return Date.now() - this.lockedAt.getTime() < SYNC_LOCK_TTL_MS
}

syncStateSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    folder: this.folder,
    providerFolderId: this.providerFolderId,
    /** The token itself is never exposed — only whether one exists. */
    hasDeltaToken: Boolean(this.lastDeltaToken),
    lastSyncAt: this.lastSyncAt,
    lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
    syncStatus: this.syncStatus,
    lastError: this.lastError?.code ? this.lastError : null,
    fullResyncRequired: this.fullResyncRequired,
    messagesSynced: this.messagesSynced,
    consecutiveFailures: this.consecutiveFailures,
    isLocked: this.isLocked(),
  }
}

export const SyncState = mongoose.model('SyncState', syncStateSchema)

export default SyncState
