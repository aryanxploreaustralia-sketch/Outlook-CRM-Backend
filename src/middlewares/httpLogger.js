/**
 * HTTP access logging.
 *
 * Written against Winston directly rather than pulling in Morgan, because it
 * needs to emit the correlation id from `requestContext` and route entries
 * through the same transports and formats as the rest of the application.
 *
 * Logging happens on the response `finish` event so the status code and
 * duration are known.
 */

import { createContextLogger } from '../utils/logger.js'

const log = createContextLogger('http')

/** Maps a status code to the severity the line should be logged at. */
function levelForStatus(statusCode) {
  if (statusCode >= 500) return 'error'
  if (statusCode >= 400) return 'warn'
  return 'http'
}

/** @type {import('express').RequestHandler} */
export function httpLogger(req, res, next) {
  res.on('finish', () => {
    // `startTime` is a bigint of nanoseconds set by requestContext.
    const durationMs = req.startTime
      ? Number(process.hrtime.bigint() - req.startTime) / 1e6
      : null

    const level = levelForStatus(res.statusCode)

    log.log(level, `${req.method} ${req.originalUrl} ${res.statusCode}`, {
      requestId: req.id,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: durationMs === null ? null : Number(durationMs.toFixed(2)),
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
    })
  })

  next()
}

export default httpLogger
