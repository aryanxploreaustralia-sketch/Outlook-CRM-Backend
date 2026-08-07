/**
 * A target placed against a measurement the CRM already takes (Phase 18).
 *
 * ## What is stored, and what is emphatically not
 *
 * The row holds the **target** and the **window**: who, which metric, how much,
 * and over what period. It holds no progress, no achieved figure and no
 * percentage.
 *
 * That is the central decision of this model. Progress is read from the Phase
 * 17.3 performance engine at the moment it is asked for, which means a goal can
 * never disagree with the dashboard beside it. Storing a snapshot would create
 * a second version of "emails sent this month" that drifts the first time a
 * message is deleted, a window is corrected, or the job that was meant to
 * refresh it does not run.
 *
 * The one exception is `achievedAt`, which is a fact about *when a threshold
 * was first crossed* rather than a copy of a measurement. It exists so the
 * "goal achieved" notification fires once instead of on every read.
 *
 * ## The window is stored, not derived
 *
 * `periodStart` and `periodEnd` are written from `goalWindow()` at creation.
 * Deriving them on read would silently re-point last month's goal at this month
 * the moment the calendar turned, and a missed goal would quietly become an
 * outstanding one.
 */

import mongoose from 'mongoose'

import {
  GOAL_METRIC_DEFINITIONS,
  GOAL_METRIC_VALUES,
  GOAL_PERIOD_LABELS,
  GOAL_PERIOD_VALUES,
} from '../constants/tasks.js'

const { Schema } = mongoose

const goalSchema = new Schema(
  {
    /** Whose goal. Every query is scoped by this. */
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Who set it. An employee may not set their own; see the service. */
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    period: { type: String, enum: GOAL_PERIOD_VALUES, required: true, index: true },
    metric: { type: String, enum: GOAL_METRIC_VALUES, required: true },

    /** How much, in the metric's own unit. Minutes for working time. */
    target: { type: Number, required: true, min: 1 },

    periodStart: { type: Date, required: true, index: true },
    periodEnd: { type: Date, required: true, index: true },

    /** Optional note from whoever set it — context the number cannot carry. */
    note: { type: String, trim: true, default: null, maxlength: 512 },

    /**
     * When the target was first met.
     *
     * A latch, not a status: once crossed it stays set even if a later
     * recomputation dips below the line, because "you hit it on the 14th" does
     * not stop being true. Its only job is to make the notification fire once.
     */
    achievedAt: { type: Date, default: null },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true, versionKey: false },
)

/**
 * One live goal per person, per metric, per window.
 *
 * Partial, so soft-deleted rows do not hold the slot — the same pattern the
 * user indexes use. Without it, two administrators setting a monthly email
 * target on the same person produce two goals and two different answers to
 * "did they hit it".
 */
goalSchema.index(
  { user: 1, metric: 1, period: 1, periodStart: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
)

/** "This person's current goals" — the read behind every goal widget. */
goalSchema.index({ user: 1, isDeleted: 1, periodEnd: -1 })

/**
 * The API shape, **without** progress.
 *
 * Progress is joined on by the goal service from live metrics. Serialising it
 * here would require the model to reach into the performance engine, which is
 * how a schema ends up depending on a reporting module.
 */
goalSchema.methods.toPublicJSON = function toPublicJSON() {
  const definition = GOAL_METRIC_DEFINITIONS[this.metric] ?? null

  return {
    id: this._id.toString(),
    user: this.user?.toString() ?? null,
    createdBy: this.createdBy?.toString() ?? null,

    period: this.period,
    periodLabel: GOAL_PERIOD_LABELS[this.period] ?? this.period,
    metric: this.metric,
    metricLabel: definition?.label ?? this.metric,
    unit: definition?.unit ?? null,
    /** Present only where the stored unit is not the one people speak in. */
    displayDivisor: definition?.displayDivisor ?? null,
    displayUnit: definition?.displayUnit ?? null,

    target: this.target,
    periodStart: this.periodStart,
    periodEnd: this.periodEnd,
    note: this.note ?? null,
    achievedAt: this.achievedAt,

    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  }
}

export const Goal = mongoose.model('Goal', goalSchema)

export default Goal
