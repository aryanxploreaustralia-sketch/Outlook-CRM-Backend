/**
 * Contact synchronisation.
 *
 * Provider-independent: it calls `ContactProvider` methods and never imports a
 * Graph symbol, so a Gmail or CardDAV adapter drops in without this file
 * changing.
 *
 * ## The rule that shapes everything here
 *
 * **A sync must never destroy information the provider does not have.**
 *
 * Tags, category, favourite, notes and group membership are CRM concepts with no
 * upstream equivalent. A naive "overwrite local with remote" would erase them on
 * every run. So provider-owned fields are reconciled and CRM-owned fields are
 * left alone — always, in both directions.
 *
 * ## Deletion is never destructive
 *
 * A contact removed in Outlook is marked `deleted_remote` and kept. The user may
 * have annotated it here, and a mis-click upstream must not silently destroy
 * work that exists nowhere else. `restoreRemotelyDeleted` pushes it back.
 */

import crypto from 'node:crypto'

import { Contact } from '../../../models/contact.model.js'
import { SyncHistory } from '../../../models/syncHistory.model.js'
import { SyncState } from '../../../models/syncState.model.js'
import {
  CONTACT_SOURCE,
  CONTACT_SYNC_STATUS,
  MERGE_STRATEGY,
} from '../constants/contactConstants.js'
import { SYNC_MODE, SYNC_STATUS, SYNC_TRIGGER } from '../../provider/constants/syncStatus.js'
import { PROVIDER_ERROR_CODES, ProviderError } from '../../provider/constants/providerErrors.js'
import { withRetry, withTimeout } from '../../provider/utils/retry.js'
import { logSyncRun } from '../../provider/utils/providerLogger.js'
import { findAutoMergeTarget } from './duplicate.service.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('contact-sync')

/** Ceiling on one sync run. */
const SYNC_TIMEOUT_MS = 3 * 60 * 1000

/** Pages per run, so one enormous address book cannot monopolise it. */
const MAX_PAGES_PER_RUN = 40

/**
 * Pseudo-folder used for the contacts sync state.
 *
 * `SyncState` is keyed on `(mailbox, folder)` and was built for mail folders.
 * Reusing it with a reserved name keeps delta-token handling, locking and the
 * stale-lock TTL in one implementation rather than duplicating that machinery
 * for contacts. The name cannot collide with a canonical mail folder.
 */
export const CONTACTS_PSEUDO_FOLDER = 'custom'
const CONTACTS_STATE_KEY = 'contacts'

/** Provider fields a sync may write onto a local contact. */
const PROVIDER_OWNED_FIELDS = Object.freeze([
  'firstName',
  'lastName',
  'displayName',
  'company',
  'jobTitle',
  'primaryEmail',
  'secondaryEmail',
  'mobile',
  'businessPhone',
  'phone',
  'website',
  'address',
  'city',
  'state',
  'country',
  'postalCode',
  'birthday',
])

/**
 * `ProviderContact` → the CRM's field names.
 *
 * Notes are mapped but tags, category and favourite are not: those are CRM-owned
 * and a provider has no business setting them.
 */
export function toContactFields(providerContact) {
  const [primaryEmail = null, secondaryEmail = null] = providerContact.emails ?? []
  const address = providerContact.address ?? {}

  return {
    firstName: providerContact.firstName ?? null,
    lastName: providerContact.lastName ?? null,
    displayName: providerContact.displayName ?? null,
    company: providerContact.company ?? null,
    jobTitle: providerContact.jobTitle ?? null,
    primaryEmail,
    secondaryEmail,
    mobile: providerContact.mobile ?? null,
    businessPhone: providerContact.businessPhone ?? null,
    phone: providerContact.homePhone ?? null,
    website: providerContact.website ?? null,
    address: address.street ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    country: address.country ?? null,
    postalCode: address.postalCode ?? null,
    notes: providerContact.notes ?? null,
    birthday: providerContact.birthday ?? null,
  }
}

/**
 * Decides how a provider contact and a stored one should be reconciled.
 *
 * @returns {{ resolution: string, apply: boolean, conflictFields: string[] }}
 */
