/**
 * The admin calendar: what is happening, by date.
 *
 * ## Counts, not rows
 *
 * A month grid needs one number per day per type — about 150 integers. Fetching
 * the underlying records to count them in the browser would mean shipping every
 * enquiry travelling that month (5,844 have a travel date in this deployment)
 * to render thirty dots. So the grouping happens in MongoDB and the response is
 * a few hundred bytes regardless of how busy the month is.
 *
 * The day drawer is the only thing that reads records, and only for one date.
 *
 * ## The four sources are real, and three of them are empty today
 *
 * Travel comes from `Lead.travelDate`. The other three come from the task
 * models the CRM already has: `LeadTask` split by its own `isFollowUp` flag,
 * and `Task` for internal assignments. `LeadTask` and `Task` currently hold no
 * documents at all, so the calendar shows travel and nothing else — which is
 * the honest result. Nothing here invents an event to fill the grid, and the
 * moment a follow-up is raised it appears without another line of code.
 *
 * ## Timezones, which are not decorative here
 *
 * `travelDate` is a date, not an instant: the workbook importer stores it at
 * exactly 00:00:00 UTC. It is therefore grouped in **UTC**, always. Grouping it
 * in a western timezone would move every departure to the previous day — the
 * same trap `frontend/src/utils/datetime.js` documents for display.
 *
 * `dueAt` is a real instant chosen by a person, so it is grouped in the
 * caller's timezone. A task due at 03:00 in Kolkata belongs on that date in
 * that reader's calendar, not on the previous one because UTC says so.
 */

import { Lead } from '../../../models/lead.model.js'
import { LeadTask } from '../../../models/leadTask.model.js'
import { Task } from '../../../models/task.model.js'
import { User } from '../../../models/user.model.js'
import { TERMINAL_TASK_STATUSES } from '../../../constants/tasks.js'
import { TASK_STATUS } from '../../conversations/constants/conversationConstants.js'

/** How many records of one type the day drawer returns. The UI links onward. */
const DAY_SAMPLE = 25

/** Resolves user ids to display names in one query. Mirrors the monitor's. */
async function nameMap(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))]
  if (unique.length === 0) return new Map()

  const users = await User.find({ _id: { $in: unique } })
    .select('displayName email')
    .lean()

  return new Map(
    users.map((user) => [String(user._id), user.displayName ?? user.email ?? 'Unknown user']),
  )
}

/** Midnight UTC on the given `YYYY-MM-DD`, and the last millisecond of it. */
const startOf = (date) => new Date(`${date}T00:00:00.000Z`)
const endOf = (date) => new Date(`${date}T23:59:59.999Z`)

/**
 * One `$group` stage keyed by calendar day.
 *
 * `$dateToString` rather than `$dateTrunc` so the key is already the
 * `YYYY-MM-DD` the client indexes by, with no second conversion able to
 * disagree with this one.
 */
const byDay = (field, timezone) => [
  { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone } }, count: { $sum: 1 } } },
]

/**
 * Tasks that still need doing.
 *
 * A calendar is a plan, and something already done or cancelled is not part of
 * one. Both task models are filtered to their own open statuses rather than to
 * a shared list, because they define them separately.
 */
const OPEN_LEAD_TASK = { $nin: [TASK_STATUS.DONE, TASK_STATUS.CANCELLED] }
const OPEN_TASK = { $nin: [...TERMINAL_TASK_STATUSES] }

/**
 * Per-day counts across a date range.
 *
 * @param {{ from: string, to: string, timezone: string }} query `YYYY-MM-DD`.
 */
export async function getAdminCalendar({ from, to, timezone = 'UTC' }) {
  const lower = startOf(from)
  const upper = endOf(to)

  const inRange = { $gte: lower, $lte: upper }

  const [travel, followUp, activity, task] = await Promise.all([
    // UTC: `travelDate` is a date-only value stored at midnight UTC.
    Lead.aggregate([
      { $match: { isDeleted: false, travelDate: inRange } },
      ...byDay('travelDate', 'UTC'),
    ]),
    LeadTask.aggregate([
      { $match: { isDeleted: false, isFollowUp: true, status: OPEN_LEAD_TASK, dueAt: inRange } },
      ...byDay('dueAt', timezone),
    ]),
    LeadTask.aggregate([
      { $match: { isDeleted: false, isFollowUp: false, status: OPEN_LEAD_TASK, dueAt: inRange } },
      ...byDay('dueAt', timezone),
    ]),
    Task.aggregate([
      { $match: { isDeleted: false, status: OPEN_TASK, dueAt: inRange } },
      ...byDay('dueAt', timezone),
    ]),
  ])

  /*
   * Merged into one row per date that has anything at all.
   *
   * Dates with nothing are deliberately absent rather than present as zeroes:
   * the grid renders every cell itself, and a month of empty rows would be most
   * of the payload for none of the information.
   */
  const days = new Map()
  const fold = (rows, key) => {
    for (const row of rows) {
      if (!row._id) continue
      const day = days.get(row._id) ?? { date: row._id, travel: 0, followUp: 0, activity: 0, task: 0 }
      day[key] = row.count
      days.set(row._id, day)
    }
  }

  fold(travel, 'travel')
  fold(followUp, 'followUp')
  fold(activity, 'activity')
  fold(task, 'task')

  const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  const sum = (key) => rows.reduce((total, day) => total + day[key], 0)

  return {
    from,
    to,
    timezone,
    days: rows,
    totals: {
      travel: sum('travel'),
      followUp: sum('followUp'),
      activity: sum('activity'),
      task: sum('task'),
    },
  }
}

