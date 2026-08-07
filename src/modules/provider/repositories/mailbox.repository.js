/**
 * Persistence for mailboxes and their folders.
 *
 * The repositories exist so the sync engine expresses intent — "record these
 * folders" — rather than assembling upsert filters inline. Every method takes
 * and enforces a `user`, which is what makes cross-user access impossible by
 * construction rather than by remembering to check.
 */

import { Mailbox } from '../../../models/mailbox.model.js'
import { MailboxFolder } from '../../../models/mailboxFolder.model.js'
import { CONNECTION_STATUS } from '../constants/providerTypes.js'
import { isDefaultForUser, scopedMailboxFilter } from '../../../constants/mailboxAccess.js'
import { FOLDERS, SYNCABLE_FOLDERS } from '../constants/folderTypes.js'

/**
 * Finds or creates the mailbox for a provider account.
 *
 * Upsert rather than create: reconnecting the same mailbox must update the
 * existing record, not produce a duplicate the user then sees twice.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function upsertMailbox({
  user,
  provider,
  providerAccountId,
  emailAddress = null,
  displayName = null,
  sourceAccount = null,
  capabilities = [],
}) {
  return Mailbox.findOneAndUpdate(
    { user, provider, providerAccountId },
    {
      $set: {
        emailAddress,
        displayName,
        sourceAccount,
        capabilities,
        status: CONNECTION_STATUS.CONNECTED,
        statusReason: null,
        connectedAt: new Date(),
        disconnectedAt: null,
        lastValidatedAt: new Date(),
      },
      $setOnInsert: { user, provider, providerAccountId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )
}

/**
 * The mailbox a user's operation should act on.
 *
 * ## Ordering, and why it changed in Phase 13.2
 *
 * This used to return simply "the newest connection". With one mailbox per user
 * that was indistinguishable from correct. With several it is not: connecting a
 * second mailbox would silently move every unattended send — the morning
 * introduction, a sequence step — onto the new address, without anybody asking
 * for it or being told.
 *
 * So the order is now explicit:
 *
 *  1. `mailboxId`, when the caller named one. Always scoped by `user`, so an id
 *     belonging to another workspace resolves to null rather than to a mailbox.
 *  2. The workspace's chosen default.
 *  3. A connected mailbox, newest first.
 *  4. Any mailbox at all, newest first — so a workspace whose only mailbox needs
 *     reconnection still resolves to *it*, and the caller can report that
 *     accurately instead of "no mailbox connected".
 *
 * Steps 3 and 4 are separate on purpose: collapsing them would let a broken
 * mailbox outrank a healthy one merely by being newer.
 *
 * @param {object} params
 * @param {boolean} [params.connectedOnly] Skip step 4.
 * @returns {Promise<?object>}
 */
export async function findMailbox({
  user,
  provider = null,
  mailboxId = null,
  connectedOnly = false,
}) {
  /**
   * Scoped by **access**, not ownership, since Phase 14.5.
   *
   * `scopedMailboxFilter` matches a mailbox the user connected *or* one assigned
   * to them. It is a strict superset of the old `{ user }` filter, so nothing
   * that resolved before stops resolving - and an id belonging to a mailbox they
   * may not use still finds nothing, which is the authorization check rather
   * than something every caller has to remember to perform.
   */
  const scoped = (extra = {}) =>
    scopedMailboxFilter(user, provider ? { ...extra, provider } : extra)

  if (mailboxId) return Mailbox.findOne(scoped({ _id: mailboxId }))

  const preferred =
    (await Mailbox.findOne(scoped({ defaultUsers: user }))) ??
    (await Mailbox.findOne(scoped({ user, isDefault: true }))) ??
    (await Mailbox.findOne(scoped({ status: CONNECTION_STATUS.CONNECTED })).sort({
      connectedAt: -1,
    }))

  if (preferred || connectedOnly) return preferred

  return Mailbox.findOne(scoped()).sort({ connectedAt: -1 })
}

/**
 * The workspace's default sending mailbox, or null.
 *
 * Falls back to the newest *connected* mailbox when no default is recorded,
 * which is what keeps a workspace that predates this field working: it has
 * mailboxes and no `isDefault`, and unattended mail must still go out.
 *
 * @returns {Promise<?object>}
 */
