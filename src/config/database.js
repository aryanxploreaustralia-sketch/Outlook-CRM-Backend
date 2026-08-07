/**
 * MongoDB connection manager (Mongoose).
 *
 * Design decision — a failed *initial* connection does not terminate the
 * process. It retries with exponential backoff while the HTTP server keeps
 * serving, and the health endpoint reports the database as disconnected. A
 * thirty-second database blip therefore degrades the API instead of killing it,
 * which is what a process supervisor would otherwise restart-loop on.
 *
 * Mongoose 9 note: `useNewUrlParser` and `useUnifiedTopology` were removed and
 * must not be passed — they now raise an "option not supported" error.
 */

import mongoose from 'mongoose'

import { createContextLogger } from '../utils/logger.js'
import { config } from './index.js'

const log = createContextLogger('database')

/** Mongoose readyState integers mapped to readable names. */
const READY_STATE = Object.freeze({
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
})

/** Set once shutdown begins, so retry loops stop instead of fighting the exit. */
let isShuttingDown = false

/** Registers connection lifecycle listeners exactly once. */
let listenersBound = false

function bindConnectionListeners() {
  if (listenersBound) return
  listenersBound = true

  const { connection } = mongoose

  connection.on('connected', () => {
    log.info('MongoDB connected', { host: connection.host, database: connection.name })
  })

  connection.on('disconnected', () => {
    // Expected and unremarkable during shutdown; noteworthy at any other time.
    if (isShuttingDown) return
    // Log messages stay ASCII-only: Windows consoles default to a legacy code
    // page and would render non-ASCII punctuation as mojibake.
    log.warn('MongoDB disconnected - the driver will attempt to reconnect')
  })

  connection.on('reconnected', () => {
    log.info('MongoDB reconnected')
  })

  connection.on('error', (error) => {
    log.error('MongoDB connection error', { message: error.message })
  })
}

/** Resolves after `ms` milliseconds. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Connects to MongoDB, retrying with exponential backoff.
 *
 * @returns {Promise<boolean>} True once connected, false if every attempt failed.
 */
export async function connectDatabase() {
  bindConnectionListeners()

  // Reject unknown fields in queries rather than silently ignoring them, so a
  // typo in a filter surfaces as an error instead of returning every document.
  mongoose.set('strictQuery', true)

  const { maxAttempts, initialDelayMs, maxDelayMs } = config.database.retry

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isShuttingDown) return false

    try {
      await mongoose.connect(config.database.uri, config.database.options)
      return true
    } catch (error) {
      const isFinalAttempt = attempt === maxAttempts

      log.error(`MongoDB connection attempt ${attempt}/${maxAttempts} failed`, {
        message: error.message,
      })

      if (isFinalAttempt) {
        log.error(
          'Exhausted all MongoDB connection attempts. The API will continue to run ' +
            'and report the database as unavailable via the health endpoint.',
        )
        return false
      }

      // Exponential backoff: 1s, 2s, 4s, 8s… capped at maxDelayMs.
      const backoff = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs)
      log.warn(`Retrying MongoDB connection in ${backoff}ms`)
      await delay(backoff)
    }
  }

  return false
}

/**
 * Closes the connection cleanly during shutdown.
 */
export async function disconnectDatabase() {
  isShuttingDown = true

  if (mongoose.connection.readyState === 0) return

  try {
    await mongoose.connection.close(false)
    log.info('MongoDB connection closed')
  } catch (error) {
    log.error('Failed to close the MongoDB connection cleanly', { message: error.message })
  }
}

/**
 * Current database status, consumed by the health endpoint.
 *
 * @returns {{ status: string, healthy: boolean, name: ?string, host: ?string }}
 */
export function getDatabaseStatus() {
  const { connection } = mongoose
  const status = READY_STATE[connection.readyState] ?? 'unknown'

  return {
    status,
    healthy: connection.readyState === 1,
    name: connection.name ?? null,
    host: connection.host ?? null,
  }
}

export default { connectDatabase, disconnectDatabase, getDatabaseStatus }
