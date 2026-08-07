#!/usr/bin/env node
/**
 * Makes the users collection safe for Google-authenticated accounts.
 *
 * Run once per environment:  npm run migrate:google-index
 *
 * ## What it fixes, and why a script is required
 *
 * `users` carries a unique compound index on `(tenantId, microsoftId)`. A user
 * authenticated by Google has neither field, and MongoDB indexes an absent
 * field as null — so the first Google-only account is admitted and every one
 * after it is rejected with a duplicate-key error on `(null, null)`. The
 * failure is invisible until a *second* person tries to sign in.
 *
 * Phase 13.1 redefines the index with a partial filter that restricts it to
 * documents actually holding a Microsoft object id. MongoDB cannot change an
 * existing index's options in place — `createIndex` with different options
 * raises `IndexOptionsConflict` — so Mongoose's automatic index build silently
 * leaves the old definition alone. The old index must be dropped once, by hand,
 * which is what this does.
 *
 * ## Safety
 *
 * Dropping a unique index cannot lose data: the documents are untouched and the
 * replacement is created immediately afterwards, enforcing the same constraint
 * over the same set of Microsoft users. The script is idempotent — running it
 * again when the index is already correct reports that and exits.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { User } from '../src/models/user.model.js'

const LEGACY_INDEX = 'tenantId_1_microsoftId_1'

/** True when the index already carries the partial filter this phase needs. */
function isAlreadyMigrated(index) {
  return Boolean(index?.partialFilterExpression?.microsoftId)
}

async function main() {
  await mongoose.connect(config.database.uri, config.database.options)
  const collection = mongoose.connection.db.collection('users')

  const before = await collection.indexes()
  const legacy = before.find((index) => index.name === LEGACY_INDEX)

  process.stdout.write(`\nDatabase: ${mongoose.connection.name}\n`)
  process.stdout.write(`Users:    ${await collection.countDocuments()}\n\n`)

  if (!legacy) {
    process.stdout.write(`No "${LEGACY_INDEX}" index found. Nothing to migrate.\n`)
  } else if (isAlreadyMigrated(legacy)) {
    process.stdout.write(`"${LEGACY_INDEX}" already has a partial filter. Nothing to do.\n`)
  } else {
    /**
     * A dry run by default.
     *
     * Dropping an index on a live collection is a deliberate act. Requiring
     * `--apply` means an accidental invocation reports what it would do and
     * changes nothing.
     */
    if (!process.argv.includes('--apply')) {
      process.stdout.write(
        `Would drop "${LEGACY_INDEX}" and let Mongoose rebuild it with a partial filter.\n` +
          'Re-run with --apply to perform the change.\n',
      )
      await mongoose.disconnect()
      return
    }

    process.stdout.write(`Dropping "${LEGACY_INDEX}"…\n`)
    await collection.dropIndex(LEGACY_INDEX)
    process.stdout.write('Dropped.\n')
  }

  // Rebuilds every index the schema declares, including the two partial ones.
  // Safe to run unconditionally: existing, correct indexes are left as they are.
  process.stdout.write('Synchronising indexes from the schema…\n')
  await User.syncIndexes()

  const after = await collection.indexes()
  process.stdout.write('\nIndexes now on users:\n')
  for (const index of after) {
    const partial = index.partialFilterExpression
      ? ` partial=${JSON.stringify(index.partialFilterExpression)}`
      : ''
    process.stdout.write(
      `  ${index.name}  ${JSON.stringify(index.key)}${index.unique ? ' unique' : ''}${partial}\n`,
    )
  }

  process.stdout.write('\nDone. Google-authenticated users can now be created.\n')
  await mongoose.disconnect()
}

main().catch(async (error) => {
  process.stderr.write(`\nMigration failed: ${error.message}\n`)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
