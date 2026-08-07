/**
 * Health service.
 *
 * Owns the business logic of "is this service healthy?". Keeping it out of the
 * controller means the same check can later be reused by a startup probe, a
 * scheduled job or a CLI command without dragging Express along.
 */

import { getDatabaseStatus } from '../config/database.js'
import { config } from '../config/index.js'

/**
 * Builds a full health report.
 *
 * @returns {{ healthy: boolean, report: object }}
 *   `healthy` drives the HTTP status code; `report` is the response payload.
 */
export function buildHealthReport() {
  const database = getDatabaseStatus()

  const memory = process.memoryUsage()
  const toMb = (bytes) => Number((bytes / 1024 / 1024).toFixed(2))

  // The API is only considered healthy when its critical dependencies are.
  const healthy = database.healthy

  return {
    healthy,
    report: {
      status: healthy ? 'ok' : 'degraded',
      service: config.app.name,
      version: config.app.version,
      environment: config.app.env,
      uptimeSeconds: Number(process.uptime().toFixed(2)),
      timestamp: new Date().toISOString(),
      dependencies: {
        database: {
          status: database.status,
          healthy: database.healthy,
          name: database.name,
          host: database.host,
        },
      },
      runtime: {
        node: process.version,
        pid: process.pid,
        memoryMb: {
          rss: toMb(memory.rss),
          heapUsed: toMb(memory.heapUsed),
          heapTotal: toMb(memory.heapTotal),
        },
      },
    },
  }
}

export default { buildHealthReport }
