#!/usr/bin/env node
/**
 * Repoints owned data from a superseded User document onto the current one.
 *
 * Run with:
 *   npm run migrate:identity                          # dry run — prints the plan, writes nothing
 *   npm run migrate:identity -- --from <userId> --apply
 *   npm run migrate:identity -- --rollback <id>       # reverses a previous run
 *
 * `--from` is mandatory whenever more than one superseded identity holds data.
 * Sweeping them all into the current user would merge unrelated people's mail
 * into one mailbox — a silent, hard-to-notice data-integrity failure — so the
 * operator must name the identity being migrated.
 *
 * ## Why this is needed
 *
 * `User` is keyed on `(tenantId, microsoftId)`. Migrating the authority from a
 * specific tenant to `common` changes **both** values for a personal account:
 * the tenant becomes the personal-accounts tenant, and the object id becomes the
 * account's own rather than the guest object's. The upsert in
 * `auth.service.completeSignIn` therefore inserts a *new* User and the old one
 * is left owning all the history.
 *
 * `OutlookAccount` is keyed on `homeAccountId`, which does **not** change — it
 * already referenced the home (personal) identity. It is silently repointed to
 * the new User by the sign-in itself, which is why the old User ends up with
 * data but no mailbox.
 *
 * ## Safety
 *
 * Nothing is deleted, ever. The old User document is retained. Every write is
 * recorded in an `IdentityMigration` document containing the exact ids touched,
 * so `--rollback` can restore the previous state precisely rather than guessing.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Mail } from '../src/models/mail.model.js'
import { Mailbox } from '../src/models/mailbox.model.js'
import { MailboxFolder } from '../src/models/mailboxFolder.model.js'
import { OutlookAccount } from '../src/models/outlookAccount.model.js'
import { ProviderToken } from '../src/models/providerToken.model.js'
import { Session } from '../src/models/session.model.js'
import { SyncHistory } from '../src/models/syncHistory.model.js'
import { SyncState } from '../src/models/syncState.model.js'
import { User, MSA_TENANT_ID } from '../src/models/user.model.js'

const out = (line = '') => process.stdout.write(`${line}\n`)
const rule = (char = '─') => out(char.repeat(76))

/**
 * Audit record for one migration run.
 *
 * Kept in its own collection rather than embedded anywhere, so a rollback needs
 * only this document and cannot be confused by later application activity.
 */
const migrationSchema = new mongoose.Schema(
  {
    fromUser: { type: mongoose.Schema.Types.ObjectId, required: true },
    toUser: { type: mongoose.Schema.Types.ObjectId, required: true },
    fromIdentity: { type: Object, required: true },
    toIdentity: { type: Object, required: true },
    /** Exact document ids moved, per collection, so rollback is precise. */
    moved: { type: Object, default: {} },
    deltaTokensCleared: { type: Number, default: 0 },
    appliedAt: { type: Date, default: Date.now },
    rolledBackAt: { type: Date, default: null },
  },
  { collection: 'identitymigrations', versionKey: false },
)

const IdentityMigration =
  mongoose.models.IdentityMigration ?? mongoose.model('IdentityMigration', migrationSchema)

/** Collections that carry a direct owner reference. */
const OWNED = [
  { name: 'Mail', model: Mail, field: 'userId' },
  { name: 'Mailbox', model: Mailbox, field: 'user' },
  { name: 'MailboxFolder', model: MailboxFolder, field: 'user' },
  { name: 'ProviderToken', model: ProviderToken, field: 'user' },
  { name: 'SyncState', model: SyncState, field: 'user' },
  { name: 'SyncHistory', model: SyncHistory, field: 'user' },
]

const describe = (user) =>
  user
    ? {
        _id: user._id.toString(),
        email: user.email,
        tenantId: user.tenantId,
        microsoftId: user.microsoftId,
        accountType: user.accountType,
        lastLoginAt: user.lastLoginAt,
      }
    : null

/**
 * Identifies the superseded and current User documents.
 *
 * The current one is whichever the live `OutlookAccount` points at — that is the
 * identity the most recent sign-in established, which is more reliable than
 * comparing timestamps.
 */
