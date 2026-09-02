/**
 * A record of something that was physically removed.
 *
 * ## Why this collection exists at all
 *
 * Incremental sync answers "what changed since T?" by reading `updatedAt`. That
 * works for every ordinary deletion in this CRM, because every one of them is a
 * *soft* delete — `isDeleted: true` — which bumps `updatedAt` and therefore
 * travels in the feed like any other change. The client sees the flag and drops
 * its copy. No tombstone is needed, and none is written.
 *
 * Two paths are different. Both remove documents outright:
 *
 *   • `leadPurge.service.js`   — "Delete all leads"
 *   • `leadImport.service.js`  — "Undo this import"
 *
 * A removed document has no `updatedAt` to report, so a client that had synced
 * those enquiries would go on displaying them forever. This collection is the
 * only way that deletion can be communicated after the fact.
 *
 * ## Two shapes, deliberately
 *
 * `entityId` set — one record went. The client deletes that id.
 *
 * `entityId` null — every record of that type for that owner went, and the
 * client must resynchronise the entity from scratch. "Delete all leads" removes
 * thousands of documents; writing a tombstone per document would turn one
 * delete into two, and hand the client a page of ids it is going to discard
 * anyway. One row that says *start again* is smaller and stronger.
 *
 * ## Retention
 *
 * A tombstone is only useful to a client whose last sync predates it. A TTL
 * index expires them after ninety days — comfortably longer than any client
 * should be offline, and short enough that this collection cannot grow without
 * bound. A client offline for longer than the window is handled by the
 * `fullResyncRequired` signal, not by keeping tombstones forever.
 *
 * ## What this is not
 *
 * Not an audit log. It records that something was removed and when — never
 * what it contained. `AuditLog` is where deletions are accounted for.
 */

import mongoose from 'mongoose'

/** Entities the sync feed covers. Deliberately the three, and no more. */
export const TOMBSTONE_ENTITY = Object.freeze({
  LEAD: 'lead',
  CONTACT: 'contact',
  COMPANY: 'company',
})

export const TOMBSTONE_ENTITY_VALUES = Object.freeze(Object.values(TOMBSTONE_ENTITY))

/** How long a tombstone stays useful. */
export const TOMBSTONE_RETENTION_DAYS = 90

const syncTombstoneSchema = new mongoose.Schema(
  {
    entityType: {
      type: String,
      enum: TOMBSTONE_ENTITY_VALUES,
      required: true,
    },

    /**
     * The document that went, or null for "all of this type, for this owner".
     *
     * Not a `ref`: the target no longer exists, so a populate could only ever
     * resolve to null and would invite code to try.
     */
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    /**
     * Whose records these were.
     *
     * Required, and the reason the feed can be owner-scoped: a tombstone is
     * only ever handed to the account that owned the record.
     */
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    /** Why it was removed. Free text, for diagnostics only. */
    reason: {
      type: String,
      default: null,
      maxlength: 200,
    },

    deletedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'synctombstones',
  },
)

/**
 * The feed query: this owner's tombstones since a cursor, in cursor order.
 *
 * Same key discipline as the entity feeds — equality first, then the range and
 * sort key, then the tiebreak.
 */
syncTombstoneSchema.index({ owner: 1, deletedAt: 1, _id: 1 }, { name: 'tombstone_sync_feed' })

/**
 * Expiry.
 *
 * `expireAfterSeconds` is measured from `deletedAt`, so a tombstone disappears
 * ninety days after the deletion it records rather than ninety days after it
 * happened to be written.
 */
syncTombstoneSchema.index(
  { deletedAt: 1 },
  { name: 'tombstone_ttl', expireAfterSeconds: TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 },
)

export const SyncTombstone = mongoose.model('SyncTombstone', syncTombstoneSchema)

export default SyncTombstone
