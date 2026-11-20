/**
 * A standing grant: this owner's register is readable by this colleague.
 *
 * ## Why this exists beside `Lead.sharedWith` rather than replacing it
 *
 * Sharing was record-level. "Share my register" wrote the colleague's id onto
 * every lead that existed at that moment (`bulkShare`'s `updateMany`), and
 * nothing wrote it onto the leads created afterwards — a lead is born with
 * `sharedWith: []`. So an owner who shared on Monday and entered five enquiries
 * on Tuesday had to unshare and share again to make Tuesday's work visible.
 * That is the defect this collection fixes.
 *
 * A row here is a *relationship*, not a stamp: it says "every enquiry this
 * owner has, and every one they will have, until the grant is revoked". There
 * is nothing to re-apply when a lead is created, because no lead carries the
 * grant.
 *
 * `Lead.sharedWith` keeps its job and its data untouched. It is how a single
 * enquiry is shared with somebody who has no standing access to the register,
 * and every value already stored in it is still honoured — the access filter
 * admits a lead by owner, by per-record grant, *or* by a standing grant. This
 * collection is additive: no existing document is read differently, rewritten
 * or migrated.
 *
 * ## Shape
 *
 * One row per (owner, viewer) pair, enforced by a unique index, so granting
 * twice is idempotent and the pair cannot be duplicated by two clicks racing.
 * Revoking deletes the row — the grant's absence is what ends the access, and
 * it ends it for future leads and existing ones alike.
 */

import mongoose from 'mongoose'

const { Schema } = mongoose

const leadShareSchema = new Schema(
  {
    /**
     * Whose register is being shared.
     *
     * Not indexed at the field level: the compound indexes below have `owner`
     * and `viewer` as their leading keys, which serves a single-field lookup on
     * either. Declaring both would leave the planner choosing a narrower index
     * and then fetching the document for the other field — measured against a
     * real server, that is exactly what it did, and it defeats the covered
     * lookup the read path is built around.
     */
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /** Who may read it. */
    viewer: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * Who granted it.
     *
     * Normally the owner themselves, since only an owner or a manager may share
     * their own register. Kept because "who opened this up" is the first
     * question asked of any access record.
     */
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, versionKey: false },
)

/** One grant per pair. A repeat grant is an upsert, never a second row. */
leadShareSchema.index({ owner: 1, viewer: 1 }, { unique: true })

/**
 * The read path: "whose registers may this person see?"
 *
 * Asked once per register listing, so it leads with `viewer`. The `owner` tail
 * makes it a covered query — the answer is the owner ids, and the index already
 * holds them, so the lookup never reads a document. Verified against a real
 * server: the plan is an IXSCAN on this index with no FETCH stage.
 */
leadShareSchema.index({ viewer: 1, owner: 1 })

export const LeadShare = mongoose.models.LeadShare ?? mongoose.model('LeadShare', leadShareSchema)

export default LeadShare