export function resolveContactConflict(stored, incoming) {
  // Provider version unchanged — nothing happened remotely.
  if (stored.syncMeta?.changeKey && incoming.changeKey && stored.syncMeta.changeKey === incoming.changeKey) {
    return { resolution: MERGE_STRATEGY.LOCAL_WINS, apply: false, conflictFields: [] }
  }

  const localTime = stored.updatedAt ? stored.updatedAt.getTime() : 0
  const lastSync = stored.syncMeta?.localModifiedAt?.getTime() ?? 0

  /**
   * A local edit made since the last sync competes with the remote change.
   *
   * Which fields actually differ decides whether this is a genuine conflict or
   * merely two sides having touched unrelated things.
   */
  const editedLocallySinceSync = localTime > lastSync

  if (editedLocallySinceSync) {
    const incomingFields = toContactFields(incoming)
    const conflictFields = PROVIDER_OWNED_FIELDS.filter((field) => {
      const local = stored[field] ?? null
      const remote = incomingFields[field] ?? null
      return local !== remote && local !== null && remote !== null
    })

    if (conflictFields.length > 0) {
      // Both changed the same fields differently. Remote wins for provider-owned
      // data — the mailbox is authoritative — but the conflict is recorded so
      // the user can see it happened rather than wondering why an edit vanished.
      return { resolution: MERGE_STRATEGY.MANUAL, apply: true, conflictFields }
    }
  }

  return { resolution: MERGE_STRATEGY.REMOTE_WINS, apply: true, conflictFields: [] }
}

/**
 * Writes one provider contact, creating or reconciling as appropriate.
 *
 * @returns {Promise<{ outcome: 'created'|'updated'|'skipped'|'merged', conflict: boolean }>}
 */
export async function persistContact({ providerContact, owner, mailbox, provider }) {
  if (!providerContact.providerContactId) {
    // Nothing to deduplicate on, so it could never be reconciled later.
    return { outcome: 'skipped', conflict: false }
  }

  const existing = await Contact.findOne({
    owner,
    provider,
    providerContactId: providerContact.providerContactId,
  })

  const fields = toContactFields(providerContact)

  if (existing) {
    const { apply, conflictFields } = resolveContactConflict(existing, providerContact)

    existing.lastSyncedAt = new Date()

    if (!apply) {
      await existing.save()
      return { outcome: 'skipped', conflict: false }
    }

    // Provider-owned fields only. Tags, category, favourite and group
    // membership are untouched — see the note at the top of this file.
    for (const field of PROVIDER_OWNED_FIELDS) {
      existing[field] = fields[field]
    }

    // Notes are unioned rather than replaced: a user may have written CRM notes
    // on a contact whose Outlook notes are empty, and overwriting would lose them.
    if (fields.notes && fields.notes !== existing.notes) {
      existing.notes = existing.notes?.includes(fields.notes)
        ? existing.notes
        : [existing.notes, fields.notes].filter(Boolean).join('\n')
    }

    existing.syncMeta = {
      changeKey: providerContact.changeKey ?? null,
      remoteModifiedAt: providerContact.lastModifiedAt ?? null,
      localModifiedAt: new Date(),
    }

    existing.syncStatus =
      conflictFields.length > 0 ? CONTACT_SYNC_STATUS.CONFLICT : CONTACT_SYNC_STATUS.SYNCED

    // A contact that reappears upstream is no longer remotely deleted.
    existing.deletedRemotelyAt = null

    await existing.save()

    return { outcome: 'updated', conflict: conflictFields.length > 0 }
  }

  /**
   * No record with this provider id — but the same person may already exist as
   * a CRM contact created by hand or imported from a spreadsheet. Linking the
   * two is far better than producing a visible duplicate on first sync.
   */
  const mergeTarget = await findAutoMergeTarget({ candidate: { ...fields, provider }, owner })

  if (mergeTarget) {
    const target = mergeTarget.contact

    // Fill blanks only. An auto-merge must never overwrite a value a human
    // deliberately entered.
    for (const field of PROVIDER_OWNED_FIELDS) {
      if ((target[field] ?? null) === null && fields[field] !== null) {
        target[field] = fields[field]
      }
    }

    target.provider = provider
    target.providerContactId = providerContact.providerContactId
    target.mailbox = mailbox?._id ?? null
    target.syncStatus = CONTACT_SYNC_STATUS.SYNCED
    target.lastSyncedAt = new Date()
    target.syncMeta = {
      changeKey: providerContact.changeKey ?? null,
      remoteModifiedAt: providerContact.lastModifiedAt ?? null,
      localModifiedAt: new Date(),
    }

    await target.save()

    log.debug('Linked a provider contact to an existing CRM record', {
      contactId: target._id.toString(),
      strategy: mergeTarget.strategy,
      confidence: mergeTarget.confidence,
    })

    return { outcome: 'merged', conflict: false }
  }

  try {
    await Contact.create({
      ...fields,
      owner,
      mailbox: mailbox?._id ?? null,
      provider,
      providerContactId: providerContact.providerContactId,
      source: CONTACT_SOURCE.OUTLOOK,
      syncStatus: CONTACT_SYNC_STATUS.SYNCED,
      lastSyncedAt: new Date(),
      syncMeta: {
        changeKey: providerContact.changeKey ?? null,
        remoteModifiedAt: providerContact.lastModifiedAt ?? null,
        localModifiedAt: new Date(),
      },
    })

    return { outcome: 'created', conflict: false }
  } catch (error) {
    // The unique index rejected a concurrent insert of the same contact.
    // Expected under concurrency, and correct.
    if (error?.code === 11000) return { outcome: 'skipped', conflict: false }
    throw error
  }
}