/**
 * One day, in detail.
 *
 * Each list is capped at `DAY_SAMPLE`; the count beside it is the true total,
 * so the drawer can say "showing 25 of 61" rather than quietly implying the day
 * holds 25. The full set is the Lead monitor's job, one click away.
 */
export async function getAdminCalendarDay({ date, timezone = 'UTC' }) {
  const lower = startOf(date)
  const upper = endOf(date)
  const inRange = { $gte: lower, $lte: upper }

  /*
   * The task window is the caller's day, expressed as instants.
   *
   * The counts endpoint groups `dueAt` by the reader's timezone, so this must
   * select the same span or a day could show a number in the grid and a
   * different set of rows when opened.
   */
  const taskWindow = (() => {
    if (timezone === 'UTC') return inRange

    // The offset that timezone had at midday on the date in question, which
    // avoids the ambiguity of asking on a DST boundary at midnight.
    const noon = new Date(`${date}T12:00:00.000Z`)
    const local = new Date(noon.toLocaleString('en-US', { timeZone: timezone }))
    const offsetMs = local.getTime() - noon.getTime()

    return { $gte: new Date(lower.getTime() - offsetMs), $lte: new Date(upper.getTime() - offsetMs) }
  })()

  const openLeadTask = { isDeleted: false, status: OPEN_LEAD_TASK, dueAt: taskWindow }

  const [travelRows, travelTotal, followUps, followUpTotal, activities, activityTotal, tasks, taskTotal] =
    await Promise.all([
      Lead.find({ isDeleted: false, travelDate: inRange })
        .select('reference contactPerson companyName market owner stage travelDate travelDateText')
        .sort({ travelDate: 1, _id: 1 })
        .limit(DAY_SAMPLE)
        .lean(),
      Lead.countDocuments({ isDeleted: false, travelDate: inRange }),

      LeadTask.find({ ...openLeadTask, isFollowUp: true })
        .select('title type dueAt assignedTo owner lead priority')
        .sort({ dueAt: 1, _id: 1 })
        .limit(DAY_SAMPLE)
        .lean(),
      LeadTask.countDocuments({ ...openLeadTask, isFollowUp: true }),

      LeadTask.find({ ...openLeadTask, isFollowUp: false })
        .select('title type dueAt assignedTo owner lead priority')
        .sort({ dueAt: 1, _id: 1 })
        .limit(DAY_SAMPLE)
        .lean(),
      LeadTask.countDocuments({ ...openLeadTask, isFollowUp: false }),

      Task.find({ isDeleted: false, status: OPEN_TASK, dueAt: taskWindow })
        .select('title dueAt assignee priority status')
        .sort({ dueAt: 1, _id: 1 })
        .limit(DAY_SAMPLE)
        .lean(),
      Task.countDocuments({ isDeleted: false, status: OPEN_TASK, dueAt: taskWindow }),
    ])

  const names = await nameMap([
    ...travelRows.map((lead) => lead.owner),
    ...followUps.map((row) => row.assignedTo ?? row.owner),
    ...activities.map((row) => row.assignedTo ?? row.owner),
    ...tasks.map((row) => row.assignee),
  ])

  const owner = (id) => (id ? (names.get(String(id)) ?? null) : null)

  /** A task row, in the one shape the drawer renders for all three kinds. */
  const asItem = (row, ownerId) => ({
    id: String(row._id),
    title: row.title,
    type: row.type ?? null,
    // Null where the record genuinely carries no time. The client renders those
    // as all-day rather than inventing one.
    dueAt: row.dueAt ?? null,
    priority: row.priority ?? null,
    lead: row.lead ? String(row.lead) : null,
    owner: owner(ownerId),
  })

  return {
    date,
    timezone,
    travel: {
      total: travelTotal,
      items: travelRows.map((lead) => ({
        id: String(lead._id),
        reference: lead.reference,
        customer: lead.contactPerson ?? lead.companyName ?? null,
        market: lead.market ?? null,
        stage: lead.stage ?? null,
        travelDate: lead.travelDate,
        travelDateText: lead.travelDateText ?? null,
        owner: owner(lead.owner),
      })),
    },
    followUp: { total: followUpTotal, items: followUps.map((row) => asItem(row, row.assignedTo ?? row.owner)) },
    activity: { total: activityTotal, items: activities.map((row) => asItem(row, row.assignedTo ?? row.owner)) },
    task: { total: taskTotal, items: tasks.map((row) => asItem(row, row.assignee)) },
  }
}

export default { getAdminCalendar, getAdminCalendarDay }
