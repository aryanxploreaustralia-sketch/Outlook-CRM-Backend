#!/usr/bin/env node
/**
 * Rewrites lead stages onto the four-word vocabulary.
 *
 * Run once per environment:  npm run migrate:lead-stages
 * Inspect first without writing:  npm run migrate:lead-stages -- --dry-run
 *
 * ## Why this is required
 *
 * The pipeline used to carry ten stages. It now carries the four the sales
 * workbook has always used — `active`, `confirmed`, `inactive`, `closed` — and
 * `Lead.stage` is an enum of exactly those.
 *
 * Documents written before the change still hold the old strings. Mongoose
 * validates on write, not on read, so nothing breaks while a lead is merely
 * displayed: the application reads those values through `normaliseStage` and
 * shows them correctly. But the first `save()` on such a lead — an edit, a
 * stage change, a reply arriving against it — is rejected by the enum, and the
 * lead becomes uneditable. That is the failure this prevents.
 *
 * ## What it changes
 *
 * `stage`, and the `to`/`from` values inside `stageHistory` so the audit trail
 * stays readable. The mapping is `LEGACY_STAGE_ALIASES`, which is the same
 * table the running application reads with, so a migrated document and an
 * unmigrated one are displayed identically:
 *
 *   new, quoted, interested, negotiation, visa_process  ->  active
 *   follow_up                                           ->  inactive
 *   booked                                              ->  confirmed
 *   completed, cancelled, lost                          ->  closed
 *
 * ## Safety
 *
 * No document is deleted and no field is removed or renamed. Only stage strings
 * are rewritten, and only where they are recognisably one of the ten old
 * values — anything already on the new vocabulary is skipped, which makes the
 * script idempotent. `--dry-run` reports exactly what would change and writes
 * nothing.
 *
 * The collapse of `completed`/`cancelled`/`lost` into `closed` is lossy and
 * cannot be undone by re-running anything, so take a backup first. The counts
 * printed before the write tell you how many documents each rule affects.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Lead } from '../src/models/lead.model.js'
import {
  LEAD_STAGE_VALUES,
  LEGACY_STAGE_ALIASES,
} from '../src/modules/leads/constants/leadConstants.js'

const DRY_RUN = process.argv.includes('--dry-run')

/** Rewrites one stage string, or returns null when it needs no change. */
function migrated(stage) {
  if (typeof stage !== 'string') return null
  if (LEAD_STAGE_VALUES.includes(stage)) return null
  return LEGACY_STAGE_ALIASES[stage] ?? null
}

async function main() {
  await mongoose.connect(config.database.uri, config.database.options)

  const legacyValues = Object.keys(LEGACY_STAGE_ALIASES)

  // Reported before anything is written, so the operator sees the shape of the
  // change while it is still refusable.
  const breakdown = await Lead.aggregate([
    { $match: { stage: { $in: legacyValues } } },
    { $group: { _id: '$stage', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ])

  const total = breakdown.reduce((sum, row) => sum + row.count, 0)

  console.log(DRY_RUN ? '\nDRY RUN — nothing will be written.\n' : '\nMigrating lead stages.\n')

  if (total === 0) {
    console.log('  No leads hold a superseded stage. Nothing to do.')
    await mongoose.disconnect()
    return
  }

  console.log('  Documents to rewrite, by current stage:')
  for (const row of breakdown) {
    console.log(`    ${String(row.count).padStart(6)}  ${row._id.padEnd(14)} -> ${LEGACY_STAGE_ALIASES[row._id]}`)
  }
  console.log(`    ${String(total).padStart(6)}  total\n`)

  if (DRY_RUN) {
    console.log('  Re-run without --dry-run to apply.')
    await mongoose.disconnect()
    return
  }

  let updated = 0
  let historyRewritten = 0

  // One document at a time rather than a bulk `$set` per stage: `stageHistory`
  // needs a per-entry rewrite, which no single update expression can express
  // without an aggregation pipeline that would be far harder to read than this.
  const cursor = Lead.find({ stage: { $in: legacyValues } })
    .select('stage stageHistory')
    .cursor()

  for await (const lead of cursor) {
    const next = migrated(lead.stage)
    if (!next) continue

    const update = { stage: next }

    if (Array.isArray(lead.stageHistory) && lead.stageHistory.length > 0) {
      const history = lead.stageHistory.map((entry) => ({
        ...(entry.toObject?.() ?? entry),
        to: migrated(entry.to) ?? entry.to,
        from: migrated(entry.from) ?? entry.from,
      }))

      const changed = history.some(
        (entry, index) =>
          entry.to !== lead.stageHistory[index].to || entry.from !== lead.stageHistory[index].from,
      )

      if (changed) {
        update.stageHistory = history
        historyRewritten += 1
      }
    }

    // `updateOne` rather than `save()`: the document was loaded with a stage the
    // enum no longer admits, so validating it on the way out would reject the
    // very write that fixes it.
    await Lead.updateOne({ _id: lead._id }, { $set: update })
    updated += 1
  }

  console.log(`  Rewrote ${updated} lead(s); ${historyRewritten} also had stage history updated.`)

  const remaining = await Lead.countDocuments({ stage: { $nin: LEAD_STAGE_VALUES } })
  console.log(
    remaining === 0
      ? '  Every lead now holds one of the four stages.\n'
      : `  WARNING: ${remaining} lead(s) still hold an unrecognised stage. Inspect them by hand.\n`,
  )

  await mongoose.disconnect()
}

main().catch(async (error) => {
  console.error('\nMigration failed:', error.message)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