/**
 * Marks contacts the provider reports as deleted.
 *
 * Marked, never removed — see the note at the top of this file.
 */
export async function applyRemoteDeletions({ owner, provider, deletedContactIds }) {
  if (!deletedContactIds?.length) return 0

  const { modifiedCount } = await Contact.updateMany(
    {
      owner,
      provider,
      providerContactId: { $in: deletedContactIds },
      deletedRemotelyAt: null,
    },
    {
      $set: {
        deletedRemotelyAt: new Date(),
        syncStatus: CONTACT_SYNC_STATUS.DELETED_REMOTE,
        lastSyncedAt: new Date(),
      },
    },
  )

  return modifiedCount ?? 0
}

/**
 * Pushes a remotely-deleted contact back to the provider.
 *
 * @returns {Promise<object>} The restored contact.
 */
export async function restoreRemotelyDeleted({ provider, contact, mailbox }) {
  const created = await provider.createContact(contact, { mailbox })

  contact.providerContactId = created.providerContactId
  contact.deletedRemotelyAt = null
  contact.syncStatus = CONTACT_SYNC_STATUS.SYNCED
  contact.lastSyncedAt = new Date()
  contact.syncMeta = {
    changeKey: created.changeKey ?? null,
    remoteModifiedAt: new Date(),
    localModifiedAt: new Date(),
  }

  await contact.save()

  log.info('Restored a remotely-deleted contact', {
    contactId: contact._id.toString(),
    providerContactId: created.providerContactId,
  })

  return contact
}

/**
 * Pushes locally-edited contacts upstream.
 *
 * Runs before the download so a local edit is not immediately overwritten by the
 * remote copy it was based on.
 *
 * @returns {Promise<{ pushed: number, failed: number }>}
 */
async function pushPendingChanges({ provider, owner, mailbox }) {
  if (!provider.supports('write')) return { pushed: 0, failed: 0 }

  const pending = await Contact.find({
    owner,
    syncStatus: CONTACT_SYNC_STATUS.PENDING,
    providerContactId: { $ne: null },
    isDeleted: false,
  }).limit(200)

  let pushed = 0
  let failed = 0

  for (const contact of pending) {
    try {
      const result = await provider.updateContact(contact.providerContactId, contact, { mailbox })

      contact.syncStatus = CONTACT_SYNC_STATUS.SYNCED
      contact.lastSyncedAt = new Date()
      contact.syncMeta = {
        changeKey: result.changeKey ?? contact.syncMeta?.changeKey ?? null,
        remoteModifiedAt: new Date(),
        localModifiedAt: new Date(),
      }
      await contact.save()

      pushed += 1
    } catch (error) {
      // One contact failing must not abandon the rest of the run.
      contact.syncStatus = CONTACT_SYNC_STATUS.FAILED
      await contact.save()

      failed += 1

      log.warn('Could not push a contact upstream', {
        contactId: contact._id.toString(),
        code: error?.code ?? null,
        message: error?.message,
      })
    }
  }

  return { pushed, failed }
}

/**
 * Runs a contact synchronisation.
 *
 * @param {object} params
 * @returns {Promise<object>} The completed `SyncHistory` record.
 */
