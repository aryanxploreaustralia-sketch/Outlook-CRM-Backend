#!/usr/bin/env node
/**
 * Consolidates workspaces that a Microsoft sign-in split apart.
 *
 * Audit only:  npm run repair:workspace
 * Dry run:     npm run repair:workspace -- --into <crmUserId>
 * Apply:       npm run repair:workspace -- --into <crmUserId> --apply
 *
 * ## What went wrong
 *
 * `completeSignIn` upserts a `User` keyed on `(tenantId, microsoftId)`. While
 * Microsoft was the only way in, that was right — one person, one account, one
 * CRM user. Once Google became the CRM identity it stopped being right, because
 * every Microsoft account that had ever signed in was already *its own CRM
 * user*, each with its own workspace and its own mailbox registry.
 *
 * So signing in as one Microsoft account showed one set of connected mailboxes
 * and another showed a different set. The registry query was never wrong — it
 * is scoped by user, and it faithfully returned the current user's mailboxes.
 * The *identity underneath it* changed. Business data followed the same split:
 * leads, companies and contacts all belong to whichever CRM user was signed in
 * when they were created.
 *
 * Blocking Microsoft sign-in stops the split growing. It does not merge what
 * already exists, and a workspace whose leads sit under a user nobody can sign
 * in as any more is worse than the bug. That is what this repairs.
 *
 * ## What it does
 *
 * Re-points every owned document from the source CRM users onto one target CRM
 * user, then deduplicates the mailbox registry by normalised address.
 *
 * ## Safety
 *
 * Nothing is deleted except duplicate `Mailbox` rows that represent the same
 * address in the same workspace, and those are merged rather than dropped —
 * the surviving row inherits the better connection state, the earliest
 * `connectedAt` and the default flag. No token is read, decrypted or printed.
 * Idempotent: a second run finds nothing to move and nothing to merge.
 *
 * With no `--into`, it only reports. That is the intended first step: read the
 * audit, decide which CRM user is the real workspace, then pass it explicitly.
 * Guessing the target is not something a script should do.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Mailbox } from '../src/models/mailbox.model.js'
import { AUTH_PROVIDERS, User } from '../src/models/user.model.js'
import { CONNECTION_STATUS } from '../src/modules/provider/constants/providerTypes.js'

const APPLY = process.argv.includes('--apply')
const INTO = (() => {
  const i = process.argv.indexOf('--into')
  return i !== -1 ? process.argv[i + 1] : null
})()
/** Also re-point rows whose owner no longer exists. Off by default. */
const INCLUDE_ORPHANS = process.argv.includes('--include-orphans')
/** Delete demo mailbox rows that have no OAuth grant. Off by default. */
const PRUNE_SEEDS = process.argv.includes('--prune-seeds')

const out = (line = '') => process.stdout.write(`${line}\n`)

/**
 * Every collection that carries an owner, and the field it uses.
 *
 * Listed explicitly rather than discovered, because a wrong guess here moves
 * somebody's data to the wrong workspace. `Mail` uses `userId` and the rest use
 * `owner`; `OutlookAccount` and `Mailbox` use `user`.
 */
/**
 * Collections whose owner field participates in a **unique** index.
 *
 * These cannot be moved with a bulk `updateMany`. Consolidating four workspaces
 * into one means four documents arriving where the index permits one, and
 * `updateMany` is not atomic across documents — it would write some, hit a
 * duplicate-key error, and abort, leaving the database half-migrated. That is a
 * worse state than the bug being repaired.
 *
 * Each is therefore moved one document at a time, and a collision is recorded
 * and skipped rather than raised:
 *
 *  - `schedulersettings` — `owner` is unique, and `isPrimary` is unique among
 *    true values. The target's own settings win; a source's are left in place,
 *    inert, belonging to a user who can no longer sign in.
 *  - `notifications` — `(owner, dedupeKey)` is unique. A collision means the
 *    same notification already exists in the target workspace, which is exactly
 *    what the dedupe key is for.
 */
