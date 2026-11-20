/**
 * Standing sharing grants: "my whole register, now and in future".
 *
 * ## The defect this exists to fix
 *
 * Sharing used to be a stamp. "Share my leads" wrote the colleague's id into
 * `Lead.sharedWith` on every lead that existed at that instant, and a lead
 * created afterwards was born with an empty `sharedWith` — invisible to the
 * colleague until the owner unshared and shared again. The register was shared;
 * tomorrow's work was not.
 *
 * A `LeadShare` row says the relationship, not the snapshot, so a lead created
 * a month later needs nothing done to it: the access filter admits it because
 * of who owns it.
 *
 * ## What this module does and does not touch
 *
 * It only ever reads and writes the `LeadShare` collection. The stamping in
 * `bulkShare` is left exactly as it was and still runs, so every value already
 * stored in `Lead.sharedWith` keeps working and keeps being honoured; nothing
 * here rewrites, clears or migrates a lead. The two mechanisms are alternatives
 * in one `$or`, not replacements.
 */

import mongoose from 'mongoose'

import { LeadShare } from '../../../models/leadShare.model.js'

/**
 * Narrows a candidate id to a real one, or to null.
 *
 * Defined here rather than imported because the codebase has no shared helper:
 * `lead.service.js` and `conversation.service.js` each keep their own copy, and
 * introducing a utility module would mean editing those two working files for
 * no behavioural gain. The guard matters — an unparseable id must become "no
 * grant", never a cast error on a read path.
 */
function toObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(String(value)) : null
}

/**
 * The owners whose registers this person may read by standing grant.
 *
 * Returned as ids for `$in`. The empty array is the common answer — most people
 * have no grants — and every caller treats it as "no extra access", which is
 * what makes adding this lookup safe at each access point.
 *
 * @param {string|import('mongoose').Types.ObjectId|null} viewer
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
export async function ownersSharingWith(viewer) {
  if (!viewer) return []

  const id = toObjectId(viewer)
  if (!id) return []

  // `distinct` over the `{ viewer, owner }` index: the ids are in the index, so
  // the answer never reads a document.
  return LeadShare.distinct('owner', { viewer: id })
}

/**
 * The colleagues holding a standing grant on this owner's register.
 *
 * @param {string|import('mongoose').Types.ObjectId|null} owner
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
export async function viewersOf(owner) {
  if (!owner) return []

  const id = toObjectId(owner)
  if (!id) return []

  return LeadShare.distinct('viewer', { owner: id })
}

/**
 * Makes the stored grants for one owner match the given set of colleagues.
 *
 * Mirrors what the sharing dialog means by Save: the list it submits is the
 * complete intended set, so a colleague who is absent from it has been revoked.
 *
 * Both halves are scoped to this one owner, so no other owner's grants are
 * reachable from here however the arguments arrive.
 *
 * @param {object} params
 * @param {string|import('mongoose').Types.ObjectId} params.owner
 * @param {Array<string|import('mongoose').Types.ObjectId>} params.viewers  The complete intended set.
 * @param {string|import('mongoose').Types.ObjectId|null} [params.actor]    Who pressed Save.
 * @returns {Promise<{ granted: number, revoked: number }>}
 */
export async function setGrantsForOwner({ owner, viewers = [], actor = null }) {
  const ownerId = toObjectId(owner)
  if (!ownerId) return { granted: 0, revoked: 0 }

  const actorId = actor ? toObjectId(actor) : null

  /*
   * An owner sharing with themselves is a no-op that would otherwise store a
   * row claiming they need a grant to read their own register. Dropped here
   * rather than trusted to the caller, since this is the only place that can
   * see both sides of the pair.
   */
  const intended = viewers
    .map((value) => toObjectId(value))
    .filter((id) => id && !id.equals(ownerId))

  const unique = new Map(intended.map((id) => [String(id), id]))

  /*
   * Grant first, revoke second, both scoped to this owner.
   *
   * `updateOne` with `upsert` rather than `insertMany`: granting twice is then
   * idempotent and a duplicate click cannot trip the unique index. `$setOnInsert`
   * keeps the original grant's `createdBy` and `createdAt` — re-saving an
   * unchanged list must not rewrite history.
   */
  const granted = await Promise.all(
    [...unique.values()].map((viewerId) =>
      LeadShare.updateOne(
        { owner: ownerId, viewer: viewerId },
        { $setOnInsert: { owner: ownerId, viewer: viewerId, createdBy: actorId } },
        { upsert: true },
      ),
    ),
  )

  /*
   * Revocation deletes only this owner's rows for colleagues absent from the
   * submitted set. `$nin` with an empty array matches everything *within* the
   * owner filter, which is exactly right: Save with nobody selected means
   * "share with no one".
   */
  const removal = await LeadShare.deleteMany({
    owner: ownerId,
    viewer: { $nin: [...unique.values()] },
  })

  return {
    granted: granted.filter((result) => (result.upsertedCount ?? 0) > 0).length,
    revoked: removal.deletedCount ?? 0,
  }
}

export default { ownersSharingWith, viewersOf, setGrantsForOwner }