export async function runContactSync({
  provider,
  mailbox,
  user,
  mode = SYNC_MODE.INCREMENTAL,
  trigger = SYNC_TRIGGER.MANUAL,
  isMock = false,
}) {
  const owner = user._id ?? user
  const correlationId = crypto.randomUUID()
  const startedAt = Date.now()

  const run = await SyncHistory.create({
    user: owner,
    mailbox: mailbox._id,
    provider: provider.type,
    trigger,
    mode,
    folders: [CONTACTS_STATE_KEY],
    correlationId,
    status: SYNC_STATUS.RUNNING,
    startedAt: new Date(),
  })

  const result = {
    folder: CONTACTS_PSEUDO_FOLDER,
    mode,
    status: SYNC_STATUS.SUCCESS,
    messagesCreated: 0,
    messagesUpdated: 0,
    messagesDeleted: 0,
    messagesSkipped: 0,
    conflictsResolved: 0,
    durationMs: 0,
    error: null,
  }

  const errors = []

  // Delta state is stored per mailbox under a reserved folder key.
  const state = await SyncState.findOneAndUpdate(
    { mailbox: mailbox._id, folder: CONTACTS_PSEUDO_FOLDER },
    {
      $setOnInsert: {
        user: owner,
        mailbox: mailbox._id,
        folder: CONTACTS_PSEUDO_FOLDER,
        providerFolderId: CONTACTS_STATE_KEY,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )

  const useIncremental =
    mode === SYNC_MODE.INCREMENTAL && !state.fullResyncRequired && Boolean(state.lastDeltaToken)

  result.mode = useIncremental ? SYNC_MODE.INCREMENTAL : SYNC_MODE.FULL

  let deltaToken = useIncremental ? state.lastDeltaToken : null
  let nextToken

  try {
    const pushResult = await pushPendingChanges({ provider, owner, mailbox })
    result.messagesUpdated += pushResult.pushed
    if (pushResult.failed > 0) {
      errors.push({
        code: 'CONTACT_PUSH_FAILED',
        message: `${pushResult.failed} contact(s) could not be pushed upstream.`,
        folder: CONTACTS_PSEUDO_FOLDER,
        retryable: true,
      })
    }

    for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
      const response = await withTimeout(
        withRetry(() => provider.listContacts({ mailbox, deltaToken }), {
          label: 'contact sync',
          maxAttempts: 3,
        }),
        SYNC_TIMEOUT_MS,
        'contact sync',
      )

      for (const providerContact of response.contacts ?? []) {
        const { outcome, conflict } = await persistContact({
          providerContact,
          owner,
          mailbox,
          provider: provider.type,
        })

        if (outcome === 'created') result.messagesCreated += 1
        else if (outcome === 'updated' || outcome === 'merged') result.messagesUpdated += 1
        else result.messagesSkipped += 1

        if (conflict) result.conflictsResolved += 1
      }

      result.messagesDeleted += await applyRemoteDeletions({
        owner,
        provider: provider.type,
        deletedContactIds: response.deletedContactIds,
      })

      nextToken = response.deltaToken ?? nextToken

      if (!response.hasMore) break
      deltaToken = response.deltaToken
    }

    state.lastDeltaToken = nextToken ?? null
    state.lastSyncAt = new Date()
    state.lastSuccessfulSyncAt = new Date()
    state.syncStatus = SYNC_STATUS.SUCCESS
    state.fullResyncRequired = false
    state.consecutiveFailures = 0
    state.messagesSynced += result.messagesCreated + result.messagesUpdated
    await state.save()
  } catch (error) {
    const isProviderError = error instanceof ProviderError

    /**
     * An expired delta token is a normal event, not a failure. The token is
     * discarded and the next run reads everything.
     */
    if (isProviderError && error.code === PROVIDER_ERROR_CODES.DELTA_TOKEN_EXPIRED) {
      state.lastDeltaToken = null
      state.fullResyncRequired = true
      state.syncStatus = SYNC_STATUS.SUCCESS
      await state.save()

      log.info('Contact delta token expired; a full resync is scheduled')
    } else {
      result.status = SYNC_STATUS.FAILED
      result.error = {
        code: error?.code ?? PROVIDER_ERROR_CODES.UNKNOWN,
        message: error?.message ?? String(error),
      }

      errors.push({ ...result.error, folder: CONTACTS_PSEUDO_FOLDER, retryable: Boolean(error?.isRetryable) })

      state.lastSyncAt = new Date()
      state.syncStatus = SYNC_STATUS.FAILED
      state.lastError = { ...result.error, occurredAt: new Date() }
      state.consecutiveFailures += 1
      await state.save()

      log.warn('Contact sync failed', { code: result.error.code, mailboxId: mailbox._id.toString() })
    }
  }

  result.durationMs = Date.now() - startedAt

  run.results = [result]
  run.runErrors = errors
  run.finishedAt = new Date()
  run.durationMs = result.durationMs
  run.summarise()
  await run.save()

  logSyncRun({
    provider: provider.type,
    scope: 'contacts',
    mailboxId: mailbox._id.toString(),
    status: run.status,
    trigger,
    mode: result.mode,
    contactsCreated: result.messagesCreated,
    contactsUpdated: result.messagesUpdated,
    contactsDeleted: result.messagesDeleted,
    conflicts: result.conflictsResolved,
    durationMs: result.durationMs,
    correlationId,
    simulated: isMock,
  })

  return run
}

export default {
  runContactSync,
  persistContact,
  applyRemoteDeletions,
  restoreRemotelyDeleted,
  resolveContactConflict,
  toContactFields,
  CONTACTS_PSEUDO_FOLDER,
}
