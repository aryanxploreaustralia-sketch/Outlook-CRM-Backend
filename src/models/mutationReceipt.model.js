/**
 * A record of a mutation the server has already carried out.
 *
 * ## The failure this exists to stop
 *
 * An offline client queues "create this enquiry". Connectivity returns, the
 * request reaches the server, MongoDB writes the lead — and the response is
 * lost to a dropped connection on the way back. The client cannot distinguish
 * that from "the server never received it", so it retries, and without
 * something like this the retry creates a **second enquiry**. The user sees a
 * duplicate they never entered and has no way to know which is real.
 *
 * Detecting that by comparing names or emails would be a heuristic, and a
 * heuristic that is wrong in either direction is worse than none: it either
 * duplicates anyway or refuses a genuine second enquiry from the same customer.
 * So the client mints an id once, before its first attempt, and sends the same
 * one on every retry. This collection remembers what that id produced.
 *
 * ## Why the whole response is stored
 *
 * A retry must be indistinguishable from the original call, and the client is
 * entitled to the server id, the allocated reference and the timestamps it
 * missed the first time. Returning "already done" without the body would leave
 * the client holding a local record it could never reconcile.
 *
 * ## Why it expires
 *
 * A replay is minutes or hours late, never months. Thirty days is far beyond
 * any real retry window and keeps this from growing without bound; MongoDB's
 * TTL monitor removes expired documents on its own.
 */

import mongoose from 'mongoose'

const mutationReceiptSchema = new mongoose.Schema(
  {
    /**
     * Whose mutation this was.
     *
     * Part of the uniqueness key, so one user's client id can never return
     * another user's stored response — the replay path must be as owner-scoped
     * as the original write was.
     */
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /** The client-generated id, stable across retries of one logical mutation. */
    clientMutationId: { type: String, required: true, trim: true, maxlength: 200 },

    /**
     * The request this key was first used for.
     *
     * Stored so a key accidentally reused against a different endpoint is
     * detectable rather than silently answered with the wrong body.
     */
    method: { type: String, required: true, maxlength: 10 },
    path: { type: String, required: true, maxlength: 512 },

    /** What was sent back, replayed verbatim on a retry. */
    statusCode: { type: Number, required: true },
    body: { type: mongoose.Schema.Types.Mixed, required: true },

    /** The record the mutation produced, when there was one. For diagnostics. */
    resultId: { type: String, default: null },
  },
  { timestamps: true, collection: 'mutationreceipts' },
)

/**
 * One receipt per (owner, key).
 *
 * Unique, and load-bearing: two retries racing each other both miss the read
 * and both try to insert, and this is what makes the second one lose. The
 * middleware catches the duplicate-key error and reads the winner's response
 * rather than writing a second record.
 */
mutationReceiptSchema.index({ owner: 1, clientMutationId: 1 }, { unique: true, name: 'receipt_key' })

/** Expiry. See the note above on why thirty days. */
mutationReceiptSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'receipt_ttl' },
)

export const MutationReceipt = mongoose.model('MutationReceipt', mutationReceiptSchema)

export default MutationReceipt
