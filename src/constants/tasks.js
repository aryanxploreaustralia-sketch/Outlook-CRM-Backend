/**
 * Tasks, goals and their vocabularies (Phase 18).
 *
 * Part of the API contract: the console filters on these strings and the client
 * matches on them, so they must not be renamed once published — the same rule
 * `mailStatus.js` and the audit registry follow.
 *
 * ## Why a constants file rather than enums on the schema
 *
 * The labels, the transitions and the "which statuses count as finished" rule
 * are needed by the service, the DTO, the goal engine and the performance
 * engine. A schema enum answers only the first of those.
 */

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Where a task is.
 *
 * Four states, deliberately. A longer workflow invites a status per team habit
 * and then nobody agrees what "in review" means; four can be held in the head
 * and each one answers a different question.
 */
export const TASK_STATUS = Object.freeze({
  /** Assigned, not started. */
  TODO: 'todo',
  /** Somebody is working on it now. */
  IN_PROGRESS: 'in_progress',
  /** Finished. Terminal, and the only state that counts as completed work. */
  DONE: 'done',
  /**
   * Called off. Terminal, and **not** a completion.
   *
   * Separate from `done` because a completion rate that counts cancellations as
   * successes is a number that rewards abandoning work.
   */
  CANCELLED: 'cancelled',
})

export const TASK_STATUS_VALUES = Object.freeze(Object.values(TASK_STATUS))

export const TASK_STATUS_LABELS = Object.freeze({
  [TASK_STATUS.TODO]: 'To do',
  [TASK_STATUS.IN_PROGRESS]: 'In progress',
  [TASK_STATUS.DONE]: 'Done',
  [TASK_STATUS.CANCELLED]: 'Cancelled',
})

/** Statuses that mean the task is finished, one way or the other. */
export const TERMINAL_TASK_STATUSES = Object.freeze([TASK_STATUS.DONE, TASK_STATUS.CANCELLED])

/** Statuses that still need somebody's attention. */
export const OPEN_TASK_STATUSES = Object.freeze([TASK_STATUS.TODO, TASK_STATUS.IN_PROGRESS])

/**
 * How urgent.
 *
 * Ordered so a sort can use the number without a lookup table, and so "urgent
 * first" is `-1` on one field rather than a `$switch` in every pipeline.
 */
export const TASK_PRIORITY = Object.freeze({
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
})

export const TASK_PRIORITY_VALUES = Object.freeze(Object.values(TASK_PRIORITY))

export const TASK_PRIORITY_LABELS = Object.freeze({
  [TASK_PRIORITY.LOW]: 'Low',
  [TASK_PRIORITY.NORMAL]: 'Normal',
  [TASK_PRIORITY.HIGH]: 'High',
  [TASK_PRIORITY.URGENT]: 'Urgent',
})

/** Sort weight. Higher is more urgent. Stored, so the database can order by it. */
export const TASK_PRIORITY_RANK = Object.freeze({
  [TASK_PRIORITY.LOW]: 1,
  [TASK_PRIORITY.NORMAL]: 2,
  [TASK_PRIORITY.HIGH]: 3,
  [TASK_PRIORITY.URGENT]: 4,
})

/** At most this many attachments per task. The same ceiling documents use. */
export const MAX_TASK_ATTACHMENTS = 5

/** 10 MB, matching the document centre — one upload limit across the product. */
export const MAX_TASK_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Comments are a conversation, not an essay. */
export const MAX_COMMENT_LENGTH = 2000

/**
 * Whether a task is late.
 *
 * A finished task is never overdue, however long it sat there: overdue is a
 * statement about work still owed, and marking completed work red teaches
 * people to ignore the colour.
 */
export function isOverdue(task, now = new Date()) {
  if (!task?.dueAt) return false
  if (TERMINAL_TASK_STATUSES.includes(task.status)) return false

  return new Date(task.dueAt).getTime() < now.getTime()
}

/**
 * The progress a status implies, when nobody has set one.
 *
 * Only ever used as a floor for `done` and a ceiling for `todo` — a task marked
 * done at 40% is a contradiction, and one of the two numbers has to give. The
 * status wins, because it is the thing a person deliberately chose.
 */
