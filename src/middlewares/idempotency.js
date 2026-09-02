/**
 * Makes a mutation safe to retry.
 *
 * A client that sends `X-Client-Mutation-Id` gets exactly-once semantics: the
 * first call runs normally and its response is remembered; every later call
 * with the same id replays that response without touching the database. A
 * client that sends no header is completely unaffected, which is what keeps the
 * existing online CRM on precisely its current path.
 *
 * ## Why a header and not a body field
 *
 * This matters more than it looks. Every mutation controller in this codebase
 * validates with `z.object()`, which **strips unknown keys**. A
 * `clientMutationId` placed in the request body would be silently removed
 * before the controller ever saw it — the key would appear to work, and
 * duplicate protection would simply never happen. A header sidesteps validation
 * entirely, so no Zod schema, no controller and no request DTO has to change.
 *
 * ## Why it wraps the response rather than the handler
 *
 * The receipt must record what the client actually received, including the
 * status code and the server-generated fields inside the body. Capturing at
 * `res.json` is the one place that is guaranteed to be the truth, whatever path
 * the controller took to get there.
 *
 * ## What is deliberately not stored
 *
 * Only successful responses (2xx). A validation failure is not a completed
 * mutation, and replaying a 400 forever would make a fixable mistake permanent.
 * The client should be free to correct the payload and retry with the same id.
 */

import { MutationReceipt } from '../models/mutationReceipt.model.js'
import { createContextLogger } from '../utils/logger.js'

const log = createContextLogger('idempotency')

/** The header a client uses to make its mutation replay-safe. */
export const MUTATION_ID_HEADER = 'X-Client-Mutation-Id'

/** Bounds what a client may send, so a key cannot be used as a payload. */
const MAX_KEY_LENGTH = 200

/** Reads and validates the key. Returns null when there is nothing usable. */
function keyOf(req) {
  const raw = req.get(MUTATION_ID_HEADER)
  if (typeof raw !== 'string') return null

  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH) return null

  return trimmed
}

/**
 * Finds the id of whatever record a response describes.
 *
 * Diagnostic only — nothing depends on it being right. The mutation responses
 * in this codebase nest their subject (`data.lead`, `data.contact`,
 * `data.company`), so this looks one level down before giving up.
 */
function resultIdOf(body) {
  const data = body?.data
  if (!data || typeof data !== 'object') return null

  if (typeof data.id === 'string') return data.id

  for (const key of ['lead', 'contact', 'company']) {
    const id = data[key]?.id
    if (typeof id === 'string') return id
  }

  return null
}

/**
 * Replays a completed mutation, or remembers a new one.
 *
 * Placed after `requireAuth`, because the owner is half the uniqueness key and
 * there is no owner to scope by before authentication has run.
 *
 * @returns {import('express').RequestHandler}
 */
export function idempotent() {
  return async function idempotencyGuard(req, res, next) {
    const clientMutationId = keyOf(req)
    if (!clientMutationId) return next()

    const owner = req.auth?.user?._id
    if (!owner) return next()

    /*
     * A lookup failure must not fail the mutation.
     *
     * The worst case of proceeding is a duplicate on a retry — the thing this
     * exists to prevent — but the worst case of throwing is that the user
     * cannot save at all. Availability wins, and the failure is logged.
     */
    let existing = null
    try {
      existing = await MutationReceipt.findOne({ owner, clientMutationId }).lean()
    } catch (error) {
      log.warn('Could not read the mutation receipt; proceeding without replay protection', {
        message: error.message,
      })
      return next()
    }

    if (existing) {
      /*
       * A key reused against a different endpoint is a client bug, and
       * answering it with the first call's body would be actively misleading.
       * Refusing is the honest response.
       */
      if (existing.method !== req.method || existing.path !== req.originalUrl.split('?')[0]) {
        return res.status(409).json({
          success: false,
          message: 'This mutation id was already used for a different request.',
          code: 'IDEMPOTENCY_KEY_REUSED',
        })
      }

      log.info('Replaying a completed mutation', { clientMutationId })
      res.setHeader('X-Idempotent-Replay', 'true')
      return res.status(existing.statusCode).json(existing.body)
    }

    // --- first time through: run the handler, then remember what it produced --
    const originalJson = res.json.bind(res)

    res.json = (body) => {
      const statusCode = res.statusCode ?? 200

      if (statusCode >= 200 && statusCode < 300) {
        /*
         * Written after the response is on its way, deliberately.
         *
         * Awaiting the receipt would make every mutation wait on a second
         * write, and a receipt that fails to save costs a possible duplicate on
         * a retry — strictly better than delaying or failing the mutation the
         * user asked for.
         */
        MutationReceipt.create({
          owner,
          clientMutationId,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          statusCode,
          body,
          resultId: resultIdOf(body),
        }).catch((error) => {
          // 11000 is the unique index doing its job: a concurrent retry won the
          // race and stored the same receipt. Nothing is wrong.
          if (error?.code !== 11000) {
            log.warn('Could not store the mutation receipt', { message: error.message })
          }
        })
      }

      return originalJson(body)
    }

    return next()
  }
}

export default idempotent
