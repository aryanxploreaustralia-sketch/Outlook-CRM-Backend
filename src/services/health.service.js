/**
 * Health service.
 *
 * Owns the business logic of "is this service healthy?". Keeping it out of the
 * controller means the same check can later be reused by a startup probe, a
 * scheduled job or a CLI command without dragging Express along.
 */

import { getDatabaseStatus } from '../config/database.js'

/**
 * Builds the public health report.
 *
 * ## Public, so it says nothing but "ok" or "degraded"
 *
 * `/api/v1/health` is unauthenticated and rate-limit exempt, for uptime
 * monitors. It used to return the environment, database name and host, the
 * process id, memory, Node version and uptime — a map of the infrastructure for
 * anyone who asked. None of that helps a monitor, which needs only the status
 * code and one word.
 *
 * The detailed view still exists for the people who need it, behind
 * authentication: `GET /api/v1/admin/system-health` (`adminHealth.service.js`).
 *
 * @returns {{ healthy: boolean, report: { status: 'ok' | 'degraded' } }}
 *   `healthy` drives the HTTP status code; `report` is the response payload.
 */
export function buildHealthReport() {
  // The API is only considered healthy when its critical dependencies are.
  const healthy = getDatabaseStatus().healthy

  return {
    healthy,
    report: { status: healthy ? 'ok' : 'degraded' },
  }
}

export default { buildHealthReport }
