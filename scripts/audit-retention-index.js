/**
 * Repairs the audit retention TTL index.
 *
 * ## Why this script exists
 *
 * The audit collection predates Phase 14.7. Its original schema declared
 * `occurredAt` with a field-level `index: true`, producing a plain index named
 * `occurredAt_1` over the key `{ occurredAt: 1 }`.
 *
 * Phase 14.7 declares the retention TTL over that same key. MongoDB permits
 * only one index per key pattern, and rejects the second **silently** as far as
 * Mongoose's background index build is concerned. The visible symptom is
 * nothing at all: the console reports "entries are deleted automatically after
 * 365 days", `AUDIT_RETENTION_DAYS` is set, and no entry is ever deleted.
 *
 * A fresh deployment is unaffected — the field-level index is gone from the
 * schema, so only the TTL is ever created. This is only for a database that ran
 * the earlier code.
 *
 * ## What it does
 *
 * Drops `occurredAt_1` if present, then lets Mongoose build the TTL index and
 * verifies it. Reads and reports if there is nothing to do. It never touches a
 * document — dropping an index does not delete data, though the TTL that
 * follows will begin expiring entries older than the configured window, which
 * is the point.
 *
 *   node scripts/audit-retention-index.js
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { AuditLog } from '../src/models/auditLog.model.js'

/** Matches `diagnose-graph.js`: scripts write to stdout, they do not `console`. */
const out = (line = '') => process.stdout.write(`${line}\n`)

const TTL_NAME = 'audit_retention_ttl'
const STALE_NAME = 'occurredAt_1'

async function main() {
  await mongoose.connect(config.database.uri, config.database.options)

  const before = await AuditLog.collection.indexes()
  const names = before.map((index) => index.name)

  out(`Collection: auditlogs (${before.length} indexes)`)
  out(`Retention:  ${config.audit.retentionEnabled ? `${config.audit.retentionDays} days` : 'disabled'}`)

  if (!config.audit.retentionEnabled) {
    const ttl = before.find((index) => index.name === TTL_NAME)

    if (ttl) {
      // A TTL left behind after retention was switched off would keep deleting
      // records the operator now intends to keep — the failure mode that
      // matters most under a legal hold.
      await AuditLog.collection.dropIndex(TTL_NAME)
      out(`Dropped ${TTL_NAME}: retention is disabled and the index would still expire records.`)
    } else {
      out('Nothing to do: retention is disabled and no TTL index exists.')
    }

    await mongoose.disconnect()
    return
  }

  if (names.includes(STALE_NAME)) {
    await AuditLog.collection.dropIndex(STALE_NAME)
    out(`Dropped ${STALE_NAME} — it was shadowing the retention TTL.`)
  } else {
    out(`No stale ${STALE_NAME} index found.`)
  }

  // Builds anything the schema declares that the collection does not have.
  // Additive: it does not drop indexes that are absent from the schema.
  await AuditLog.createIndexes()

  const after = await AuditLog.collection.indexes()
  const ttl = after.find((index) => index.name === TTL_NAME)
  const expected = config.audit.retentionDays * 86_400

  if (ttl?.expireAfterSeconds === expected) {
    out(`OK: ${TTL_NAME} is active with expireAfterSeconds=${expected}.`)
  } else {
    out(`FAILED: ${TTL_NAME} is ${ttl ? `set to ${ttl.expireAfterSeconds}s` : 'missing'}, expected ${expected}s.`)
    await mongoose.disconnect()
    process.exit(1)
  }

  await mongoose.disconnect()
}

main().catch(async (error) => {
  out(`audit-retention-index failed: ${error.message}`)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
