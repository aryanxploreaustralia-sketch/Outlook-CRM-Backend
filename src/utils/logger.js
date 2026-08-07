/**
 * Application logger (Winston).
 *
 * Two audiences, two formats:
 *  - development → colourised, single-line console output for humans;
 *  - production  → structured JSON in daily-rotated files for log aggregators.
 *
 * Errors are additionally written to their own rotated file so an on-call
 * engineer can read failures without scrolling through request noise.
 */

import path from 'node:path'

import winston from 'winston'
import 'winston-daily-rotate-file'

import { config } from '../config/index.js'

const { combine, timestamp, printf, colorize, errors, json, splat } = winston.format

/** Human-readable console format: `10:32:07 info  Server listening { port: 5000 }`. */
const consoleFormat = combine(
  colorize({ level: true }),
  timestamp({ format: 'HH:mm:ss' }),
  // `errors({ stack: true })` promotes an Error's stack onto the log info object.
  errors({ stack: true }),
  splat(),
  printf(({ level, message, timestamp: time, stack, ...meta }) => {
    // `Symbol`-keyed entries are Winston internals and must not be printed.
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
    const trace = stack ? `\n${stack}` : ''
    return `${time} ${level} ${message}${extra}${trace}`
  }),
)

/** Machine-readable file format. */
const fileFormat = combine(timestamp(), errors({ stack: true }), splat(), json())

const transports = [
  new winston.transports.Console({
    format: consoleFormat,
    // Never let a logging failure take down the HTTP server.
    handleExceptions: true,
    handleRejections: true,
  }),
]

// File transports are noise on a developer's machine but essential in
// production, so they are only attached outside development.
if (!config.app.isDevelopment) {
  transports.push(
    new winston.transports.DailyRotateFile({
      dirname: config.logging.dir,
      filename: 'application-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: config.logging.maxFiles,
      format: fileFormat,
    }),
    new winston.transports.DailyRotateFile({
      dirname: config.logging.dir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: config.logging.maxFiles,
      format: fileFormat,
    }),
  )
}

export const logger = winston.createLogger({
  level: config.logging.level,
  levels: winston.config.npm.levels,
  defaultMeta: {
    service: config.app.name,
    env: config.app.env,
  },
  format: fileFormat,
  transports,
  exitOnError: false,
})

/**
 * Creates a child logger that stamps a fixed context onto every entry.
 *
 * @example
 *   const log = createContextLogger('database')
 *   log.info('Connected')   // → { context: 'database', message: 'Connected' }
 *
 * @param {string} context
 */
export function createContextLogger(context) {
  return logger.child({ context })
}

/** Directory log files are written to; exported for diagnostics. */
export const LOG_DIRECTORY = path.resolve(config.logging.dir)

export default logger