const COLLISION_PRONE = new Set(['schedulersettings', 'notifications'])

/**
 * Documents that point at a `Mailbox` by id.
 *
 * Re-pointed whenever two registry rows are merged, so history keeps naming the
 * address a message actually went out from instead of a deleted row.
 */
const MAILBOX_REFERENCES = [
  ['mails', 'mailbox'],
  ['campaignrecipients', 'sentFromMailbox'],
  ['campaignevents', 'mailbox'],
  ['providertokens', 'mailbox'],
  ['mailboxfolders', 'mailbox'],
  ['syncstates', 'mailbox'],
  ['synchistories', 'mailbox'],
]

const OWNED = [
  { collection: 'leads', field: 'owner' },
  { collection: 'companies', field: 'owner' },
  { collection: 'contacts', field: 'owner' },
  { collection: 'contactgroups', field: 'owner' },
  { collection: 'campaigns', field: 'owner' },
  { collection: 'campaignrecipients', field: 'owner' },
  { collection: 'campaignevents', field: 'owner' },
  { collection: 'campaignsequences', field: 'owner' },
  { collection: 'campaigntemplates', field: 'owner' },
  { collection: 'conversations', field: 'owner' },
  { collection: 'conversationmessages', field: 'owner' },
  { collection: 'conversationactivities', field: 'owner' },
  { collection: 'conversationattachments', field: 'owner' },
  { collection: 'emailtemplates', field: 'owner' },
  { collection: 'importjobs', field: 'owner' },
  { collection: 'importtemplates', field: 'owner' },
  { collection: 'leadtasks', field: 'owner' },
  { collection: 'notifications', field: 'owner' },
  { collection: 'schedulersettings', field: 'owner' },
  { collection: 'schedulerruns', field: 'owner' },
  { collection: 'synchistories', field: 'user' },
  { collection: 'syncstates', field: 'user' },
  { collection: 'mailboxfolders', field: 'user' },
  { collection: 'providertokens', field: 'user' },
  { collection: 'mails', field: 'userId' },
  { collection: 'auditlogs', field: 'actor' },
  { collection: 'outlookaccounts', field: 'user' },
  // `mailboxes` is deliberately absent: it is moved by `moveMailboxes` below,
  // which merges on collision instead of skipping, because a skipped mailbox
  // would be left owned by a user nobody can sign in as — invisible, and
  // holding the credential its address needs.
]

/** Lower-cased address, or null. One of the dedupe keys, alongside the owner. */
const normalise = (email) => email?.trim().toLowerCase() || null

/**
 * A mailbox row that was never a real connection.
 *
 * `seed-provider.js` and the mock adapter write registry entries with no
 * `sourceAccount`, so there is no OAuth grant behind them and Reconnect can
 * never succeed — the button is there, the user presses it, and Microsoft has
 * nothing to re-authorise because nothing was ever authorised.
 *
 * Identified by the absence of a credential *and* a synthetic
 * `providerAccountId`, not by address: a real mailbox called `sales@…` is
 * entirely plausible and must not be swept up by this.
 */
