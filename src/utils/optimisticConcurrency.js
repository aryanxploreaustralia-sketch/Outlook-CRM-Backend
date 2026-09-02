/**
 * Refusing a mutation that was written against a version of the record which
 * no longer exists.
 *
 * ## The failure this stops
 *
 * A consultant caches an enquiry, goes offline, and edits the remark. While
 * they are away a colleague changes the stage and the city. When the queue
 * drains, a plain PATCH would apply the stale remark over the top and give no
 * indication that anything else had moved. Nobody would notice until the
 * colleague's change was missed.
 *
 * So a queued mutation states which version it was made against, and the server
 * refuses it if the record has moved on since. It does **not** merge, choose a
 * winner, or apply anything partially — it reports a conflict and leaves both
 * versions intact for a person to settle.
 *
 * ## Why `updatedAt` is the version token, and why there is no new field
 *
 * Audited before choosing rather than assumed:
 *
 *  - `Lead`, `Contact` and `Company` all carry `timestamps: true`, so Mongoose
 *    stamps `updatedAt` on `save`, `updateOne`, `updateMany`,
 *    `findOneAndUpdate`, `replaceOne` and `bulkWrite`.
 *  - **No write anywhere in this codebase goes through the native driver**
 *    (`Model.collection.*`), which is the only way to bypass that stamping. So
 *    there is no path by which a record changes without `updatedAt` moving.
 *  - All three set `versionKey: false`, so `__v` does not exist and could not
 *    have been used even if it were preferable.
 *
 * `updatedAt` is therefore already a reliable version token, and adding a
 * `syncVersion` field would have meant a migration across three collections to
 * buy nothing. The one theoretical gap is two writes landing inside the same
 * millisecond; see `KNOWN_LIMIT` below.
 *
 * ## Opt-in, so nothing existing changes
 *
 * The check runs only when the client sends `X-Expected-Updated-At`. Every
 * existing online request omits it and follows exactly the path it always has.
 */

import { ApiError } from './ApiError.js'
import { ERROR_CODES } from '../constants/errorCodes.js'

/** The header a client uses to state which version it edited. */
export const EXPECTED_VERSION_HEADER = 'X-Expected-Updated-At'

/**
 * The one case `updatedAt` cannot distinguish.
 *
 * Two writes inside the same millisecond leave the second indistinguishable
 * from the first, so a mutation based on the first would be accepted. It needs
 * two writers to collide inside one millisecond on the same document, and the
 * consequence is the behaviour this codebase had everywhere before Phase 6 —
 * a last-write-wins PATCH. Documented rather than papered over; closing it
 * would require a counter on every write path.
 */
export const KNOWN_LIMIT = 'Two writes within the same millisecond are indistinguishable.'

/**
 * Reads and validates the expected version from the request.
 *
 * @returns {?Date} null when the client sent nothing usable, which means "no
 *   concurrency check" rather than "check against nothing".
 */
export function expectedVersionOf(req) {
  const raw = req.get(EXPECTED_VERSION_HEADER)
  if (typeof raw !== 'string' || raw.trim() === '') return null

  const parsed = new Date(raw.trim())
  if (Number.isNaN(parsed.getTime())) {
    throw ApiError.badRequest(`"${EXPECTED_VERSION_HEADER}" must be an ISO-8601 timestamp.`)
  }

  return parsed
}

/**
 * Atomically claims a document at an expected version.
 *
 * ## Why a conditional write rather than a comparison
 *
 * Reading the document, comparing `updatedAt` in JavaScript and then saving
 * would leave a window between the comparison and the write in which another
 * request could commit — precisely the race the check exists to close, moved
 * a few lines later. So the version is part of the **filter** of a single
 * atomic `findOneAndUpdate`, and the database decides.
 *
 * The claim bumps `updatedAt` itself. That is deliberate: from the moment this
 * returns, any other in-flight mutation holding the old version fails its own
 * claim, so two stale writers cannot both get through.
 *
 * ## Authorization is the caller's, and stays the caller's
 *
 * This takes a document the controller has **already loaded through its own
 * authorized path** — `loadLead`, an owner-scoped `findOne`, whatever that
 * controller does — and filters only on `_id` and the version. It deliberately
 * does not re-implement ownership: duplicating an authorization rule is how
 * the two copies drift apart.
 *
 * @param {object}   params
 * @param {import('mongoose').Model} params.Model
 * @param {object}   params.doc       Already loaded AND already authorized.
 * @param {?Date}    params.expected  From `expectedVersionOf`. Null skips the check.
 * @param {string}   params.entity    For the conflict payload.
 * @returns {Promise<object>} The claimed document, re-read at its new version.
 * @throws {ApiError} 409 when the record has moved on.
 */
export async function claimVersion({ Model, doc, expected, entity }) {
  if (!expected) return doc

  const claimed = await Model.findOneAndUpdate(
    { _id: doc._id, updatedAt: expected },
    { $set: { updatedAt: new Date() } },
    { returnDocument: 'after' },
  )

  if (claimed) return claimed

  /*
   * The claim failed. The caller already proved they may see this record, so
   * reporting its current version tells them nothing they could not read from
   * the GET endpoint — and it is what lets the client decide what to do without
   * a second round trip.
   */
  const current = await Model.findById(doc._id).select('updatedAt isDeleted').lean()

  throw ApiError.conflict(
    'This record changed after your copy was made. Your change has not been applied.',
    {
      code: ERROR_CODES.VERSION_CONFLICT,
      details: {
        conflictType: current ? 'staleVersion' : 'deleted',
        entity,
        id: String(doc._id),
        expectedUpdatedAt: expected.toISOString(),
        serverUpdatedAt: current?.updatedAt ? new Date(current.updatedAt).toISOString() : null,
        serverDeleted: Boolean(current?.isDeleted),
      },
    },
  )
}

export default { EXPECTED_VERSION_HEADER, expectedVersionOf, claimVersion, KNOWN_LIMIT }
