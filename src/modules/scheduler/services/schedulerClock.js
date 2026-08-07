/**
 * Timezone arithmetic for the scheduler.
 *
 * ## Why there is no cron library here
 *
 * The requirement is "09:00 in Asia/Kolkata, every day". A cron expression
 * cannot express a timezone at all — `0 9 * * *` means nine o'clock wherever the
 * server happens to be, which is exactly the bug this module exists to avoid:
 * the same deployment moved from a Mumbai VM to a Frankfurt one would silently
 * start emailing customers at half past one in the afternoon.
 *
 * ## Why there is no date library either
 *
 * Node ships a full IANA timezone database through `Intl`. Everything below is
 * derived from it. The whole file is four functions, and adding `luxon` or
 * `node-cron` would mean an operational dependency for arithmetic the platform
 * already does correctly.
 *
 * ## The one trick worth explaining
 *
 * `Intl` converts *an instant into a wall clock*. The scheduler also needs the
 * reverse — "what instant is 09:00 tomorrow in Kolkata?" — which `Intl` does not
 * offer. `occurrenceUtc` recovers it by guessing, measuring the zone's offset at
 * the guess, and correcting. Twice, because near a DST transition the offset at
 * the guess can differ from the offset at the answer.
 */

import { RUN_TIME_PATTERN } from '../constants/schedulerConstants.js'

/** Reused per zone: constructing a formatter is the expensive part. */
const formatterCache = new Map()

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone)

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      // `hourCycle` rather than `hour12: false`, which yields "24" for midnight
      // in some ICU builds and would put every date one day out.
      hourCycle: 'h23',
    })
    formatterCache.set(timeZone, formatter)
  }

  return formatter
}

/**
 * True when the runtime recognises this IANA zone name.
 *
 * Used by the settings validator: an unknown zone must be refused at the point
 * an administrator types it, not discovered at 09:00 the next morning when the
 * tick throws.
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false

  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** Splits an instant into the wall-clock fields a given zone would show. */
function zonedParts(date, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(date)
  const read = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0)

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

/**
 * The zone's offset from UTC at a given instant, in milliseconds.
 *
 * Positive east of Greenwich. Derived by treating the zone's wall clock as if
 * it were UTC and measuring how far that lands from the real instant.
 */
function zoneOffsetMs(date, timeZone) {
  const { year, month, day, hour, minute, second } = zonedParts(date, timeZone)
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second, date.getUTCMilliseconds())

  return asUtc - date.getTime()
}

/**
 * The calendar day in a zone, as `YYYY-MM-DD`.
 *
 * This string is the scheduler's idempotency key: one automatic run per day key
 * per workspace, enforced by a conditional write. A string rather than a Date
 * because "the 2nd of August in Kolkata" is not an instant, and storing it as
 * one invites a comparison that is off by five and a half hours.
 */
export function dayKeyIn(date, timeZone) {
  const { year, month, day } = zonedParts(date, timeZone)

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Minutes elapsed since local midnight in a zone. */
export function minutesIntoDay(date, timeZone) {
  const { hour, minute } = zonedParts(date, timeZone)

  return hour * 60 + minute
}

/**
 * Parses `HH:mm` into minutes since midnight.
 *
 * @returns {?number} Null when the value is not a valid 24-hour time.
 */
export function parseRunTime(runTime) {
  const match = RUN_TIME_PATTERN.exec(String(runTime ?? '').trim())
  if (!match) return null

  return Number(match[1]) * 60 + Number(match[2])
}

/** Formats minutes since midnight back to `HH:mm`. */
export function formatRunTime(minutes) {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440

  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * The instant at which a given local time occurs on a given local day.
 *
 * @param {string} dayKey   `YYYY-MM-DD` in `timeZone`.
 * @param {number} minutes  Minutes since local midnight.
 * @param {string} timeZone IANA zone name.
 * @returns {Date}
 */
export function occurrenceUtc(dayKey, minutes, timeZone) {
  const [year, month, day] = dayKey.split('-').map(Number)
  const naive = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60, 0, 0)

  // First pass corrects by the offset at the naive guess; the second corrects
  // for the case where that guess landed on the far side of a DST boundary and
  // the offset there was not the offset here. A third pass can never change the
  // answer, because no zone shifts twice within one day.
  let instant = naive
  for (let pass = 0; pass < 2; pass += 1) {
    instant = naive - zoneOffsetMs(new Date(instant), timeZone)
  }

  return new Date(instant)
}

/**
 * The next time the schedule fires, strictly after `from`.
 *
 * Today's occurrence when it is still ahead, tomorrow's otherwise. This is
 * display only — the decision to run is made by comparing day keys, never by
 * waiting for this value to arrive, so a clock adjustment cannot cause a missed
 * or doubled run.
 */
export function nextOccurrenceAfter(from, minutes, timeZone) {
  const today = occurrenceUtc(dayKeyIn(from, timeZone), minutes, timeZone)
  if (today.getTime() > from.getTime()) return today

  const tomorrow = new Date(from.getTime() + 24 * 60 * 60 * 1000)

  return occurrenceUtc(dayKeyIn(tomorrow, timeZone), minutes, timeZone)
}

/**
 * The day key whose scheduled time has already passed, or null.
 *
 * This single comparison is what makes a missed run self-healing. The scheduler
 * never asks "did a timer fire?" — it asks "has today's time passed, and is
 * today's key still unclaimed?". A process that boots at 09:20, or at 23:00, or
 * three times in a row, all reach the same correct answer.
 */
export function dueDayKey(now, minutes, timeZone) {
  return minutesIntoDay(now, timeZone) >= minutes ? dayKeyIn(now, timeZone) : null
}

export default {
  isValidTimeZone,
  dayKeyIn,
  minutesIntoDay,
  parseRunTime,
  formatRunTime,
  occurrenceUtc,
  nextOccurrenceAfter,
  dueDayKey,
}