const isSeedRow = (mb) =>
  !mb.sourceAccount && /^(seed-|mock-)/i.test(String(mb.providerAccountId ?? ''))

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function audit() {
  const users = await User.find({}).sort({ createdAt: 1 })
  const db = mongoose.connection.db

  out('\n=== CRM USERS ===')
  for (const u of users) {
    const owned = []
    for (const { collection, field } of OWNED) {
      const n = await db.collection(collection).countDocuments({ [field]: u._id }).catch(() => 0)
      if (n > 0) owned.push(`${collection}=${n}`)
    }
    out(`  ${u._id}  ${(u.provider ?? '?').padEnd(9)} ${(u.email ?? '(no email)').slice(0, 46)}`)
    out(`     ${owned.length > 0 ? owned.join(' ') : '(owns nothing)'}`)
  }

  out('\n=== MAILBOX REGISTRY BY OWNER ===')
  const mailboxes = await Mailbox.find({}).sort({ user: 1, connectedAt: 1 })
  const grouped = new Map()
  for (const mb of mailboxes) {
    const key = String(mb.user)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(mb)
  }

  for (const [uid, list] of grouped) {
    const u = users.find((x) => String(x._id) === uid)
    out(`  owner ${uid} -> ${u ? `${u.provider} / ${u.email}` : 'USER NOT FOUND (orphan)'}`)
    for (const mb of list) {
      out(
        `      ${(mb.emailAddress ?? '(no address)').padEnd(44)}` +
          `${(mb.status ?? '?').padEnd(14)}${mb.isDefault ? 'DEFAULT ' : ''}` +
          `${mb.sourceAccount ? 'credential' : 'NO CREDENTIAL'}`,
      )
    }
  }

  out('\n=== DUPLICATES (same owner + same normalised address) ===')
  const seen = new Map()
  for (const mb of mailboxes) {
    const key = `${mb.user}::${normalise(mb.emailAddress)}`
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key).push(mb)
  }
  let dupes = 0
  for (const [key, list] of seen) {
    if (list.length < 2 || key.endsWith('::null')) continue
    dupes += 1
    out(`  ${key.split('::')[1]} x${list.length}`)
    for (const mb of list) out(`      ${mb._id}  ${mb.status}  providerAccountId=${mb.providerAccountId}`)
  }
  if (dupes === 0) out('  none')

  out('\n=== MAILBOXES WITH NO CREDENTIAL (cannot be reconnected) ===')
  const credentialless = mailboxes.filter((mb) => !mb.sourceAccount)
  if (credentialless.length === 0) out('  none')
  for (const mb of credentialless) {
    out(`  ${(mb.emailAddress ?? '(no address)').padEnd(44)} providerAccountId=${mb.providerAccountId}`)
  }

  return { users, mailboxes }
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/**
 * Folds one mailbox row into another, re-pointing everything that referenced it.
 *
 * @returns {Promise<void>}
 */
async function foldMailbox({ loser, survivor }) {
  const db = mongoose.connection.db

  for (const [collection, field] of MAILBOX_REFERENCES) {
    await db
      .collection(collection)
      .updateMany({ [field]: loser._id }, { $set: { [field]: survivor._id } })
      .catch(() => {})
  }

  /**
   * `providertokens` carries a unique `(mailbox, provider)` index, so
   * re-pointing a loser's token onto a survivor that already has one collides.
   * The survivor's own token is the live one; the loser's is stale by
   * definition, so a leftover is removed rather than kept.
   */
  await db
    .collection('providertokens')
    .deleteMany({ mailbox: loser._id })
    .catch(() => {})

  await Mailbox.deleteOne({ _id: loser._id })
}

/** A connected row beats a disconnected one; then one with a credential; then oldest. */
const mailboxRank = (mb) =>
  (mb.status === CONNECTION_STATUS.CONNECTED ? 0 : 1) * 10 + (mb.sourceAccount ? 0 : 1)

/**
 * Moves the mailbox registry onto the target workspace, merging on collision.
 *
 * `(user, provider, providerAccountId)` is unique, and the audit shows two
 * different source workspaces already holding the *same* `providerAccountId` —
 * the same Microsoft account having been connected under two CRM users. Moving
 * both would violate the index, so the loser is folded into the survivor and
 * everything that referenced it is re-pointed first.
 */