export async function findDefaultMailbox({ user, provider = null }) {
  const scoped = (extra = {}) =>
    scopedMailboxFilter(user, provider ? { ...extra, provider } : extra)

  /**
   * The user's own recorded default comes first (Phase 14.5), then the
   * connector's legacy `isDefault` flag.
   *
   * The order is what keeps a pre-assignment workspace behaving identically: it
   * has `isDefault` set and `defaultUsers` empty, so the first lookup misses and
   * the second finds exactly what it always found.
   */
  const flagged =
    (await Mailbox.findOne(scoped({ defaultUsers: user }))) ??
    (await Mailbox.findOne(scoped({ user, isDefault: true })))

  /**
   * A flagged default that cannot send is not the answer to "send from where?".
   *
   * The flag is the workspace's *stated preference* and only an explicit "Set
   * as default" may change it — reconnecting a mailbox must not silently move
   * it. But a preference pointing at a mailbox whose grant was revoked would
   * fail every unattended send, so resolution falls through to a mailbox that
   * actually works while leaving the stored flag exactly where it is.
   *
   * The two therefore disagree only while the preferred mailbox is broken,
   * which is precisely the window in which disagreeing is the useful behaviour.
   */
  if (flagged && flagged.status === CONNECTION_STATUS.CONNECTED) return flagged

  const usable = await Mailbox.findOne(scoped({ status: CONNECTION_STATUS.CONNECTED })).sort({
    connectedAt: -1,
  })

  return usable ?? flagged ?? null
}

/** @returns {Promise<object[]>} Default first, then newest. */
export async function listMailboxes({ user, connectedOnly = false }) {
  const filter = scopedMailboxFilter(
    user,
    connectedOnly ? { status: CONNECTION_STATUS.CONNECTED } : {},
  )

  /**
   * Sorted by the *user's* default first, then the connector's legacy flag.
   *
   * `defaultUsers` cannot be sorted on directly - it is an array - so the
   * ordering is finished in memory, over a list that is at most a handful of
   * mailboxes per person.
   */
  const mailboxes = await Mailbox.find(filter).sort({ isDefault: -1, connectedAt: -1 })

  return mailboxes.sort(
    (a, b) => (isDefaultForUser(a, user) ? 0 : 1) - (isDefaultForUser(b, user) ? 0 : 1),
  )
}

/**
 * Makes one mailbox the workspace default, atomically.
 *
 * ## Why the two writes are ordered this way
 *
 * The unique partial index means "clear the old, set the new" cannot be done in
 * one statement. The clear therefore runs first: if the set then fails, the
 * workspace is left with *no* default, which `findDefaultMailbox` handles by
 * falling back to a connected mailbox. Doing it the other way round would make
 * the failure mode a duplicate-key error against a workspace that still has its
 * old default — the set would fail every time and the operation could never
 * succeed.
 *
 * A concurrent second caller either observes the cleared state and proceeds, or
 * loses the race on the index and is reported as a conflict. Neither outcome
 * can produce two defaults.
 *
 * @param {object} params
 * @returns {Promise<?object>} The new default, or null when the id is not the
 *   caller's to set.
 */
export async function setDefaultMailbox({ user, mailboxId }) {
  // Ownership is part of the query, not a separate check that could be skipped.
  const target = await Mailbox.findOne({ _id: mailboxId, user })
  if (!target) return null

  if (target.isDefault === true) return target

  await Mailbox.updateMany({ user, isDefault: true }, { $set: { isDefault: false } })

  return Mailbox.findOneAndUpdate(
    { _id: mailboxId, user },
    { $set: { isDefault: true } },
    { new: true },
  )
}

/**
 * Guarantees the invariant "a workspace with a usable mailbox has a default".
 *
 * Called after connecting and after disconnecting, which are the only two
 * moments the invariant can break. Deterministic by construction: the
 * replacement is the oldest connected mailbox, so the same database state
 * always yields the same answer and a disconnect cannot pick a different
 * sender depending on when it ran.
 *
 * @returns {Promise<?object>} The default afterwards, or null when none can be.
 */
export async function ensureDefaultMailbox({ user }) {
  const current = await Mailbox.findOne({ user, isDefault: true })

  // A default that is no longer usable is not a default worth keeping: every
  // unattended send would resolve to it and fail.
  if (current && current.status === CONNECTION_STATUS.CONNECTED) return current

  const replacement = await Mailbox.findOne({
    user,
    status: CONNECTION_STATUS.CONNECTED,
  }).sort({ connectedAt: 1 })

  if (!replacement) {
    if (current) await Mailbox.updateOne({ _id: current._id }, { $set: { isDefault: false } })
    return null
  }

  if (current && String(current._id) === String(replacement._id)) return current

  return setDefaultMailbox({ user, mailboxId: replacement._id })
}

