/**
 * Allocates the next reference for a manually created enquiry.
 *
 * ## Why this exists at all
 *
 * Every reference in the register arrived from the workbook, where the office
 * allocates them by hand — `XAMP1687`, `XATP0001`, `XAKK0001`. Creating a lead
 * from the UI is the first path that has to invent one, so this is the only
 * genuinely new rule in the phase. It is deliberately kept in its own module
 * rather than inside the create service: the workbook path must never call it,
 * and a separate file makes that obvious.
 *
 * ## The convention is read from the data, not declared here
 *
 * Hard-coding `XAMP` would be a guess about somebody else's filing system. The
 * generator instead looks at the references the office already uses for the
 * market in question, takes the most common prefix, and continues that series
 * at the width it is already written in — so a workspace numbering `XATP0001`
 * gets `XATP0002`, not `XATP2`.
 *
 * The seeds below are used only when a market has no leads at all yet. They
 * follow the prefix convention documented on `deriveMarket`: `XA…` is
 * Australia, `XN…` is New Zealand.
 */

import { Lead } from '../../../models/lead.model.js'
import { MARKET } from '../constants/leadConstants.js'

/** Splits `XAMP1687` into `{ prefix: 'XAMP', digits: '1687' }`. */
const REFERENCE_PATTERN = /^([A-Z]+)(\d+)$/

/** Used only for a market that has never had a lead. */
const SEED_PREFIX = Object.freeze({
  [MARKET.AU]: 'XAMP',
  [MARKET.NZ]: 'XNMP',
  [MARKET.OTHER]: 'XXMP',
})

/** Width a brand-new series is numbered at. */
const SEED_WIDTH = 4

/**
 * Learns the prefix and number width this workspace uses for a market.
 *
 * Reads at most 500 references — enough to establish the convention beyond
 * doubt, bounded so a large register does not turn a form submission into a
 * full scan. The most frequently used prefix wins, so one mistyped reference
 * cannot redirect the series.
 *
 * @returns {Promise<{ prefix: string, width: number }>}
 */
async function learnSeries({ owner, market }) {
  const recent = await Lead.find({ owner, market, isDeleted: false })
    .select('reference')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean()

  /** prefix -> { count, width } */
  const seen = new Map()

  for (const lead of recent) {
    const match = REFERENCE_PATTERN.exec(String(lead.reference ?? '').toUpperCase())
    if (!match) continue

    const [, prefix, digits] = match
    const entry = seen.get(prefix) ?? { count: 0, width: digits.length }
    entry.count += 1
    // The widest form wins within a prefix: a series that has rolled over from
    // 999 to 1000 must not be numbered back down to three digits.
    entry.width = Math.max(entry.width, digits.length)
    seen.set(prefix, entry)
  }

  if (seen.size === 0) {
    return { prefix: SEED_PREFIX[market] ?? SEED_PREFIX[MARKET.OTHER], width: SEED_WIDTH }
  }

  const [prefix, entry] = [...seen.entries()].sort((a, b) => b[1].count - a[1].count)[0]

  return { prefix, width: entry.width }
}

/**
 * Highest number currently issued under a prefix.
 *
 * Sorted in the database rather than in memory. A lexicographic sort is not the
 * numeric one — `XAMP999` sorts above `XAMP1000` — so every reference under the
 * prefix is read and compared numerically. It is one indexed range scan over a
 * single owner's references, projected to one field.
 */
async function highestNumber({ owner, prefix }) {
  const existing = await Lead.find({
    owner,
    reference: new RegExp(`^${prefix}\\d+$`),
    // Deleted references still count. Re-issuing one would collide with the
    // soft-deleted row the moment anybody restored it, and would make two
    // different enquiries share a business key in the audit trail.
  })
    .select('reference')
    .lean()

  let highest = 0

  for (const lead of existing) {
    const match = REFERENCE_PATTERN.exec(String(lead.reference ?? '').toUpperCase())
    if (!match || match[1] !== prefix) continue

    const value = Number(match[2])
    if (Number.isFinite(value) && value > highest) highest = value
  }

  return highest
}

/**
 * Produces the next unused reference for a market.
 *
 * ## Why it retries rather than trusting its own answer
 *
 * Two people pressing Create at the same moment would compute the same next
 * number. The unique partial index on `(owner, reference)` is what actually
 * prevents the duplicate — this loop simply lets the loser take the following
 * number instead of showing them an error they cannot act on. The caller
 * re-checks on insert regardless, so a collision that outlives the loop still
 * fails safely rather than overwriting anything.
 *
 * @param {{ owner: any, market?: string }} params
 * @returns {Promise<string>}
 */
export async function nextReference({ owner, market = MARKET.OTHER }) {
  const { prefix, width } = await learnSeries({ owner, market })
  let next = (await highestNumber({ owner, prefix })) + 1

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = `${prefix}${String(next).padStart(width, '0')}`

    const clash = await Lead.exists({ owner, reference: candidate })
    if (!clash) return candidate

    next += 1
  }

  // 25 consecutive taken numbers means something is badly wrong with the
  // series; failing loudly beats issuing a reference that will be rejected.
  throw new Error(
    `Could not allocate a free reference under "${prefix}". Enter one manually on the form.`,
  )
}

/**
 * Whether a reference is already in use by this workspace.
 *
 * Deleted leads are included, for the reason given in `highestNumber`.
 *
 * @returns {Promise<boolean>}
 */
export async function referenceExists({ owner, reference }) {
  const value = String(reference ?? '').trim().toUpperCase()
  if (!value) return false

  return Boolean(await Lead.exists({ owner, reference: value }))
}

export default { nextReference, referenceExists }