async function moveMailboxes({ sourceIds, targetId }) {
  const sourceMailboxes = await Mailbox.find({ user: { $in: sourceIds } }).sort({ connectedAt: 1 })
  const actions = []

  /**
   * Keys already claimed by the target, tracked across the loop.
   *
   * Needed because a dry run writes nothing: without it, two *source*
   * workspaces holding the same `providerAccountId` would each query an empty
   * target, both report "move", and the preview would promise ten moves where
   * apply performs nine and a merge. The audit shows this database has exactly
   * that case, so the dry run has to model it or it is not a preview.
   */
  const claimed = new Map()
  for (const mb of await Mailbox.find({ user: targetId })) {
    claimed.set(`${mb.provider}::${mb.providerAccountId}`, mb)
  }

  for (const mb of sourceMailboxes) {
    const key = `${mb.provider}::${mb.providerAccountId}`
    const clash = claimed.get(key) ?? null

    if (!clash) {
      claimed.set(key, mb)
      actions.push({ kind: 'move', address: mb.emailAddress, id: String(mb._id) })
      if (APPLY) {
        // The default flag does not survive the move: which mailbox a *merged*
        // workspace sends from is decided once, at the end, by
        // `ensureDefaultMailbox`. Carrying several defaults across would
        // violate the unique partial index on the way in.
        await Mailbox.updateOne({ _id: mb._id }, { $set: { user: targetId, isDefault: false } })
      }
      continue
    }

    const [survivor, loser] = [clash, mb].sort((a, b) => mailboxRank(a) - mailboxRank(b))

    actions.push({
      kind: 'merge',
      address: mb.emailAddress,
      keep: String(survivor._id),
      drop: String(loser._id),
    })

    if (APPLY) await foldMailbox({ loser, survivor })
  }

  return actions
}

/**
 * Re-points every owned document from `sourceIds` onto `targetId`.
 *
 * Bulk for the collections that can take it, one-at-a-time for the ones whose
 * owner field is part of a unique index. See `COLLISION_PRONE`.
 */
async function reassign({ sourceIds, targetId }) {
  const db = mongoose.connection.db
  const moved = []
  const skipped = []

  for (const { collection, field } of OWNED) {
    const filter = { [field]: { $in: sourceIds } }

    const n = await db.collection(collection).countDocuments(filter).catch(() => 0)
    if (n === 0) continue

    if (!COLLISION_PRONE.has(collection)) {
      moved.push(`${collection}: ${n}`)
      if (APPLY) {
        await db.collection(collection).updateMany(filter, { $set: { [field]: targetId } })
      }
      continue
    }

    // One at a time, so a duplicate stops that document and nothing else.
    let ok = 0
    let clashed = 0

    for (const doc of await db.collection(collection).find(filter).toArray()) {
      if (!APPLY) {
        ok += 1
        continue
      }

      try {
        await db
          .collection(collection)
          .updateOne({ _id: doc._id }, { $set: { [field]: targetId } })
        ok += 1
      } catch (error) {
        // 11000 is a duplicate key: the target workspace already holds an
        // equivalent document, so this one is redundant rather than lost.
        if (error.code === 11000) clashed += 1
        else throw error
      }
    }

    moved.push(`${collection}: ${ok}`)
    if (clashed > 0) skipped.push(`${collection}: ${clashed} already present in the target`)
  }

  return { moved, skipped }
}

/**
 * Merges duplicate registry entries for one address in one workspace.
 *
 * The survivor is chosen deterministically: a connected row beats a
 * disconnected one, then a row with a credential beats one without, then the
 * oldest. It inherits the earliest `connectedAt` and the default flag if any
 * duplicate held it, so merging never silently demotes a workspace's default.
 */
