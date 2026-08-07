#!/usr/bin/env node
/**
 * Seeds a realistic mailbox, folders, messages and sync history.
 *
 * Run with:  npm run seed:provider [-- --reset]
 *
 * Drives the **real** sync engine against the mock adapter rather than inserting
 * documents directly. That distinction matters: hand-written fixtures can be
 * shaped in ways the application would never actually produce, and a demo built
 * on them hides bugs instead of surfacing them. Everything created here went
 * through the same code path a live sync uses.
 *
 * Safe to re-run. Duplicate detection means a second run updates rather than
 * duplicating, which is itself worth demonstrating.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Mail } from '../src/models/mail.model.js'
import { Mailbox } from '../src/models/mailbox.model.js'
import { MailboxFolder } from '../src/models/mailboxFolder.model.js'
import { ProviderToken } from '../src/models/providerToken.model.js'
import { SyncHistory } from '../src/models/syncHistory.model.js'
import { SyncState } from '../src/models/syncState.model.js'
import { User } from '../src/models/user.model.js'
import { CONNECTION_STATUS, PROVIDER_TYPES } from '../src/modules/provider/constants/providerTypes.js'
import { SYNCABLE_FOLDERS } from '../src/modules/provider/constants/folderTypes.js'
import { SYNC_MODE, SYNC_TRIGGER } from '../src/modules/provider/constants/syncStatus.js'
import { MockEmailProvider } from '../src/modules/provider/providers/mock/MockEmailProvider.js'
import * as mailboxRepo from '../src/modules/provider/repositories/mailbox.repository.js'
import { SyncEngine } from '../src/modules/provider/services/syncEngine.js'
import { tokenManager } from '../src/modules/provider/services/tokenManager.js'

const out = (line = '') => process.stdout.write(`${line}\n`)

const SEED_EMAIL = 'demo.user@contoso.com'

/** Removes only what this script creates, never a real user's data. */
async function reset(user) {
  const mailboxes = await Mailbox.find({ user: user._id, provider: PROVIDER_TYPES.MOCK })
  const ids = mailboxes.map((mailbox) => mailbox._id)

  if (ids.length === 0) return 0

  const [mail, folders, states, history, tokens] = await Promise.all([
    Mail.deleteMany({ mailbox: { $in: ids } }),
    MailboxFolder.deleteMany({ mailbox: { $in: ids } }),
    SyncState.deleteMany({ mailbox: { $in: ids } }),
    SyncHistory.deleteMany({ mailbox: { $in: ids } }),
    ProviderToken.deleteMany({ mailbox: { $in: ids } }),
  ])

  await Mailbox.deleteMany({ _id: { $in: ids } })

  out(
    `  Removed ${mail.deletedCount} messages, ${folders.deletedCount} folders, ` +
      `${states.deletedCount} sync states, ${history.deletedCount} runs, ` +
      `${tokens.deletedCount} tokens, ${ids.length} mailboxes.`,
  )

  return ids.length
}

