/**
 * A folder inside a synchronised mailbox.
 *
 * Stores both identities deliberately: `providerFolderId` is what the adapter
 * addresses the folder by, and `canonical` is what business logic reads. Keeping
 * the pair together here is what allows a query like "the user's trash" to be
 * answered without any caller knowing that Outlook spells it "Deleted Items".
 *
 * Folders are upserted rather than replaced on each sync, so a folder that
 * disappears at the provider is marked `isDeleted` rather than being dropped —
 * messages already synced from it keep a valid reference.
 */

import mongoose from 'mongoose'

import { FOLDER_LABELS, FOLDER_VALUES, FOLDERS } from '../modules/provider/constants/folderTypes.js'

const { Schema } = mongoose

const mailboxFolderSchema = new Schema(
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

    /** The provider's identifier. Opaque; only the adapter interprets it. */
    providerFolderId: {
      type: String,
      required: true,
      trim: true,
    },

    /** Name as the user sees it in their mail client. Localised by the provider. */
    displayName: {
      type: String,
      required: true,
      trim: true,
    },

    /**
     * Provider-independent identity.
     *
     * `custom` for anything with no equivalent — which is most user-created
     * folders, and is a normal outcome rather than a mapping failure.
     */
    canonical: {
      type: String,
      enum: FOLDER_VALUES,
      default: FOLDERS.CUSTOM,
      index: true,
    },

    /** Graph's `wellKnownName`, kept for diagnostics and re-mapping. */
    wellKnownName: { type: String, trim: true, default: null },

    /** Provider id of the parent, for rebuilding the folder tree. */
    parentFolderId: { type: String, trim: true, default: null },

    totalItemCount: { type: Number, default: 0, min: 0 },
    unreadItemCount: { type: Number, default: 0, min: 0 },

    /**
     * Whether this application synchronises the folder.
     *
     * Custom folders default to false: syncing every folder in a large mailbox
     * by default would be a surprising amount of work on the user's behalf.
     */
    isSyncEnabled: { type: Boolean, default: false },

    /** Set when the folder vanished at the provider. */
    isDeleted: { type: Boolean, default: false },

    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
)

/** Identity of a folder is (mailbox, provider id). */
mailboxFolderSchema.index({ mailbox: 1, providerFolderId: 1 }, { unique: true })

/** Supports "find this mailbox's inbox", the most common lookup. */
mailboxFolderSchema.index({ mailbox: 1, canonical: 1 })

mailboxFolderSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    providerFolderId: this.providerFolderId,
    displayName: this.displayName,
    canonical: this.canonical,
    canonicalLabel: FOLDER_LABELS[this.canonical] ?? this.canonical,
    wellKnownName: this.wellKnownName,
    parentFolderId: this.parentFolderId,
    totalItemCount: this.totalItemCount,
    unreadItemCount: this.unreadItemCount,
    isSyncEnabled: this.isSyncEnabled,
    isDeleted: this.isDeleted,
    lastSyncedAt: this.lastSyncedAt,
  }
}

export const MailboxFolder = mongoose.model('MailboxFolder', mailboxFolderSchema)

export default MailboxFolder
