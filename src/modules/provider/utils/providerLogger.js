/**
 * Structured logging for provider traffic.
 *
 * Every provider call is logged with the same field names — `provider`,
 * `operation`, `durationMs`, `outcome` — so runs are queryable as data rather
 * than grepped as prose. "Which folder is slow?" should be a filter, not a
 * reading exercise.
 *
 * ## What is deliberately never logged
 *
 * Tokens, message bodies and attachment content. A log aggregator is exactly the
 * place a bearer token gets copied into somewhere it should not be, and message
 * bodies are the user's private correspondence. Counts, ids and durations are
 * enough to diagnose a sync; content is not needed and is not recorded.
 */

import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('provider')

/** Fields that must never reach the log, whatever a caller passes. */
const REDACTED_KEYS = new Set([
  'accessToken',
  'refreshToken',
  'token',
  'authorization',
  'clientSecret',
  'contentBytes',
  'html',
  'body',
  'bodyHtml',
  'bodyText',
  'tokenCache',
  'password',
])

/**
 * Strips sensitive values from a payload before it is logged.
 *
 * Applied unconditionally rather than trusting call sites to remember: the one
 * time somebody forgets is the time it matters.
 *
 * @param {object} payload
 * @returns {object}
 */
export function redact(payload = {}) {
  const safe = {}

  for (const [key, value] of Object.entries(payload)) {
    if (REDACTED_KEYS.has(key)) {
      safe[key] = '[redacted]'
    } else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      safe[key] = redact(value)
    } else {
      safe[key] = value
    }
  }

  return safe
}

/**
 * Logs the start of a provider request and returns a function to close it out.
 *
 * The paired shape is what guarantees a duration is always recorded: an
 * early return cannot forget the second half, because the caller holds it.
 *
 * @param {string} provider
 * @param {string} operation
 * @param {object} [context]
 * @returns {(outcome: 'success'|'failure', details?: object) => number} Duration in ms.
 */
export function beginRequest(provider, operation, context = {}) {
  const startedAt = Date.now()

  log.debug('provider request', redact({ provider, operation, ...context }))

  return (outcome, details = {}) => {
    const durationMs = Date.now() - startedAt

    const payload = redact({ provider, operation, outcome, durationMs, ...context, ...details })

    if (outcome === 'failure') log.warn('provider response', payload)
    else log.info('provider response', payload)

    return durationMs
  }
}

/** Logs the outcome of a whole sync run. */
export function logSyncRun(payload) {
  log.info('sync run complete', redact(payload))
}

/** Logs one folder's result within a run. */
export function logFolderSync(payload) {
  log.debug('folder synced', redact(payload))
}

export default { beginRequest, logSyncRun, logFolderSync, redact }
