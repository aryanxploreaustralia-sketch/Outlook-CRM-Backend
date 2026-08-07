#!/usr/bin/env node
/**
 * Clears business data, keeping authentication and the Microsoft connection.
 *
 * Run with:  npm run db:reset-business [-- --dry-run] [-- --force]
 *
 * For a development database being prepared for a fresh import. It is **not** a
 * production reset and refuses to behave like one — see the safety guards
 * below.
 *
 * ## What it will not touch
 *
 * Users, sessions, OAuth flows, Outlook accounts, provider tokens and mailboxes.
 * Signing in again after this script runs must work without re-consenting, so
 * anything that would force a reconnect is off limits.
 *
 * ## Two things that are not obviously business data, and why they go anyway
 *
 * **Sync cursors** (`syncstates`). A delta token is a bookmark into mail the
 * database has already seen. Deleting `mails` while keeping the bookmark means
 * the next sync runs incrementally, skips everything before the token, and the
 * mailbox is permanently missing the messages this script just removed. The
 * cursors go so the next sync is a full one. The mailbox connection itself
 * stays, so no reconnect is needed.
 *
 * **Attachment files on disk.** `conversationattachments` rows point at bytes
 * under `storage/attachments`. Removing the rows alone leaves orphan files that
 * nothing references and nothing will ever clean up.
 */

import { createInterface } from 'node:readline/promises'
import { rm, stat } from 'node:fs/promises'
import { stdin, stdout } from 'node:process'

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { STORAGE_ROOT } from '../src/modules/conversations/services/attachment.service.js'

const out = (line = '') => process.stdout.write(`${line}\n`)
const rule = (char = '─') => out(char.repeat(74))

/**
 * Collections to clear, children before parents.
 *
 * The order is the point: every entry is deleted before anything it references,
 * so at no moment does a surviving document point at a deleted one. A single
 * `deleteMany` per collection in arbitrary order would leave dangling
 * references for however long the run took, and a crash midway would leave them
 * permanently.
 */
const BUSINESS_COLLECTIONS = [
  // --- Conversations: attachments → messages → activity → threads ----------
  { name: 'conversationattachments', label: 'Conversation attachments', references: 'message, conversation, lead' },
  { name: 'conversationmessages', label: 'Conversation messages', references: 'conversation, lead, mail' },
  { name: 'conversationactivities', label: 'Lead timeline / notes', references: 'conversation, lead, task, message' },
  { name: 'leadtasks', label: 'Tasks and follow-ups', references: 'lead, conversation, message' },
  { name: 'conversations', label: 'Conversations', references: 'lead, company, contact, campaign' },

  // --- Campaigns: events → recipients → campaigns → templates --------------
  { name: 'campaignevents', label: 'Campaign events', references: 'campaign, recipient' },
  { name: 'campaignrecipients', label: 'Campaign recipients', references: 'campaign, contact, mail' },
  { name: 'campaigns', label: 'Campaigns', references: 'template, sequence, mailbox, contacts' },
  { name: 'campaignsequences', label: 'Follow-up sequences', references: 'template' },
  { name: 'campaigntemplates', label: 'Campaign templates', references: '—' },

  // --- The sales register: leads → groups → contacts → companies -----------
  { name: 'leads', label: 'Leads (enquiries)', references: 'company, contact, importJob, campaign' },
  { name: 'contactgroups', label: 'Contact groups', references: 'contacts' },
  { name: 'contacts', label: 'Contacts', references: 'companyId, importJob' },
  { name: 'companies', label: 'Companies', references: 'importJob' },

  // --- Mail history --------------------------------------------------------
  { name: 'mails', label: 'Mail history', references: 'mailbox, user' },

  // --- Import history ------------------------------------------------------
  { name: 'importjobs', label: 'Import jobs', references: 'user' },
  { name: 'importtemplates', label: 'Import mapping templates', references: 'user' },

  // --- Sync state: bookmarks into data that no longer exists ---------------
  {
    name: 'syncstates',
    label: 'Sync cursors (delta tokens)',
    references: 'mailbox',
    note: 'Kept mail would be unreachable otherwise — see the note at the top.',
  },
  { name: 'synchistories', label: 'Sync run history', references: 'mailbox', note: 'Describes syncs of deleted mail.' },
]

/** Never touched. Listed explicitly so the report can prove it. */
const PRESERVED_COLLECTIONS = [
  { name: 'users', label: 'Users' },
  { name: 'sessions', label: 'Sessions (stay signed in)' },
  { name: 'authflows', label: 'In-flight OAuth flows' },
  { name: 'outlookaccounts', label: 'Outlook accounts' },
  { name: 'providertokens', label: 'Encrypted provider tokens' },
  { name: 'mailboxes', label: 'Connected mailboxes' },
  { name: 'mailboxfolders', label: 'Mailbox folder mapping' },
  { name: 'identitymigrations', label: 'Identity migration record' },
]

/**
 * Refuses to run against anything that looks like production.
 *
 * A reset script is exactly the thing that gets run against the wrong database
 * at 6pm on a Friday. The guard is deliberately noisy and deliberately cannot
 * be silenced by `--force` alone.
 */
