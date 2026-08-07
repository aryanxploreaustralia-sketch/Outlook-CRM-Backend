/**
 * A task or follow-up raised against an enquiry.
 *
 * One model for both. A follow-up *is* a task whose whole content is "come back
 * to this on Thursday" — splitting them would mean two collections, two list
 * screens and two sets of overdue logic answering the same question: what does
 * this salesperson owe, and when.
 *
 * `isFollowUp` distinguishes them for the UI's quick-pick buttons.
 */

import mongoose from 'mongoose'

import {
  TASK_PRIORITY,
  TASK_PRIORITY_VALUES,
  TASK_STATUS,
  TASK_STATUS_VALUES,
  TASK_TYPE,
  TASK_TYPE_LABELS,
  TASK_TYPE_VALUES,
} from '../modules/conversations/constants/conversationConstants.js'

const { Schema } = mongoose

const leadTaskSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    lead: { type: Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null, index: true },
    company: { type: Schema.Types.ObjectId, ref: 'Company', default: null, index: true },

    /** The reply that prompted it, when the task was raised from a message. */
    message: { type: Schema.Types.ObjectId, ref: 'ConversationMessage', default: null },

    type: { type: String, enum: TASK_TYPE_VALUES, default: TASK_TYPE.OTHER, index: true },
    title: { type: String, required: true, trim: true, maxlength: 256 },
    notes: { type: String, trim: true, default: null, maxlength: 4000 },

    status: { type: String, enum: TASK_STATUS_VALUES, default: TASK_STATUS.OPEN, index: true },
    priority: { type: String, enum: TASK_PRIORITY_VALUES, default: TASK_PRIORITY.NORMAL, index: true },

    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    dueAt: { type: Date, default: null, index: true },

    /** A quick-pick follow-up rather than a piece of work. */
    isFollowUp: { type: Boolean, default: false, index: true },

    /**
     * Whether the due reminder has fired.
     *
     * Persisted rather than derived from `dueAt < now`, so a reminder is sent
     * exactly once. A derived check would re-notify on every sweep until
     * somebody closed the task.
     */
    reminderSentAt: { type: Date, default: null },

    completedAt: { type: Date, default: null },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, versionKey: false },
)

/** The work list: what is open, soonest first. */
leadTaskSchema.index({ owner: 1, status: 1, dueAt: 1 })

/** "Assigned to me". */
leadTaskSchema.index({ owner: 1, assignedTo: 1, status: 1, dueAt: 1 })

/** A lead's tasks. */
leadTaskSchema.index({ owner: 1, lead: 1, createdAt: -1 })

/** The reminder sweep: due, open, not yet reminded. */
leadTaskSchema.index({ status: 1, dueAt: 1, reminderSentAt: 1 })

leadTaskSchema.methods.isOverdue = function isOverdue() {
  if (!this.dueAt) return false
  if ([TASK_STATUS.DONE, TASK_STATUS.CANCELLED].includes(this.status)) return false
  return this.dueAt.getTime() < Date.now()
}

/** Whole days until due; negative when overdue, null when there is no date. */
leadTaskSchema.methods.daysUntilDue = function daysUntilDue() {
  if (!this.dueAt) return null
  return Math.ceil((this.dueAt.getTime() - Date.now()) / 86_400_000)
}

leadTaskSchema.methods.complete = function complete(userId = null) {
  this.status = TASK_STATUS.DONE
  this.completedAt = new Date()
  this.completedBy = userId
  return this
}

leadTaskSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    type: this.type,
    typeLabel: TASK_TYPE_LABELS[this.type] ?? this.type,
    title: this.title,
    notes: this.notes,
    status: this.status,
    priority: this.priority,
    isFollowUp: this.isFollowUp,
    lead: this.lead?.toString() ?? null,
    conversation: this.conversation?.toString() ?? null,
    company: this.company?.toString() ?? null,
    message: this.message?.toString() ?? null,
    assignedTo: this.assignedTo?.toString() ?? null,
    createdBy: this.createdBy?.toString() ?? null,
    dueAt: this.dueAt,
    isOverdue: this.isOverdue(),
    daysUntilDue: this.daysUntilDue(),
    completedAt: this.completedAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

export const LeadTask = mongoose.model('LeadTask', leadTaskSchema)

export default LeadTask
