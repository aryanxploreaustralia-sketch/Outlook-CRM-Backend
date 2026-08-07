/**
 * A unit of assigned work (Phase 18).
 *
 * ## Why a new collection
 *
 * Everything the performance engine reports is *derived* from work the CRM
 * already records — mail sent, enquiries created, campaigns run. A task is not
 * derivable from any of that: it is somebody deciding that a named person
 * should do a named thing by a named date. Nothing in the schema holds that, so
 * it is new data and it needs a home.
 *
 * ## Comments are embedded; attachments are metadata
 *
 * Comments are small, unbounded in count but bounded in practice, and are never
 * read except alongside their task — the textbook case for embedding. They also
 * never need a query of their own, which is the test that matters.
 *
 * Attachments follow the document centre exactly: `storageKey` is a relative
 * path, the bytes live on disk, and the key never leaves the server. A 10 MB
 * file in a BSON array would blow the document ceiling with two of them.
 *
 * ## Deletion is soft
 *
 * A task is evidence about what somebody was asked to do. Deleting the row
 * would remove that evidence and silently change every completion rate that had
 * already been reported. The row stays; `isDeleted` hides it.
 */

import mongoose from 'mongoose'

import {
  MAX_COMMENT_LENGTH,
  TASK_PRIORITY,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_RANK,
  TASK_PRIORITY_VALUES,
  TASK_STATUS,
  TASK_STATUS_LABELS,
  TASK_STATUS_VALUES,
  TERMINAL_TASK_STATUSES,
  isOverdue,
} from '../constants/tasks.js'

const { Schema } = mongoose

/** One comment. Author and text; the timestamp comes from `timestamps`. */
const commentSchema = new Schema(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** Captured at the time, so a deleted account's comments still say who. */
    authorEmail: { type: String, trim: true, default: null },
    authorName: { type: String, trim: true, default: null },
    body: { type: String, required: true, trim: true, maxlength: MAX_COMMENT_LENGTH },
  },
  { timestamps: true, _id: true },
)

/** One attachment. Metadata only — see the note at the top of the file. */
const attachmentSchema = new Schema(
  {
    /** Relative path under the storage root. Never sent to a client. */
    storageKey: { type: String, required: true, trim: true, maxlength: 512 },
    originalFileName: { type: String, required: true, trim: true, maxlength: 256 },
    /** Sniffed from the file's magic numbers, never taken from the request. */
    mimeType: { type: String, required: true, trim: true, maxlength: 128 },
    size: { type: Number, required: true, min: 0 },
    checksum: { type: String, trim: true, default: null },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
)

const taskSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, default: null, maxlength: 5000 },

    /**
     * Who has to do it, and who asked.
     *
     * Both required. A task with no assignee is a note, and a task with no
     * author is an instruction nobody can be asked about.
     */
    assignee: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: {
      type: String,
      enum: TASK_STATUS_VALUES,
      default: TASK_STATUS.TODO,
      index: true,
    },

    priority: {
      type: String,
      enum: TASK_PRIORITY_VALUES,
      default: TASK_PRIORITY.NORMAL,
      index: true,
    },

    /**
     * Denormalised sort weight.
     *
     * Kept in step by a pre-save hook. Stored because "urgent first, then by due
     * date" has to be a database sort — ordering in memory would rank a page
     * against itself rather than against the whole list.
     */
    priorityRank: { type: Number, default: TASK_PRIORITY_RANK[TASK_PRIORITY.NORMAL], index: true },

    /** When it is owed. Optional: not every task has a deadline. */
    dueAt: { type: Date, default: null, index: true },

    /** 0–100, set by hand. Independent of status until the two contradict. */
    progress: { type: Number, default: 0, min: 0, max: 100 },

    /**
     * When it reached a terminal status.
     *
     * Set by the service, not by a hook, because "completed at" must be the
     * moment of the transition rather than the moment of any later save.
     */
    completedAt: { type: Date, default: null, index: true },
    /** Who moved it to its terminal status. */
    completedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    comments: { type: [commentSchema], default: [] },
    attachments: { type: [attachmentSchema], default: [] },

    /** Free-form grouping. No taxonomy is imposed; teams invent their own. */
    tags: { type: [String], default: [] },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

/**
 * The queries this collection actually serves.
 *
 * "My open tasks, most urgent first" and "everything due today" are the two
 * reads on every dashboard, so both are covered by a compound index with the
 * filter fields ahead of the sort fields.
 */
taskSchema.index({ assignee: 1, isDeleted: 1, status: 1, priorityRank: -1, dueAt: 1 })
taskSchema.index({ isDeleted: 1, status: 1, dueAt: 1 })
taskSchema.index({ assignee: 1, completedAt: -1 })
taskSchema.index({ createdBy: 1, isDeleted: 1, createdAt: -1 })

/**
 * Keeps the sort weight honest without asking every call site to remember.
 *
 * No `next` parameter: Mongoose 9 invokes a zero-argument hook and awaits its
 * return, and declaring one gets it called as a function that was never passed.
 */
taskSchema.pre('save', function syncPriorityRank() {
  if (this.isModified('priority')) {
    this.priorityRank = TASK_PRIORITY_RANK[this.priority] ?? TASK_PRIORITY_RANK[TASK_PRIORITY.NORMAL]
  }
})

/**
 * The API shape.
 *
 * `storageKey` is absent by construction — attachments are served by id through
 * an endpoint that resolves the path server-side, so the storage layout is never
 * disclosed and cannot be probed.
 */
taskSchema.methods.toPublicJSON = function toPublicJSON({ viewerId = null } = {}) {
  const viewer = viewerId ? String(viewerId) : null
  const isAssignee = viewer !== null && String(this.assignee) === viewer

  return {
    id: this._id.toString(),
    title: this.title,
    description: this.description ?? null,

    assignee: this.assignee?.toString() ?? null,
    createdBy: this.createdBy?.toString() ?? null,

    status: this.status,
    statusLabel: TASK_STATUS_LABELS[this.status] ?? this.status,
    priority: this.priority,
    priorityLabel: TASK_PRIORITY_LABELS[this.priority] ?? this.priority,
    priorityRank: this.priorityRank,

    dueAt: this.dueAt,
    progress: this.progress,
    isOverdue: isOverdue(this),
    isComplete: TERMINAL_TASK_STATUSES.includes(this.status),
    completedAt: this.completedAt,

    tags: this.tags ?? [],

    comments: (this.comments ?? []).map((comment) => ({
      id: comment._id.toString(),
      author: comment.author?.toString() ?? null,
      authorName: comment.authorName ?? comment.authorEmail ?? 'Unknown user',
      authorEmail: comment.authorEmail ?? null,
      body: comment.body,
      at: comment.createdAt,
      /** Whether the reader wrote it — used to offer deletion of one's own. */
      isMine: viewer !== null && String(comment.author) === viewer,
    })),

    attachments: (this.attachments ?? []).map((attachment) => ({
      id: attachment._id.toString(),
      fileName: attachment.originalFileName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      uploadedAt: attachment.uploadedAt,
      uploadedBy: attachment.uploadedBy?.toString() ?? null,
    })),

    /**
     * What this reader may do, decided server-side.
     *
     * The client renders from these rather than re-deriving "am I the
     * assignee" — one rule, in one place, and the endpoints enforce the same
     * thing regardless of what was drawn.
     */
    canUpdateStatus: isAssignee,
    canComment: true,

    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

export const Task = mongoose.model('Task', taskSchema)

export default Task