function assertDevelopmentTarget(uri) {
  const host = /\/\/(?:[^@]*@)?([^/:]+)/.exec(uri)?.[1] ?? ''
  const name = uri.split('/').pop()?.split('?')[0] ?? ''

  const isLocalHost = ['127.0.0.1', 'localhost', '::1', 'mongo', 'mongodb'].includes(host)
  const looksProduction = /prod|production|live/i.test(name) || /prod|production/i.test(host)

  if (looksProduction) {
    return {
      allowed: false,
      reason: `The target "${name}" on ${host} looks like production. This script will not run against it.`,
    }
  }

  if (!isLocalHost && process.env.ALLOW_REMOTE_RESET !== 'true') {
    return {
      allowed: false,
      reason:
        `${host} is not a local host. If this really is a remote development database, ` +
        're-run with ALLOW_REMOTE_RESET=true in the environment.',
    }
  }

  return { allowed: true, reason: null }
}

/** Counts documents in every named collection that exists. */
async function countAll(names) {
  const db = mongoose.connection.db
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name))

  const counts = {}
  for (const name of names) {
    counts[name] = existing.has(name) ? await db.collection(name).countDocuments() : null
  }
  return counts
}

/** Removes the attachment bytes whose rows are about to go. */
async function clearAttachmentStorage({ dryRun }) {
  try {
    await stat(STORAGE_ROOT)
  } catch {
    return { removed: false, reason: 'No attachment storage directory exists.' }
  }

  if (dryRun) return { removed: false, reason: `Would delete ${STORAGE_ROOT}` }

  await rm(STORAGE_ROOT, { recursive: true, force: true })
  return { removed: true, reason: `Deleted ${STORAGE_ROOT}` }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const force = args.includes('--force')
  const clearSeededMailboxes = args.includes('--clear-seeded-mailboxes')

  out()
  rule('═')
  out(`  RESET BUSINESS DATA${dryRun ? '  ·  DRY RUN, nothing will be deleted' : ''}`)
  rule('═')
  out(`  database : ${config.database.uri}`)
  out()

  const guard = assertDevelopmentTarget(config.database.uri)

  if (!guard.allowed) {
    out(`  REFUSED: ${guard.reason}`)
    out()
    return 1
  }

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 5000 })

  const businessNames = BUSINESS_COLLECTIONS.map((entry) => entry.name)
  const preservedNames = PRESERVED_COLLECTIONS.map((entry) => entry.name)

  const before = await countAll([...businessNames, ...preservedNames])

  // --- What will be cleared -------------------------------------------------
  out('  WILL BE CLEARED, children first so no orphan reference survives:')
  rule()
  out(`  ${'#'.padStart(3)}  ${'collection'.padEnd(26)} ${'documents'.padStart(9)}   references`)
  rule()

  let totalToDelete = 0

  for (const [index, entry] of BUSINESS_COLLECTIONS.entries()) {
    const count = before[entry.name]
    totalToDelete += count ?? 0

    out(
      `  ${String(index + 1).padStart(3)}  ${entry.label.padEnd(26)} ` +
        `${count === null ? '  (absent)' : String(count).padStart(9)}   ${entry.references}`,
    )

    if (entry.note) out(`       ↳ ${entry.note}`)
  }

  rule()
  out(`  ${''.padStart(3)}  ${'TOTAL'.padEnd(26)} ${String(totalToDelete).padStart(9)}`)
  out()

  // --- What will be kept ----------------------------------------------------
  out('  WILL BE PRESERVED:')
  rule()
  for (const entry of PRESERVED_COLLECTIONS) {
    const count = before[entry.name]
    out(`       ${entry.label.padEnd(30)} ${count === null ? '(absent)' : String(count).padStart(6)}`)
  }
  rule()
  out()
  out('  Attachment files under storage/attachments will also be removed —')
  out('  their rows are going, and orphan bytes would never be cleaned up.')
  out()

  /**
   * Mailboxes invented by the seed scripts.
   *
   * They live in a preserved collection because a mailbox is the Microsoft
   * connection, and deleting the wrong one costs a reconnect. But `enquiry@`
   * and friends were never real — they exist only so campaign rotation had
   * something to rotate across, and they clutter the sender picker.
   *
   * Removed only when asked for. Guessing which mailboxes are disposable is
   * not a call this script should make on its own.
   */
  const { Mailbox: MailboxModel } = await import('../src/models/mailbox.model.js')
  const seededMailboxes = await MailboxModel.find({ providerAccountId: /^(seed-|mock-)/ })

  if (seededMailboxes.length > 0) {
    out(`  ${seededMailboxes.length} mailbox(es) were created by seed scripts, not by a real connection:`)
    for (const mailbox of seededMailboxes) {
      out(`       ${String(mailbox.emailAddress).padEnd(28)} ${mailbox.providerAccountId}`)
    }
    out(
      clearSeededMailboxes
        ? '  These WILL be removed (--clear-seeded-mailboxes was passed).'
        : '  These are kept. Pass --clear-seeded-mailboxes to remove them too.',
    )
    out()
  }

  if (dryRun) {
    out('  Dry run. Nothing was deleted. Re-run without --dry-run to apply.')
    out()
    return 0
  }

  // --- Confirmation ---------------------------------------------------------
  if (!force) {
    if (!stdin.isTTY) {
      out('  REFUSED: no terminal is attached, so the confirmation cannot be answered.')
      out('  Re-run with --force if you are sure, or --dry-run to see the plan.')
      out()
      return 1
    }

    const rl = createInterface({ input: stdin, output: stdout })
    const answer = await rl.question(
      `  Delete ${totalToDelete} document(s) from ${BUSINESS_COLLECTIONS.length} collection(s)? Type "reset" to confirm: `,
    )
    rl.close()

    if (answer.trim().toLowerCase() !== 'reset') {
      out()
      out('  Cancelled. Nothing was deleted.')
      out()
      return 1
    }
    out()
  }

  // --- Delete ---------------------------------------------------------------
  out('  Clearing…')

  const db = mongoose.connection.db
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name))
  const deleted = {}

  for (const entry of BUSINESS_COLLECTIONS) {
    if (!existing.has(entry.name)) {
      deleted[entry.name] = null
      continue
    }

    const result = await db.collection(entry.name).deleteMany({})
    deleted[entry.name] = result.deletedCount
    out(`    ${entry.label.padEnd(30)} ${String(result.deletedCount).padStart(7)} deleted`)
  }

  const storage = await clearAttachmentStorage({ dryRun: false })
  out(`    ${'Attachment files'.padEnd(30)} ${storage.reason}`)

  if (clearSeededMailboxes && seededMailboxes.length > 0) {
    const removed = await MailboxModel.deleteMany({ providerAccountId: /^(seed-|mock-)/ })
    out(`    ${'Seeded mailboxes'.padEnd(30)} ${String(removed.deletedCount).padStart(7)} deleted`)
  }

  // --- Verify ---------------------------------------------------------------
  const after = await countAll([...businessNames, ...preservedNames])

  out()
  rule()
  out('  VERIFICATION')
  rule()

  const businessRemaining = businessNames.reduce((sum, name) => sum + (after[name] ?? 0), 0)

  out(`  business documents remaining : ${businessRemaining}`)
  out()
  out('  preserved:')

  let preservedIntact = true
  for (const entry of PRESERVED_COLLECTIONS) {
    const wasThere = before[entry.name]
    const stillThere = after[entry.name]
    const intact = wasThere === stillThere
    if (!intact) preservedIntact = false

    out(
      `    ${intact ? 'OK  ' : 'LOST'} ${entry.label.padEnd(30)} ` +
        `${wasThere === null ? '(absent)' : `${wasThere} → ${stillThere}`}`,
    )
  }

  // The two questions that decide whether the reset was safe.
  const { User } = await import('../src/models/user.model.js')
  const { OutlookAccount } = await import('../src/models/outlookAccount.model.js')
  const { ProviderToken } = await import('../src/models/providerToken.model.js')
  const { Mailbox } = await import('../src/models/mailbox.model.js')

  const [users, accounts, tokens, mailboxes, connected] = await Promise.all([
    User.countDocuments(),
    OutlookAccount.countDocuments(),
    ProviderToken.countDocuments(),
    Mailbox.countDocuments(),
    Mailbox.countDocuments({ status: 'connected' }),
  ])

  out()
  out('  authentication and Microsoft connection:')
  out(`    users                    : ${users}`)
  out(`    outlook accounts         : ${accounts}`)
  out(`    encrypted tokens         : ${tokens}`)
  out(`    mailboxes                : ${mailboxes} (${connected} connected)`)

  const canSignIn = users > 0
  const stillConnected = accounts > 0 && tokens > 0

  out()
  rule()
  out('  RESULT')
  rule()
  out(`  collections cleared  : ${BUSINESS_COLLECTIONS.filter((e) => deleted[e.name] !== null).length}`)
  out(`  documents deleted    : ${Object.values(deleted).reduce((sum, n) => sum + (n ?? 0), 0)}`)
  out(`  collections preserved: ${PRESERVED_COLLECTIONS.filter((e) => before[e.name] !== null).length}`)
  out()
  out(`  business data empty  : ${businessRemaining === 0 ? 'YES' : `NO — ${businessRemaining} left`}`)
  out(`  preserved intact     : ${preservedIntact ? 'YES' : 'NO'}`)
  out(`  sign-in possible     : ${canSignIn ? 'YES' : 'NO — no users remain'}`)
  out(`  Microsoft connected  : ${stillConnected ? 'YES' : 'NO — reconnect will be required'}`)
  out()

  if (businessRemaining === 0 && preservedIntact && canSignIn) {
    out('  Ready for a fresh Excel import: Leads → Import workbook.')
  } else {
    out('  Something is off. Check the lines above before importing.')
  }
  out()

  return businessRemaining === 0 && preservedIntact && canSignIn ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  out(`\n  RESET FAILED: ${error?.message}`)
  out(error?.stack?.split('\n').slice(1, 4).join('\n') ?? '')
} finally {
  out('═'.repeat(74))
  await mongoose.disconnect().catch(() => {})
}

process.exit(exitCode)
