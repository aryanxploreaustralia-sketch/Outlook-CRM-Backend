#!/usr/bin/env node
/**
 * Brings existing installations onto the Phase 13.2 multi-mailbox model.
 *
 * Dry run:  npm run migrate:mailboxes
 * Apply:    npm run migrate:mailboxes -- --apply
 *
 * ## What it does, and why each part is needed
 *
 * Phase 13.2 did not introduce a new credential store. `Mailbox` has existed
 * since Phase 5 with a per-user unique key of `(user, provider,
 * providerAccountId)`, and the encrypted MSAL cache has lived on
 * `OutlookAccount` since Phase 2. Multi-mailbox was therefore already
 * expressible, and no data has to be moved or re-encrypted. Two things are
 * nonetheless left over from the single-mailbox world:
 *
 *  1. **Adoption.** A user who signed in during Phase 2 and never touched the
 *     provider API has an `OutlookAccount` and no `Mailbox`. Until something
 *     calls `resolveContext`, the Account page would show them no mailboxes at
 *     all — which reads as "your mailbox is gone" rather than "not materialised
 *     yet". This creates the missing `Mailbox` from the existing grant.
 *
 *  2. **Defaults.** `isDefault` is new, so every existing mailbox has it false.
 *     Unattended mail would then fall back to "newest connected" on every run
 *     instead of a recorded decision. This elects one default per user.
 *
 * It also creates the new partial unique index that enforces one default per
 * user, since Mongoose will not add an index to a collection that already has
 * documents violating it — and electing the defaults first guarantees it does
 * not.
 *
 * ## Safety
 *
 * Nothing is deleted, no token is read, decrypted, re-encrypted or moved, and
 * no existing field is overwritten except `isDefault`, which did not exist
 * before this phase. Idempotent: a second run finds every mailbox adopted and
 * every user with a default, and reports that it has nothing to do.
 *
 * The default elected for a user is the **oldest connected** mailbox, matching
 * `ensureDefaultMailbox` exactly, so the migration and the running application
 * cannot disagree about which mailbox a workspace sends from.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Mailbox } from '../src/models/mailbox.model.js'
import { OutlookAccount } from '../src/models/outlookAccount.model.js'
import { User } from '../src/models/user.model.js'
import { CONNECTION_STATUS, PROVIDER_TYPES } from '../src/modules/provider/constants/providerTypes.js'

const APPLY = process.argv.includes('--apply')

const out = (line) => process.stdout.write(`${line}\n`)

/**
 * Materialises a `Mailbox` for every `OutlookAccount` that lacks one.
 *
 * Keyed on `homeAccountId` as `providerAccountId`, which is what the running
 * code uses, so an adopted mailbox is indistinguishable from one the
 * application would have created itself.
 */
async function adoptLegacyAccounts() {
  const accounts = await OutlookAccount.find({})
  const adopted = []

  for (const account of accounts) {
    if (!account.user) {
      out(`  ! skipped an OutlookAccount with no user: ${account._id}`)
      continue
    }

    const existing = await Mailbox.findOne({
      user: account.user,
      provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
      providerAccountId: account.homeAccountId,
    })

    if (existing) continue

    const user = await User.findById(account.user)

    const payload = {
      user: account.user,
      provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
      providerAccountId: account.homeAccountId,
      emailAddress: account.email ?? null,
      displayName: user?.displayName ?? null,
      sourceAccount: account._id,
      capabilities: ['send', 'read', 'folders'],
      // The grant's own state is carried across rather than assumed healthy: a
      // connection that was already broken must not come back marked connected.
      status: account.disconnectedAt
        ? CONNECTION_STATUS.DISCONNECTED
        : CONNECTION_STATUS.CONNECTED,
      statusReason: account.disconnectReason ?? null,
      connectedAt: account.connectedAt ?? account.createdAt ?? new Date(),
      disconnectedAt: account.disconnectedAt ?? null,
    }

    adopted.push({ user: String(account.user), email: account.email })

    if (APPLY) await Mailbox.create(payload)
  }

  return adopted
}

/**
 * Elects one default mailbox per user that has none.
 *
 * Oldest connected first — the same rule `ensureDefaultMailbox` applies, so the
 * choice is deterministic and matches what the application would pick.
 */
async function electDefaults() {
  const userIds = await Mailbox.distinct('user')
  const elected = []

  for (const userId of userIds) {
    const current = await Mailbox.findOne({ user: userId, isDefault: true })
    if (current) continue

    const candidate = await Mailbox.findOne({
      user: userId,
      status: CONNECTION_STATUS.CONNECTED,
    }).sort({ connectedAt: 1 })

    if (!candidate) {
      out(`  · ${userId}: no connected mailbox, so no default. Correct.`)
      continue
    }

    elected.push({ user: String(userId), email: candidate.emailAddress })

    if (APPLY) {
      await Mailbox.updateOne({ _id: candidate._id }, { $set: { isDefault: true } })
    }
  }

  return elected
}

async function main() {
  await mongoose.connect(config.database.uri, config.database.options)

  out(`\nDatabase: ${mongoose.connection.name}`)
  out(`Mode:     ${APPLY ? 'APPLY — changes will be written' : 'DRY RUN — nothing will be written'}\n`)

  out(`Outlook accounts: ${await OutlookAccount.countDocuments()}`)
  out(`Mailboxes:        ${await Mailbox.countDocuments()}\n`)

  out('1. Adopting Phase 2 connections that have no Mailbox record…')
  const adopted = await adoptLegacyAccounts()
  if (adopted.length === 0) out('   Nothing to adopt.')
  for (const item of adopted) out(`   ${APPLY ? '+' : 'would add'} ${item.email ?? '(no address)'}`)

  out('\n2. Electing a default mailbox per workspace…')
  const elected = await electDefaults()
  if (elected.length === 0) out('   Every workspace already has a default, or has no mailbox.')
  for (const item of elected) {
    out(`   ${APPLY ? '*' : 'would set'} ${item.email ?? '(no address)'} as default`)
  }

  /**
   * The index is created only on apply, and only after defaults are elected.
   *
   * `syncIndexes` would fail if two mailboxes for one user already carried
   * `isDefault: true` — which cannot happen here, because the field is new and
   * step 2 sets at most one per user.
   */
  if (APPLY) {
    out('\n3. Synchronising indexes from the schema…')
    await Mailbox.syncIndexes()

    const indexes = await mongoose.connection.db.collection('mailboxes').indexes()
    for (const index of indexes) {
      const partial = index.partialFilterExpression
        ? ` partial=${JSON.stringify(index.partialFilterExpression)}`
        : ''
      out(`   ${index.name} ${JSON.stringify(index.key)}${index.unique ? ' unique' : ''}${partial}`)
    }
  } else {
    out('\n3. Would synchronise indexes, adding the unique partial index on (user, isDefault).')
  }

  out(
    APPLY
      ? '\nDone. Existing mailboxes are adopted and each workspace has one default.'
      : '\nDry run complete. Re-run with --apply to write these changes.',
  )

  await mongoose.disconnect()
}

main().catch(async (error) => {
  process.stderr.write(`\nMigration failed: ${error.message}\n`)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