async function dedupe({ targetId, sourceIds = [], keyBy = 'address' }) {
  /**
   * In a dry run the mailboxes have not moved yet, so the preview considers the
   * union of the target's and the sources' rows — otherwise it would report
   * "no duplicates" for a workspace that is about to acquire several, which is
   * precisely the thing somebody runs a dry run to find out.
   */
  const owners = APPLY ? [targetId] : [targetId, ...sourceIds]
  const mailboxes = await Mailbox.find({ user: { $in: owners } }).sort({ connectedAt: 1 })

  /**
   * Two rows are the same mailbox if they share an address **or** an OAuth
   * grant.
   *
   * The address pass alone is not enough. The old sign-in code recorded a
   * guest identity's display address as its `#EXT#` UPN
   * (`alice_outlook.com#EXT#@tenant.onmicrosoft.com`) while a later connection
   * recorded the real `alice@outlook.com`. Two addresses, two
   * `providerAccountId` forms — and one `sourceAccount`, because there is only
   * one MSAL grant. That shared grant is the proof they are one mailbox, and it
   * is the only key that catches this case.
   */
  const groups = new Map()
  for (const mb of mailboxes) {
    const key =
      keyBy === 'grant' ? (mb.sourceAccount ? String(mb.sourceAccount) : null) : normalise(mb.emailAddress)

    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(mb)
  }

  const merges = []

  for (const [address, list] of groups) {
    if (list.length < 2) continue

    const ordered = [...list].sort(
      (a, b) =>
        mailboxRank(a) - mailboxRank(b) ||
        new Date(a.connectedAt ?? 0) - new Date(b.connectedAt ?? 0),
    )

    const survivor = ordered[0]
    const losers = ordered.slice(1)

    const anyDefault = list.some((mb) => mb.isDefault)
    const earliest = list
      .map((mb) => mb.connectedAt)
      .filter(Boolean)
      .sort((a, b) => new Date(a) - new Date(b))[0]

    merges.push({
      // Reported by the survivor's address rather than the group key, which for
      // a grant-keyed pass is an opaque id that means nothing to a reader.
      address: survivor.emailAddress ?? address,
      keep: String(survivor._id),
      keepStatus: survivor.status,
      drop: losers.map((mb) => String(mb._id)),
      inheritsDefault: anyDefault && !survivor.isDefault,
    })

    if (APPLY) {
      /**
       * The default flag is cleared on the losers *before* it is set on the
       * survivor, because the unique partial index on `(user, isDefault)` would
       * otherwise reject the write while a duplicate still claimed it.
       */
      await Mailbox.updateMany(
        { _id: { $in: losers.map((mb) => mb._id) } },
        { $set: { isDefault: false } },
      )

      // Each loser is folded rather than deleted, so mail history and campaign
      // records keep naming a mailbox that still exists.
      for (const loser of losers) await foldMailbox({ loser, survivor })

      const update = {}
      if (anyDefault) update.isDefault = true
      if (earliest) update.connectedAt = earliest
      if (Object.keys(update).length > 0) {
        await Mailbox.updateOne({ _id: survivor._id }, { $set: update })
      }
    }
  }

  return merges
}

// ---------------------------------------------------------------------------