export function progressForStatus(status, progress = 0) {
  if (status === TASK_STATUS.DONE) return 100
  if (status === TASK_STATUS.TODO && progress === 100) return 0

  return progress
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/** How long a goal runs for. */
export const GOAL_PERIOD = Object.freeze({
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
})

export const GOAL_PERIOD_VALUES = Object.freeze(Object.values(GOAL_PERIOD))

export const GOAL_PERIOD_LABELS = Object.freeze({
  [GOAL_PERIOD.DAILY]: 'Daily',
  [GOAL_PERIOD.WEEKLY]: 'Weekly',
  [GOAL_PERIOD.MONTHLY]: 'Monthly',
})

/**
 * What a goal can be set on.
 *
 * ## Every metric here is one the CRM already measures
 *
 * Each maps to a field the Phase 17.3 performance engine produces, named in
 * `metric`. That is the whole design: a goal is a **target placed against an
 * existing measurement**, never a new measurement. Nothing about progress is
 * stored or recomputed — it is read from the same engine the dashboards read,
 * so a goal cannot disagree with the performance screen beside it.
 *
 * A metric the CRM cannot measure honestly is not offered. There is no "emails
 * delivered" goal, because Microsoft does not report delivery.
 */
export const GOAL_METRIC = Object.freeze({
  EMAILS_SENT: 'emailsSent',
  REPLIES: 'replies',
  CAMPAIGNS: 'campaigns',
  LEADS_CREATED: 'leadsCreated',
  LEADS_CONVERTED: 'leadsConverted',
  WORKING_MINUTES: 'workingMinutes',
  TASKS_COMPLETED: 'tasksCompleted',
})

export const GOAL_METRIC_VALUES = Object.freeze(Object.values(GOAL_METRIC))

/**
 * Label, unit and the engine field each metric reads.
 *
 * `source` is the key on `performanceRows()`' metrics object. Held here so the
 * goal engine is a lookup rather than a switch, and so adding a metric is one
 * entry rather than an edit in three files.
 */
export const GOAL_METRIC_DEFINITIONS = Object.freeze({
  [GOAL_METRIC.EMAILS_SENT]: { label: 'Emails sent', unit: 'emails', source: 'emailsSent' },
  [GOAL_METRIC.REPLIES]: { label: 'Replies received', unit: 'replies', source: 'replies' },
  [GOAL_METRIC.CAMPAIGNS]: { label: 'Campaigns created', unit: 'campaigns', source: 'campaigns' },
  [GOAL_METRIC.LEADS_CREATED]: { label: 'Enquiries created', unit: 'enquiries', source: 'leadsCreated' },
  [GOAL_METRIC.LEADS_CONVERTED]: { label: 'Enquiries converted', unit: 'enquiries', source: 'leadsConverted' },
  [GOAL_METRIC.WORKING_MINUTES]: {
    label: 'Working hours',
    unit: 'minutes',
    source: 'workingMinutes',
    /** Set and read in hours; stored and compared in minutes. */
    displayDivisor: 60,
    displayUnit: 'hours',
  },
  [GOAL_METRIC.TASKS_COMPLETED]: { label: 'Tasks completed', unit: 'tasks', source: 'tasksCompleted' },
})

/**
 * The window a goal covers, from any date inside it.
 *
 * UTC throughout, matching every other window in this codebase — a goal that
 * shifted with the reader's timezone would be achieved in one office and missed
 * in another on the same figures. The week starts on Monday, as `$dateTrunc`
 * does elsewhere.
 *
 * @param {string} period
 * @param {Date|string} [anchor] Any moment inside the wanted period.
 * @returns {{ from: Date, to: Date }}
 */
export function goalWindow(period, anchor = new Date()) {
  const from = new Date(anchor)
  from.setUTCHours(0, 0, 0, 0)

  if (period === GOAL_PERIOD.WEEKLY) {
    const day = from.getUTCDay()
    from.setUTCDate(from.getUTCDate() - (day === 0 ? 6 : day - 1))
  }

  if (period === GOAL_PERIOD.MONTHLY) from.setUTCDate(1)

  const to = new Date(from)

  if (period === GOAL_PERIOD.DAILY) to.setUTCDate(to.getUTCDate() + 1)
  else if (period === GOAL_PERIOD.WEEKLY) to.setUTCDate(to.getUTCDate() + 7)
  else to.setUTCMonth(to.getUTCMonth() + 1)

  // One millisecond before the next period starts, so the windows tile without
  // overlapping — a task completed at midnight belongs to exactly one of them.
  to.setUTCMilliseconds(to.getUTCMilliseconds() - 1)

  return { from, to }
}

export default {
  GOAL_METRIC,
  GOAL_METRIC_DEFINITIONS,
  GOAL_PERIOD,
  MAX_TASK_ATTACHMENTS,
  TASK_PRIORITY,
  TASK_STATUS,
  goalWindow,
  isOverdue,
  progressForStatus,
}
