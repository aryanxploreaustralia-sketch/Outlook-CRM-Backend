/**
 * An employee's uploaded document — metadata only.
 *
 * ## The bytes are never here
 *
 * `storageKey` is a **relative** path under `config.storage.documents`. The file
 * itself sits on disk, exactly as conversation attachments and uploaded
 * workbooks already do. Putting a 10 MB identity document in a BSON field would
 * blow the 16 MB document ceiling with two files, make every `find()` on this
 * collection drag megabytes through the driver, and put personal identity
 * documents into every database backup and every replica-set oplog entry.
 *
 * Relative rather than absolute so the storage root can move — a different disk,
 * a different container mount — without rewriting every row.
 *
 * ## Why a separate collection rather than an array on `User`
 *
 * The profile fields are one-to-one with the account and are read on nearly
 * every screen showing a person, so they live on `User`. Documents are
 * one-to-many, read rarely, and carry a verification lifecycle with its own
 * actor and timestamps. Embedding them would load five documents' metadata on
 * every sign-in, and would make "find every pending document across the
 * organization" — the reviewer's only real query — a collection scan with
 * `$unwind` instead of one indexed read.
 *
 * ## Deletion
 *
 * Soft, via `isDeleted`. A verified identity document that an employee could
 * make vanish is not a record anybody can rely on, and the verification history
 * has to outlive the file. The bytes are unlinked from disk; the row stays.
 */

import mongoose from 'mongoose'

import {
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_CATEGORY_VALUES,
  DOCUMENT_STATUS,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_STATUS_VALUES,
} from '../constants/employeeProfile.js'

const { Schema } = mongoose

const userDocumentSchema = new Schema(
  {
    /** Whose document. Every query is scoped by this. */
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, enum: DOCUMENT_CATEGORY_VALUES, required: true, index: true },
    description: { type: String, trim: true, default: null, maxlength: 512 },

    /**
     * Relative path under the documents storage root.
     *
     * Never sent to a client. The download endpoint streams the file by id, so
     * the path stays server-side and cannot be probed or guessed.
     */
    storageKey: { type: String, required: true, trim: true, maxlength: 512 },

    /**
     * What the employee called the file.
     *
     * Kept separate from `storageKey`, which is generated. A user-supplied
     * filename is attacker-controlled text — it must never reach the
     * filesystem, and it is only echoed back on download as a
     * `Content-Disposition` value.
     */
    originalFileName: { type: String, required: true, trim: true, maxlength: 256 },

    mimeType: { type: String, required: true, trim: true, maxlength: 128 },
    size: { type: Number, required: true, min: 0 },

    /** Detects a file replaced on disk out from under the record. */
    checksum: { type: String, trim: true, default: null },

    // --- Verification -------------------------------------------------------

    status: {
      type: String,
      enum: DOCUMENT_STATUS_VALUES,
      default: DOCUMENT_STATUS.PENDING,
      index: true,
    },

    /** Who decided, and when. Null while pending. */
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    verifiedByEmail: { type: String, trim: true, default: null },
    verifiedAt: { type: Date, default: null },

    /**
     * The reviewer's note.
     *
     * Required by the service when rejecting — a rejection with no reason gives
     * the employee nothing to act on, and they cannot ask the reviewer what
     * they meant three weeks later.
     */
    remarks: { type: String, trim: true, default: null, maxlength: 512 },

    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedAt: { type: Date, default: Date.now },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
)

/** The employee's own list, and the count that enforces the five-file cap. */
userDocumentSchema.index({ user: 1, isDeleted: 1, uploadedAt: -1 })

/** "Everything waiting for review", the only cross-user query this collection has. */
userDocumentSchema.index({ status: 1, uploadedAt: -1 })

/**
 * The client shape.
 *
 * `storageKey` is deliberately absent. A client that knows the path on disk is
 * a client one traversal bug away from reading somebody else's passport.
 */
userDocumentSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    title: this.title,
    category: this.category,
    categoryLabel: DOCUMENT_CATEGORY_LABELS[this.category] ?? this.category,
    description: this.description,

    originalFileName: this.originalFileName,
    mimeType: this.mimeType,
    size: this.size,

    status: this.status,
    statusLabel: DOCUMENT_STATUS_LABELS[this.status] ?? this.status,
    remarks: this.remarks,
    verifiedByEmail: this.verifiedByEmail,
    verifiedAt: this.verifiedAt,

    uploadedAt: this.uploadedAt,

    /**
     * What the *employee* may do with it, decided here rather than in React.
     *
     * A verified document is frozen: allowing a replace would let somebody
     * swap approved identity evidence for something else after the fact, which
     * is the one thing verification is supposed to prevent.
     */
    canReplace: this.status !== DOCUMENT_STATUS.VERIFIED,
    canDelete: this.status === DOCUMENT_STATUS.PENDING,
  }
}

export const UserDocument = mongoose.model('UserDocument', userDocumentSchema)

export default UserDocument
