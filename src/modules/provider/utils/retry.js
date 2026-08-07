/**
 * Retry with exponential backoff and full jitter.
 *
 * ## Why jitter, not plain exponential backoff
 *
 * Plain backoff synchronises clients. If a provider returns 503 to fifty sync
 * runs at once, all fifty wait exactly 1s, then 2s, then 4s — and retry in
 * lockstep, reproducing the same thundering herd that caused the outage. Full
 * jitter (a uniform delay in `[0, cap]`) spreads them out, which is what
 * actually lets an overloaded service recover.
 *
 * ## Retry-After is obeyed when present
 *
 * Graph's 429 responses carry a `Retry-After` header stating exactly how long to
 * wait. Guessing a shorter interval does not get served sooner; it consumes
 * quota and extends the throttle. An explicit value always wins over the
 * computed one.
 */

import { PROVIDER_ERROR_CODES, ProviderError } from '../constants/providerErrors.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('provider-retry')

export const DEFAULT_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
})

/** Exponential backoff with full jitter, clamped to `maxDelayMs`. */
export function computeBackoffMs(attempt, options = DEFAULT_RETRY_OPTIONS) {
  const exponential = options.initialDelayMs * options.factor ** (attempt - 1)
  const capped = Math.min(exponential, options.maxDelayMs)
  return Math.round(Math.random() * capped)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs an operation, retrying only failures that can succeed on a second try.
 *
 * The `isRetryable` check is the point of the whole helper. Retrying a revoked
 * consent or a missing mailbox cannot succeed however many times it is
 * attempted — it just delays the error the user needs to see and spends quota
 * doing it.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {object} [options]
 * @param {string} [options.label] Used in logs.
 * @param {number} [options.maxAttempts]
 * @param {(error: unknown) => boolean} [options.isRetryable]
 * @returns {Promise<T>}
 */
export async function withRetry(operation, options = {}) {
  const settings = { ...DEFAULT_RETRY_OPTIONS, ...options }
  const label = options.label ?? 'provider operation'

  const isRetryable =
    options.isRetryable ??
    ((error) => error instanceof ProviderError && error.isRetryable)

  let lastError

  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error

      if (!isRetryable(error)) throw error

      if (attempt === settings.maxAttempts) {
        log.warn(`${label} exhausted retries`, {
          attempts: attempt,
          code: error?.code ?? null,
        })
        break
      }

      // An explicit Retry-After always beats the computed backoff.
      const delayMs = error?.retryAfterMs ?? computeBackoffMs(attempt, settings)

      log.debug(`${label} failed, retrying`, {
        attempt,
        nextAttemptInMs: delayMs,
        code: error?.code ?? null,
      })

      await sleep(delayMs)
    }
  }

  throw lastError
}

/**
 * Fails an operation that outruns a deadline.
 *
 * A provider call with no timeout can hang for as long as the socket stays
 * open, holding a sync lock the whole time and blocking every later run for
 * that folder.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label = 'provider operation') {
  let timer

  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ProviderError(
            PROVIDER_ERROR_CODES.TIMEOUT,
            `${label} did not complete within ${ms}ms.`,
            { retryAfterMs: null },
          ),
        ),
      ms,
    )
  })

  // `finally` clears the timer on both paths, so a fast success does not leave a
  // pending timer holding the event loop open.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export default withRetry