async function main() {
  const shouldReset = process.argv.includes('--reset')

  out()
  out('='.repeat(70))
  out('  SEEDING PROVIDER DEMO DATA')
  out('='.repeat(70))
  out(`  database : ${config.database.uri}`)
  out(`  provider : ${PROVIDER_TYPES.MOCK} (simulated — no network calls)`)
  out()

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 5000 })

  /**
   * Attach to a real signed-in user when one exists, so the seeded mailbox shows
   * up in that person's UI. Falls back to a demo user otherwise.
   */
  let user = await User.findOne().sort({ lastLoginAt: -1 })

  if (!user) {
    user = await User.findOneAndUpdate(
      { microsoftId: 'seed-demo-user', tenantId: 'seed-demo-tenant' },
      {
        $set: {
          displayName: 'Demo User',
          email: SEED_EMAIL,
          userPrincipalName: SEED_EMAIL,
          lastLoginAt: new Date(),
        },
        $setOnInsert: { microsoftId: 'seed-demo-user', tenantId: 'seed-demo-tenant' },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )
    out(`  Created a demo user (no signed-in user was found).`)
  }

  out(`  user     : ${user.email ?? user.displayName} (${user._id})`)
  out()

  if (shouldReset) {
    out('  --reset given, clearing previously seeded data:')
    await reset(user)
    out()
  }

  // --- Mailbox -------------------------------------------------------------
  const provider = new MockEmailProvider()
  const details = await provider.connect({ mailbox: { emailAddress: SEED_EMAIL } })

  const mailbox = await mailboxRepo.upsertMailbox({
    user: user._id,
    provider: PROVIDER_TYPES.MOCK,
    providerAccountId: details.mailbox.providerAccountId,
    emailAddress: details.mailbox.emailAddress,
    displayName: details.mailbox.displayName,
    capabilities: [...provider.capabilities],
  })

  out(`  Mailbox   : ${mailbox.emailAddress} (${mailbox._id})`)

  await tokenManager.recordConnection({
    mailbox,
    provider: PROVIDER_TYPES.MOCK,
    status: CONNECTION_STATUS.CONNECTED,
    scope: ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'User.Read'],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })

  out('  Token     : recorded, expires in 1 hour')

  // --- Folders -------------------------------------------------------------
  const { folders } = await provider.syncFolders({ mailbox })
  const folderResult = await mailboxRepo.syncFolderRecords({
    user: user._id,
    mailboxId: mailbox._id,
    folders,
  })

  out(
    `  Folders   : ${folderResult.created} created, ${folderResult.updated} updated, ` +
      `${folderResult.removed} marked removed`,
  )

  // --- Sync runs -----------------------------------------------------------
  const engine = new SyncEngine()

  out()
  out('  Running syncs through the real engine…')
  out()

  // A first full sync, then an incremental one, then a per-folder run. Three
  // runs so the history page has variety to display rather than one row.
  const runs = [
    { label: 'initial full sync', folders: SYNCABLE_FOLDERS, mode: SYNC_MODE.FULL, trigger: SYNC_TRIGGER.INITIAL },
    { label: 'incremental sync', folders: SYNCABLE_FOLDERS, mode: SYNC_MODE.INCREMENTAL, trigger: SYNC_TRIGGER.SCHEDULED },
    { label: 'inbox only', folders: ['inbox'], mode: SYNC_MODE.INCREMENTAL, trigger: SYNC_TRIGGER.MANUAL },
  ]

  for (const { label, folders: targets, mode, trigger } of runs) {
    const run = await engine.run({
      provider,
      mailbox,
      user,
      folders: targets,
      mode,
      trigger,
      isMock: true,
    })

    out(
      `    ${label.padEnd(20)} ${run.status.padEnd(9)} ` +
        `+${run.totals.messagesCreated} new  ~${run.totals.messagesUpdated} updated  ` +
        `=${run.totals.messagesSkipped} unchanged  (${run.durationMs}ms)`,
    )
  }

  // --- Summary -------------------------------------------------------------
  const [messageCount, folderCount, runCount, unread] = await Promise.all([
    Mail.countDocuments({ mailbox: mailbox._id }),
    MailboxFolder.countDocuments({ mailbox: mailbox._id }),
    SyncHistory.countDocuments({ mailbox: mailbox._id }),
    Mail.countDocuments({ mailbox: mailbox._id, isRead: false }),
  ])

  const byFolder = await Mail.aggregate([
    { $match: { mailbox: mailbox._id } },
    { $group: { _id: '$folder', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ])

  out()
  out('-'.repeat(70))
  out('  RESULT')
  out('-'.repeat(70))
  out(`  messages  : ${messageCount} (${unread} unread)`)
  for (const entry of byFolder) {
    out(`              ${String(entry._id).padEnd(10)} ${entry.count}`)
  }
  out(`  folders   : ${folderCount}`)
  out(`  sync runs : ${runCount}`)
  out()
  out('  Open the app and visit /provider to see it.')
  out('  Re-running is safe: duplicate detection updates rather than duplicates.')
  out()

  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  out(`\n  SEED FAILED: ${error?.message ?? error}`)
  out(error?.stack?.split('\n').slice(1, 4).join('\n') ?? '')
} finally {
  out('='.repeat(70))
  await mongoose.disconnect().catch(() => {})
}

process.exit(exitCode)