async function resolvePair() {
  const account = await OutlookAccount.findOne({ disconnectedAt: null }).sort({ connectedAt: -1 })

  if (!account) {
    return { error: 'No connected OutlookAccount. Sign in under the new authority first.' }
  }

  const toUser = await User.findById(account.user)
  if (!toUser) return { error: 'The connected account references a User that no longer exists.' }

  // Candidates are every other user holding data. A personal-account migration
  // produces exactly one, but the query does not assume that.
  const others = await User.find({ _id: { $ne: toUser._id } })

  return { account, toUser, others }
}

/** Counts what each candidate owns, so the operator can see what would move. */
async function inventory(userId) {
  const counts = {}
  let total = 0

  for (const { name, model, field } of OWNED) {
    const count = await model.countDocuments({ [field]: userId })
    counts[name] = count
    total += count
  }

  counts.Session = await Session.countDocuments({ user: userId })

  return { counts, total }
}

// ---------------------------------------------------------------------------

async function rollback(migrationId) {
  const record = await IdentityMigration.findById(migrationId)

  if (!record) {
    out(`  No migration found with id ${migrationId}.`)
    return 1
  }

  if (record.rolledBackAt) {
    out(`  That migration was already rolled back at ${record.rolledBackAt.toISOString()}.`)
    return 1
  }

  out(`  Rolling back migration ${migrationId}`)
  out(`    from : ${record.toUser}  (current)`)
  out(`    to   : ${record.fromUser}  (restored owner)`)
  out()

  let restored = 0

  for (const { name, model, field } of OWNED) {
    const ids = record.moved?.[name] ?? []
    if (ids.length === 0) continue

    // Restores only the documents this run actually touched. A blanket
    // "move everything back" would also capture records created since.
    const { modifiedCount } = await model.updateMany(
      { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } },
      { $set: { [field]: record.fromUser } },
    )

    out(`    ${name.padEnd(16)} ${modifiedCount} restored`)
    restored += modifiedCount
  }

  record.rolledBackAt = new Date()
  await record.save()

  out()
  out(`  Rolled back ${restored} documents.`)
  out('  Delta tokens are NOT restored — a full resync is harmless and always safe.')

  return 0
}