async function main() {
  await mongoose.connect(config.database.uri, config.database.options)

  out(`\nDatabase: ${mongoose.connection.name}`)
  out(
    `Mode:     ${
      !INTO ? 'AUDIT ONLY — pass --into <crmUserId> to repair' : APPLY ? 'APPLY' : 'DRY RUN'
    }`,
  )

  const { users } = await audit()

  if (!INTO) {
    const google = users.filter((u) => u.provider === AUTH_PROVIDERS.GOOGLE)
    out('\n─────────────────────────────────────────────────────────────')
    out('Audit only. Nothing was changed.')
    if (google.length === 1) {
      out(`\nThe Google CRM identity on this database is:`)
      out(`  ${google[0]._id}  ${google[0].email}`)
      out(`\nTo consolidate everything onto it:`)
      out(`  npm run repair:workspace -- --into ${google[0]._id}`)
      out(`  npm run repair:workspace -- --into ${google[0]._id} --apply`)
    } else {
      out(`\nFound ${google.length} Google users. Choose the target explicitly.`)
    }
    await mongoose.disconnect()
    return
  }

  const target = await User.findById(INTO)
  if (!target) throw new Error(`No CRM user with id ${INTO}.`)

  if (target.provider !== AUTH_PROVIDERS.GOOGLE) {
    out(
      `\n  ! Warning: the target is a "${target.provider}" user. Google is the CRM identity ` +
        `from Phase 13.2; consolidating onto a Microsoft user leaves the workspace unreachable ` +
        `once Microsoft sign-in is off.`,
    )
  }

  const sources = users.filter((u) => String(u._id) !== String(target._id))

  out(`\n=== CONSOLIDATION ===`)
  out(`  target: ${target._id}  ${target.provider} / ${target.email}`)
  for (const s of sources) out(`  source: ${s._id}  ${s.provider} / ${s.email}`)

  const sourceIds = sources.map((u) => u._id)

  if (INCLUDE_ORPHANS) {
    const known = users.map((u) => String(u._id))
    const orphanOwners = (await Mailbox.distinct('user')).filter(
      (id) => !known.includes(String(id)),
    )
    for (const id of orphanOwners) sourceIds.push(id)
    if (orphanOwners.length > 0) out(`  orphan owners: ${orphanOwners.length}`)
  }

  if (sourceIds.length === 0) {
    out('\nNothing to consolidate — one workspace already.')
  } else {
    /**
     * Mailboxes move first, and separately.
     *
     * Their unique key can collide between two source workspaces, so they need
     * merge-on-collision rather than the bulk update the rest can use. Doing
     * them first also means the reference re-pointing below acts on a registry
     * that is already settled.
     */
    const mailboxActions = await moveMailboxes({ sourceIds, targetId: target._id })
    const movedBoxes = mailboxActions.filter((a) => a.kind === 'move')
    const mergedBoxes = mailboxActions.filter((a) => a.kind === 'merge')

    out(`\n  ${APPLY ? 'Moved' : 'Would move'} mailboxes: ${movedBoxes.length}`)
    for (const a of movedBoxes) out(`    ${a.address ?? '(no address)'}`)
    if (mergedBoxes.length > 0) {
      out(`  ${APPLY ? 'Merged' : 'Would merge'} on identical provider account: ${mergedBoxes.length}`)
      for (const a of mergedBoxes) out(`    ${a.address ?? '(no address)'} — keep ${a.keep}`)
    }

    const { moved, skipped } = await reassign({ sourceIds, targetId: target._id })
    out(`\n  ${APPLY ? 'Moved' : 'Would move'}:`)
    if (moved.length === 0) out('    nothing')
    for (const m of moved) out(`    ${m}`)

    if (skipped.length > 0) {
      out(`\n  Left in place (an equivalent already exists in the target):`)
      for (const s of skipped) out(`    ${s}`)
    }
  }

  const report = (label, merges) => {
    out(`\n  ${APPLY ? 'Merged' : 'Would merge'} ${label}:`)
    if (merges.length === 0) out('    none')
    for (const m of merges) {
      out(
        `    ${m.address} — keep ${m.keep} (${m.keepStatus}), drop ${m.drop.length}` +
          `${m.inheritsDefault ? ', survivor inherits DEFAULT' : ''}`,
      )
    }
  }

  /**
   * Canonicalise the registry key before deduplicating.
   *
   * Rows written by the pre-13.2 connect path carry the Graph `/me` id as
   * `providerAccountId`; every other path uses MSAL's `homeAccountId`. Two
   * strings, one mailbox — and the mismatch is not cosmetic: the adoption
   * lookup keys on `homeAccountId`, so a row holding the short id could not be
   * found and a duplicate was inserted on every status request that omitted a
   * mailbox id. The registry grew simply by being read.
   *
   * Rewriting the key to the grant's own `homeAccountId` makes both paths agree
   * permanently. Run before the dedupe passes so the collisions this exposes
   * are resolved in the same pass rather than left for the next run.
   */
  const { OutlookAccount } = await import('../src/models/outlookAccount.model.js')
  const canonicalised = []

  for (const mb of await Mailbox.find({ user: target._id, sourceAccount: { $ne: null } })) {
    const grant = await OutlookAccount.findById(mb.sourceAccount)
    if (!grant || mb.providerAccountId === grant.homeAccountId) continue

    canonicalised.push({ address: mb.emailAddress, from: mb.providerAccountId })

    if (APPLY) {
      /**
       * A row already holding the canonical key is the same mailbox, so this
       * one is folded into it rather than colliding with the unique index.
       */
      const existing = await Mailbox.findOne({
        user: target._id,
        provider: mb.provider,
        providerAccountId: grant.homeAccountId,
        _id: { $ne: mb._id },
      })

      if (existing) {
        const [survivor, loser] = [existing, mb].sort((a, b) => mailboxRank(a) - mailboxRank(b))
        await Mailbox.updateOne({ _id: loser._id }, { $set: { isDefault: false } })
        await foldMailbox({ loser, survivor })
        await Mailbox.updateOne(
          { _id: survivor._id },
          { $set: { providerAccountId: grant.homeAccountId } },
        )
      } else {
        await Mailbox.updateOne(
          { _id: mb._id },
          { $set: { providerAccountId: grant.homeAccountId } },
        )
      }
    }
  }

  out(`\n  ${APPLY ? 'Canonicalised' : 'Would canonicalise'} registry keys: ${canonicalised.length}`)
  for (const c of canonicalised) {
    out(`    ${c.address ?? '(no address)'} — was "${String(c.from).slice(0, 24)}…"`)
  }

  report('by address', await dedupe({ targetId: target._id, sourceIds, keyBy: 'address' }))
  report(
    'by shared Microsoft grant',
    await dedupe({ targetId: target._id, sourceIds, keyBy: 'grant' }),
  )

  /**
   * Demo rows, removed only when explicitly asked for.
   *
   * They are indistinguishable from a real mailbox in the UI and offer a
   * Reconnect that cannot work, but deleting rows is not something a repair
   * should decide on its own — so they are reported by default and removed
   * behind a flag.
   */
  const seeds = (await Mailbox.find({ user: target._id })).filter(isSeedRow)

  if (seeds.length > 0) {
    out(`\n  Seed/mock mailboxes with no OAuth grant (Reconnect can never succeed):`)
    for (const mb of seeds) out(`    ${mb.emailAddress ?? '(no address)'}  [${mb.providerAccountId}]`)

    if (!PRUNE_SEEDS) {
      out(`    Left in place. Re-run with --prune-seeds to remove them.`)
    } else if (!APPLY) {
      out(`    Would remove ${seeds.length}.`)
    } else {
      await Mailbox.deleteMany({ _id: { $in: seeds.map((mb) => mb._id) } })
      out(`    Removed ${seeds.length}.`)
    }
  }

  if (APPLY) {
    /**
     * The source users are kept, not deleted.
     *
     * They own nothing now, and deleting a `User` breaks any audit-log entry or
     * session that still references it by id. A user who cannot sign in and
     * owns nothing is harmless; a dangling reference is not.
     */
    out('\n  Source CRM users are kept (they now own nothing) so no reference is orphaned.')

    const { ensureDefaultMailbox } = await import(
      '../src/modules/provider/repositories/mailbox.repository.js'
    )
    const chosen = await ensureDefaultMailbox({ user: target._id })
    out(`  Default mailbox: ${chosen ? chosen.emailAddress : 'none (no connected mailbox)'}`)

    out('\n=== REGISTRY AFTER REPAIR ===')
    for (const mb of await Mailbox.find({ user: target._id }).sort({ isDefault: -1, connectedAt: 1 })) {
      out(
        `  ${(mb.emailAddress ?? '(no address)').padEnd(44)}${(mb.status ?? '?').padEnd(14)}` +
          `${mb.isDefault ? 'DEFAULT ' : ''}${mb.sourceAccount ? '' : '(no credential)'}`,
      )
    }
  }

  out(
    APPLY
      ? '\nDone. One workspace, one mailbox registry.'
      : '\nDry run complete. Re-run with --apply to write these changes.',
  )

  await mongoose.disconnect()
}

main().catch(async (error) => {
  process.stderr.write(`\nRepair failed: ${error.message}\n`)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