/**
 * Records a mailbox as unusable without deleting it.
 *
 * Kept so the UI can explain what happened and offer reconnection, rather than
 * the mailbox silently vanishing from the interface.
 */
export async function markMailboxStatus({ mailboxId, status, reason = null }) {
  return Mailbox.findByIdAndUpdate(
    mailboxId,
    {
      $set: {
        status,
        statusReason: reason,
        lastValidatedAt: new Date(),
        ...(status === CONNECTION_STATUS.DISCONNECTED ? { disconnectedAt: new Date() } : {}),
      },
    },
    { new: true },
  )
}

/** Adds to the mailbox's rolling sync counters. */
export async function recordSyncStats({ mailboxId, messagesSynced, succeeded }) {
  const update = {
    $inc: { 'stats.totalMessagesSynced': messagesSynced },
    $set: { 'stats.lastSyncAt': new Date() },
  }

  if (succeeded) update.$set['stats.lastSuccessfulSyncAt'] = new Date()

  return Mailbox.findByIdAndUpdate(mailboxId, update, { new: true })
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/**
 * Writes a folder listing, reconciling it against what is already stored.
 *
 * Folders absent from the incoming set are flagged `isDeleted` rather than
 * removed: messages already synced from a folder hold a reference to it, and
 * deleting the row would orphan them.
 *
 * Sync is enabled by default only for the canonical folders this application
 * understands. Enabling every custom folder in a large mailbox would commit the
 * user to a great deal of transfer they never asked for.
 *
 * @param {object} params
 * @returns {Promise<{ folders: object[], created: number, updated: number, removed: number }>}
 */
export async function syncFolderRecords({ user, mailboxId, folders }) {
  let created = 0
  let updated = 0

  const seenIds = []

  for (const folder of folders) {
    if (!folder.providerFolderId) continue

    seenIds.push(folder.providerFolderId)

    const existing = await MailboxFolder.findOne({
      mailbox: mailboxId,
      providerFolderId: folder.providerFolderId,
    })

    if (existing) {
      existing.displayName = folder.displayName
      existing.canonical = folder.canonical
      existing.wellKnownName = folder.wellKnownName
      existing.parentFolderId = folder.parentFolderId
      existing.totalItemCount = folder.totalItemCount
      existing.unreadItemCount = folder.unreadItemCount
      existing.isDeleted = false
      existing.lastSyncedAt = new Date()
      await existing.save()
      updated += 1
    } else {
      await MailboxFolder.create({
        mailbox: mailboxId,
        user,
        providerFolderId: folder.providerFolderId,
        displayName: folder.displayName,
        canonical: folder.canonical,
        wellKnownName: folder.wellKnownName,
        parentFolderId: folder.parentFolderId,
        totalItemCount: folder.totalItemCount,
        unreadItemCount: folder.unreadItemCount,
        isSyncEnabled: SYNCABLE_FOLDERS.includes(folder.canonical),
        lastSyncedAt: new Date(),
      })
      created += 1
    }
  }

  const { modifiedCount } = await MailboxFolder.updateMany(
    { mailbox: mailboxId, providerFolderId: { $nin: seenIds }, isDeleted: false },
    { $set: { isDeleted: true } },
  )

  await Mailbox.findByIdAndUpdate(mailboxId, {
    $set: { 'stats.folderCount': seenIds.length },
  })

  return { created, updated, removed: modifiedCount ?? 0 }
}

/** @returns {Promise<object[]>} */
export async function listFolders({ user, mailboxId, includeDeleted = false }) {
  const filter = { user, mailbox: mailboxId }
  if (!includeDeleted) filter.isDeleted = false

  return MailboxFolder.find(filter).sort({ canonical: 1, displayName: 1 })
}

/**
 * Resolves a canonical folder to its provider id.
 *
 * Returns null when the folder has never been enumerated, which is normal before
 * a first folder sync — the adapter then falls back to a well-known alias.
 *
 * @returns {Promise<?string>}
 */
export async function resolveProviderFolderId({ mailboxId, canonical }) {
  if (canonical === FOLDERS.CUSTOM) return null

  const folder = await MailboxFolder.findOne({
    mailbox: mailboxId,
    canonical,
    isDeleted: false,
  })

  return folder?.providerFolderId ?? null
}

export default {
  upsertMailbox,
  findMailbox,
  findDefaultMailbox,
  listMailboxes,
  setDefaultMailbox,
  ensureDefaultMailbox,
  markMailboxStatus,
  recordSyncStats,
  syncFolderRecords,
  listFolders,
  resolveProviderFolderId,
}