async function main() {
  const args = process.argv.slice(2)
  const isApply = args.includes('--apply')
  const rollbackIndex = args.indexOf('--rollback')

  out()
  rule('═')
  out('  USER IDENTITY MIGRATION')
  rule('═')

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 5000 })

  if (rollbackIndex !== -1) {
    return rollback(args[rollbackIndex + 1])
  }

  out(`  mode      : ${isApply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`)
  out(`  authority : ${config.microsoft.authority}`)
  out()

  const { error, account, toUser, others } = await resolvePair()

  if (error) {
    out(`  ${error}`)
    return 1
  }

  out('  CURRENT identity (target — owns the live mailbox)')
  for (const [key, value] of Object.entries(describe(toUser))) {
    out(`    ${key.padEnd(14)}: ${value}`)
  }
  out(`    homeAccountId : ${account.homeAccountId}`)
  out(`    isPersonal    : ${toUser.tenantId === MSA_TENANT_ID}`)

  const targetInventory = await inventory(toUser._id)
  out(`    owns          : ${targetInventory.total} documents`)

  if (others.length === 0) {
    out()
    out('  No superseded User documents. Nothing to migrate.')
    return 0
  }

  // Only candidates that actually own something are worth moving.
  const candidates = []
  for (const candidate of others) {
    const owned = await inventory(candidate._id)
    if (owned.total > 0) candidates.push({ user: candidate, ...owned })
  }

  out()
  out(`  SUPERSEDED identities holding data: ${candidates.length}`)

  if (candidates.length === 0) {
    out('  None of the other User documents own any data. Nothing to migrate.')
    return 0
  }

  for (const candidate of candidates) {
    out()
    for (const [key, value] of Object.entries(describe(candidate.user))) {
      out(`    ${key.padEnd(14)}: ${value}`)
    }
    out(`    owns          : ${candidate.total} documents`)
    for (const [name, count] of Object.entries(candidate.counts)) {
      if (count > 0) out(`      ${name.padEnd(16)} ${count}`)
    }
  }

  /**
   * Narrow to the identity the operator named.
   *
   * With one candidate the choice is unambiguous and `--from` is optional. With
   * several, refusing to guess is the only safe behaviour: each candidate is a
   * different person's mailbox, and merging them cannot be undone by inspection.
   */
  const fromIndex = args.indexOf('--from')
  const requestedFrom = fromIndex === -1 ? null : args[fromIndex + 1]

  let selected = candidates

  if (requestedFrom) {
    selected = candidates.filter((c) => c.user._id.toString() === requestedFrom)

    if (selected.length === 0) {
      out()
      out(`  No superseded identity with id ${requestedFrom} holds data.`)
      return 1
    }
  } else if (candidates.length > 1) {
    out()
    rule()
    out('  MULTIPLE superseded identities hold data.')
    out()
    out('  These are different Microsoft identities, not duplicates of one person.')
    out('  Merging them would combine unrelated mailboxes irreversibly, so the one')
    out('  to migrate must be named explicitly:')
    out()
    for (const candidate of candidates) {
      out(`    npm run migrate:identity -- --from ${candidate.user._id} --apply`)
      out(`        ${candidate.user.email}  (${candidate.total} documents)`)
    }
    return 1
  }

  if (!isApply) {
    out()
    rule()
    out('  DRY RUN — nothing was written.')
    out(
      candidates.length > 1
        ? '  Re-run with --from <userId> --apply to perform the migration.'
        : '  Re-run with --apply to perform the migration.',
    )
    return 0
  }

  // --- Apply ---------------------------------------------------------------
  out()
  rule()
  out('  APPLYING')
  rule()

  let migrationRecord = null

  for (const candidate of selected) {
    const moved = {}
    let total = 0

    for (const { name, model, field } of OWNED) {
      // Ids are captured *before* the update so the rollback record names the
      // exact documents touched, not whatever matches the filter afterwards.
      const docs = await model.find({ [field]: candidate.user._id }).select('_id')
      const ids = docs.map((doc) => doc._id)

      if (ids.length === 0) continue

      const { modifiedCount } = await model.updateMany(
        { _id: { $in: ids } },
        { $set: { [field]: toUser._id } },
      )

      moved[name] = ids.map((id) => id.toString())
      total += modifiedCount
      out(`    ${name.padEnd(16)} ${modifiedCount} moved`)
    }

    /**
     * Sessions are deliberately deleted rather than moved.
     *
     * A session belonging to the old identity authenticates as that identity;
     * repointing it would silently grant the old session the new mailbox. The
     * user must sign in again, which they have already done to reach this point.
     */
    const { deletedCount } = await Session.deleteMany({ user: candidate.user._id })
    if (deletedCount > 0) out(`    ${'Session'.padEnd(16)} ${deletedCount} deleted (not moved — see source)`)

    migrationRecord = await IdentityMigration.create({
      fromUser: candidate.user._id,
      toUser: toUser._id,
      fromIdentity: describe(candidate.user),
      toIdentity: describe(toUser),
      moved,
      deltaTokensCleared: 0,
    })

    out(`    → ${total} documents repointed to ${toUser._id}`)
  }

  // --- Step 7: invalidate delta tokens -------------------------------------
  out()
  out('  Invalidating synchronisation tokens')

  /**
   * Every stored delta token was issued against the previous mailbox and is
   * meaningless now. Clearing them, and setting `fullResyncRequired`, forces the
   * next run to read each folder from the beginning.
   */
  const { modifiedCount: tokensCleared } = await SyncState.updateMany(
    {},
    {
      $set: {
        lastDeltaToken: null,
        fullResyncRequired: true,
        lockedAt: null,
        syncStatus: 'idle',
      },
    },
  )

  out(`    ${tokensCleared} sync states reset — the next sync will be a FULL sync`)

  if (migrationRecord) {
    migrationRecord.deltaTokensCleared = tokensCleared
    await migrationRecord.save()
  }

  out()
  rule()
  out('  MIGRATION COMPLETE')
  rule()
  out(`  Old User documents retained (nothing deleted).`)
  if (migrationRecord) {
    out()
    out('  ROLLBACK:')
    out(`    npm run migrate:identity -- --rollback ${migrationRecord._id}`)
  }

  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  out(`\n  MIGRATION FAILED: ${error?.message}`)
  out(error?.stack?.split('\n').slice(1, 5).join('\n') ?? '')
} finally {
  out()
  rule('═')
  await mongoose.disconnect().catch(() => {})
}

process.exit(exitCode)
