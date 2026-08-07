/**
 * Folder synchronisation.
 *
 * Provider-independent throughout: it calls `EmailProvider` methods and reads
 * canonical folder names. Nothing here knows what Graph is, which is the whole
 * point — a Gmail adapter drops in without this file changing.
 *
 * ## Duplicate detection
 *
 * Enforced in two places, deliberately. The engine looks up existing messages by
 * `(mailbox, providerMessageId)` before writing, *and* a unique partial index on
 * the same pair rejects a duplicate at the database. The index is what makes the
 * guarantee real: two concurrent runs could both pass the lookup, and only a
 * constraint can settle that. The lookup exists so the ordinary path does not
 * rely on catching errors.
 *
 * ## Conflict resolution
 *
 * A conflict is a message changed both locally and remotely since the last sync.
 * The rule is **remote wins for provider-owned fields** — read state, flags,
 * folder — because the mailbox is authoritative for those: the user may have
 * read the message on their phone, and this CRM must not override that.
 *
 * The exception is a local edit newer than the remote change, detected by
 * comparing `updatedAt` against the provider's change marker. That protects a
 * user who starred something here seconds ago from having it immediately undone
 * by a sync carrying older state.
 *
 * ## Partial failure is not total failure
 *
 * Each folder is synced independently and its outcome recorded separately. One
 * folder failing leaves the others' data intact and the run is reported
 * `partial` — telling the user everything failed would imply they should discard
 * results that are perfectly good.
 */

import crypto from 'node:crypto'

import { Mail } from '../../../models/mail.model.js'
import { MAIL_STATUS } from '../../../constants/mailStatus.js'
import { FOLDERS, SYNCABLE_FOLDERS } from '../constants/folderTypes.js'
import { PROVIDER_ERROR_CODES, ProviderError } from '../constants/providerErrors.js'
import {
  CONFLICT_RESOLUTION,
  SYNC_MODE,
  SYNC_STATUS,
  SYNC_TRIGGER,
} from '../constants/syncStatus.js'
import { CONNECTION_STATUS } from '../constants/providerTypes.js'
import * as mailboxRepo from '../repositories/mailbox.repository.js'
import * as syncRepo from '../repositories/syncState.repository.js'
import { tokenManager } from './tokenManager.js'
import { withRetry, withTimeout } from '../utils/retry.js'
import { logFolderSync, logSyncRun } from '../utils/providerLogger.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('sync-engine')

/** Ceiling on one folder's sync. Beyond this the lock is more harmful than the work. */
const FOLDER_TIMEOUT_MS = 2 * 60 * 1000

/** Pages fetched per folder per run, so one huge folder cannot monopolise a run. */
const MAX_PAGES_PER_RUN = 20

/** Maps a canonical folder to the adapter method that reads it. */
const FOLDER_METHODS = Object.freeze({
  [FOLDERS.INBOX]: 'syncInbox',
  [FOLDERS.SENT]: 'syncSent',
  [FOLDERS.DRAFTS]: 'syncDrafts',
  [FOLDERS.TRASH]: 'syncTrash',
  [FOLDERS.ARCHIVE]: 'syncArchive',
})

/** Empty per-folder result, so every counter is always present. */
const emptyResult = (folder, mode) => ({
  folder,
  mode,
  status: SYNC_STATUS.SUCCESS,
  messagesCreated: 0,
  messagesUpdated: 0,
  messagesDeleted: 0,
  messagesSkipped: 0,
  conflictsResolved: 0,
  durationMs: 0,
  error: null,
})

export class SyncEngine {
  constructor({ mailModel = Mail, tokens = tokenManager } = {}) {
    this.mailModel = mailModel
    this.tokens = tokens
  }

  /**
   * Decides how a provider message and a stored one should be reconciled.
   *
   * @param {object} stored Existing Mail document.
   * @param {object} incoming ProviderMessage.
   * @returns {{ resolution: string, apply: boolean }}
   */
  resolveConflict(stored, incoming) {
    // Provider version unchanged — nothing happened remotely, so there is
    // nothing to reconcile and the local copy stands.
    if (stored.changeKey && incoming.changeKey && stored.changeKey === incoming.changeKey) {
      return { resolution: CONFLICT_RESOLUTION.NONE, apply: false }
    }

    const remoteTimestamp = incoming.receivedAt ?? incoming.sentAt ?? null
    const localTimestamp = stored.updatedAt ?? null

    /**
     * A local edit strictly newer than the remote state wins.
     *
     * Without this, starring a message here and syncing a moment later would
     * silently undo the star — the user's most recent, most deliberate action
     * losing to state that predates it.
     */
    if (
      localTimestamp &&
      remoteTimestamp &&
      localTimestamp.getTime() > remoteTimestamp.getTime() &&
      stored.lastSyncedAt &&
      localTimestamp.getTime() > stored.lastSyncedAt.getTime()
    ) {
      return { resolution: CONFLICT_RESOLUTION.LOCAL_WINS, apply: false }
    }

    return { resolution: CONFLICT_RESOLUTION.REMOTE_WINS, apply: true }
  }

  /**
   * Writes one provider message, creating or reconciling as appropriate.
   *
   * @returns {Promise<{ outcome: 'created'|'updated'|'skipped', conflict: boolean }>}
   */
  async persistMessage({ message, mailbox, user, provider, folder }) {
    if (!message.providerMessageId) {
      // Nothing to deduplicate on, so it can never be reconciled later. Skipped
      // rather than inserted, which would create a duplicate on the next run.
      return { outcome: 'skipped', conflict: false }
    }

    const existing = await this.mailModel.findOne({
      mailbox: mailbox._id,
      providerMessageId: message.providerMessageId,
    })

    if (existing) {
      const { resolution, apply } = this.resolveConflict(existing, message)

      if (!apply) {
        existing.lastSyncedAt = new Date()
        await existing.save()
        return { outcome: 'skipped', conflict: resolution !== CONFLICT_RESOLUTION.NONE }
      }

      // Provider-owned fields only. Subject and body are not rewritten: they do
      // not change after delivery, and re-writing them would churn every
      // document on every run for no benefit.
      existing.isRead = message.isRead
      existing.isStarred = message.isStarred
      existing.folder = message.folder ?? folder
      existing.changeKey = message.changeKey
      // Backfilled rather than overwritten: records synced before Phase 9 have
      // no message id, and it never changes once set.
      if (!existing.internetMessageId && message.internetMessageId) {
        existing.internetMessageId = message.internetMessageId
      }
      existing.lastSyncedAt = new Date()
      await existing.save()

      return { outcome: 'updated', conflict: resolution === CONFLICT_RESOLUTION.REMOTE_WINS }
    }

    const isOutbound = folder === FOLDERS.SENT || folder === FOLDERS.DRAFTS

    try {
      await this.mailModel.create({
        userId: user._id ?? user,
        mailbox: mailbox._id,
        provider,
        providerMessageId: message.providerMessageId,
        changeKey: message.changeKey,
        conversationId: message.conversationId,
        threadId: message.threadId,
        internetMessageId: message.internetMessageId ?? null,

        direction: isOutbound ? 'outbound' : 'inbound',
        folder: message.folder ?? folder,

        from: message.from?.address ?? null,
        to: message.to?.map((r) => ({ address: r.address, name: r.name })) ?? [],
        cc: message.cc?.map((r) => ({ address: r.address, name: r.name })) ?? [],
        bcc: message.bcc?.map((r) => ({ address: r.address, name: r.name })) ?? [],

        subject: message.subject ?? '',
        html: message.bodyHtml ?? '',
        text: message.bodyText ?? '',

        attachments: (message.attachments ?? []).map((file) => ({
          name: file.name,
          contentType: file.contentType,
          size: file.size,
        })),

        // A synced message already reached its destination, so `sent` is the
        // honest status — `pending` would imply this application still owes work.
        status: folder === FOLDERS.DRAFTS ? MAIL_STATUS.DRAFT : MAIL_STATUS.SENT,
        isRead: message.isRead,
        isStarred: message.isStarred,
        sentAt: message.sentAt,
        receivedAt: message.receivedAt,
        lastSyncedAt: new Date(),
      })

      return { outcome: 'created', conflict: false }
    } catch (error) {
      // The unique index rejected a concurrent insert of the same message.
      // Expected under concurrency, and correct — treat it as already present.
      if (error?.code === 11000) {
        return { outcome: 'skipped', conflict: false }
      }
      throw error
    }
  }

  /** Applies provider tombstones as soft deletes. */
  async applyDeletions({ mailbox, deletedMessageIds }) {
    if (!deletedMessageIds?.length) return 0

    const { modifiedCount } = await this.mailModel.updateMany(
      { mailbox: mailbox._id, providerMessageId: { $in: deletedMessageIds }, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date(), lastSyncedAt: new Date() } },
    )

    return modifiedCount ?? 0
  }

  /**
   * Synchronises one folder.
   *
   * Acquires the folder lock, pages through changes, persists them, and always
   * releases the lock — including on failure, or the folder would stay wedged
   * until the TTL expired.
   *
   * @returns {Promise<object>} A per-folder result for the history record.
   */
  async syncFolder({ provider, mailbox, user, folder, mode = SYNC_MODE.INCREMENTAL }) {
    const method = FOLDER_METHODS[folder]

    if (!method) {
      return { ...emptyResult(folder, mode), status: SYNC_STATUS.SUCCESS, messagesSkipped: 0 }
    }

    const startedAt = Date.now()
    const state = await syncRepo.ensureState({ user: user._id ?? user, mailboxId: mailbox._id, folder })

    const locked = await syncRepo.acquireLock({ mailboxId: mailbox._id, folder })

    if (!locked) {
      log.debug('Folder is already syncing; skipping', { folder, mailboxId: mailbox._id.toString() })
      return {
        ...emptyResult(folder, mode),
        status: SYNC_STATUS.CANCELLED,
        error: { code: 'ALREADY_RUNNING', message: 'Another sync holds this folder.' },
        durationMs: Date.now() - startedAt,
      }
    }

    const result = emptyResult(folder, mode)

    // A stored token is replayed unless a full sync was asked for or is owed.
    const useIncremental =
      mode === SYNC_MODE.INCREMENTAL && !state.fullResyncRequired && Boolean(state.lastDeltaToken)

    result.mode = useIncremental ? SYNC_MODE.INCREMENTAL : SYNC_MODE.FULL

    let deltaToken = useIncremental ? state.lastDeltaToken : null
    let nextToken

    try {
      const providerFolderId = await mailboxRepo.resolveProviderFolderId({
        mailboxId: mailbox._id,
        canonical: folder,
      })

      for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
        const response = await withTimeout(
          withRetry(
            () => provider[method]({ mailbox, deltaToken, providerFolderId }),
            { label: `sync ${folder}`, maxAttempts: 3 },
          ),
          FOLDER_TIMEOUT_MS,
          `sync ${folder}`,
        )

        for (const message of response.messages ?? []) {
          const { outcome, conflict } = await this.persistMessage({
            message,
            mailbox,
            user,
            provider: provider.type,
            folder,
          })

          if (outcome === 'created') result.messagesCreated += 1
          else if (outcome === 'updated') result.messagesUpdated += 1
          else result.messagesSkipped += 1

          if (conflict) result.conflictsResolved += 1
        }

        result.messagesDeleted += await this.applyDeletions({
          mailbox,
          deletedMessageIds: response.deletedMessageIds,
        })

        nextToken = response.deltaToken ?? nextToken

        if (!response.hasMore) break

        // Paging forward: the response's token addresses the next page.
        deltaToken = response.deltaToken
      }

      await syncRepo.releaseLock({
        mailboxId: mailbox._id,
        folder,
        status: SYNC_STATUS.SUCCESS,
        deltaToken: nextToken ?? null,
      })

      await syncRepo.incrementMessagesSynced({
        mailboxId: mailbox._id,
        folder,
        count: result.messagesCreated + result.messagesUpdated,
      })

      result.durationMs = Date.now() - startedAt

      logFolderSync({
        provider: provider.type,
        folder,
        mode: result.mode,
        created: result.messagesCreated,
        updated: result.messagesUpdated,
        deleted: result.messagesDeleted,
        skipped: result.messagesSkipped,
        durationMs: result.durationMs,
      })

      return result
    } catch (error) {
      const isProviderError = error instanceof ProviderError

      /**
       * An expired delta token is a normal event, not a failure.
       *
       * Graph invalidates tokens after ~30 days. The token is discarded, a full
       * resync is flagged for the next run, and the folder is reported as
       * successful-but-empty rather than failed — nothing is wrong.
       */
      if (isProviderError && error.code === PROVIDER_ERROR_CODES.DELTA_TOKEN_EXPIRED) {
        // Order matters: `releaseLock` with SUCCESS clears `fullResyncRequired`,
        // so flagging the resync first would have it immediately undone — and
        // the next run would replay the same dead token forever.
        await syncRepo.releaseLock({
          mailboxId: mailbox._id,
          folder,
          status: SYNC_STATUS.SUCCESS,
          deltaToken: null,
        })
        await syncRepo.requireFullResync({ mailboxId: mailbox._id, folder })

        log.info('Delta token expired; a full resync is scheduled', { folder })

        return {
          ...result,
          status: SYNC_STATUS.SUCCESS,
          durationMs: Date.now() - startedAt,
          error: { code: error.code, message: 'Token expired; full resync scheduled.' },
        }
      }

      await syncRepo.releaseLock({
        mailboxId: mailbox._id,
        folder,
        status: SYNC_STATUS.FAILED,
        error: isProviderError ? error : { code: PROVIDER_ERROR_CODES.UNKNOWN, message: error.message },
      })

      result.status = SYNC_STATUS.FAILED
      result.durationMs = Date.now() - startedAt
      result.error = {
        code: error?.code ?? PROVIDER_ERROR_CODES.UNKNOWN,
        message: error?.message ?? String(error),
      }

      log.warn('Folder sync failed', {
        folder,
        code: result.error.code,
        mailboxId: mailbox._id.toString(),
      })

      return result
    }
  }

  /**
   * Runs a synchronisation across one or more folders.
   *
   * Folders are synced **sequentially**, not in parallel. Providers throttle per
   * mailbox, so five concurrent folder syncs against one mailbox produce 429s
   * and finish slower than doing them in order.
   *
   * @param {object} params
   * @returns {Promise<object>} The completed `SyncHistory` record.
   */
  async run({
    provider,
    mailbox,
    user,
    folders = SYNCABLE_FOLDERS,
    mode = SYNC_MODE.INCREMENTAL,
    trigger = SYNC_TRIGGER.MANUAL,
    isMock = false,
  }) {
    const correlationId = crypto.randomUUID()
    const startedAt = Date.now()

    const run = await syncRepo.startRun({
      user: user._id ?? user,
      mailboxId: mailbox._id,
      provider: provider.type,
      trigger,
      mode,
      folders,
      correlationId,
    })

    const results = []
    const errors = []

    try {
      // Credentials are renewed once, up front. Discovering an expiry midway
      // would fail every remaining folder for a reason already known.
      if (!isMock) {
        await this.tokens.ensureValid({ provider, mailbox })
      }

      // Folder listing first: it resolves the provider ids the message syncs
      // need, and a folder renamed at the provider would otherwise be addressed
      // by a stale id for the rest of the run.
      if (provider.supports('folders')) {
        try {
          const { folders: providerFolders } = await provider.syncFolders({ mailbox })
          await mailboxRepo.syncFolderRecords({
            user: user._id ?? user,
            mailboxId: mailbox._id,
            folders: providerFolders,
          })
        } catch (error) {
          // Non-fatal: message sync can fall back to well-known folder aliases.
          errors.push({
            code: error?.code ?? PROVIDER_ERROR_CODES.UNKNOWN,
            message: `Folder listing failed: ${error?.message ?? error}`,
            folder: null,
            retryable: error?.isRetryable ?? false,
          })
        }
      }

      for (const folder of folders) {
        const result = await this.syncFolder({ provider, mailbox, user, folder, mode })
        results.push(result)

        if (result.status === SYNC_STATUS.FAILED && result.error) {
          errors.push({
            code: result.error.code,
            message: result.error.message,
            folder,
            retryable: false,
          })
        }
      }
    } catch (error) {
      // Raised before any folder ran — a credential failure, almost always.
      errors.push({
        code: error?.code ?? PROVIDER_ERROR_CODES.UNKNOWN,
        message: error?.message ?? String(error),
        folder: null,
        retryable: error?.isRetryable ?? false,
      })

      if (error instanceof ProviderError && error.isFatal) {
        await mailboxRepo.markMailboxStatus({
          mailboxId: mailbox._id,
          status: CONNECTION_STATUS.EXPIRED,
          reason: error.code,
        })
      }
    }

    const completed = await syncRepo.finishRun({ run, results, errors })

    const totalSynced = completed.totals.messagesCreated + completed.totals.messagesUpdated

    await mailboxRepo.recordSyncStats({
      mailboxId: mailbox._id,
      messagesSynced: totalSynced,
      succeeded: completed.status !== SYNC_STATUS.FAILED,
    })

    logSyncRun({
      provider: provider.type,
      mailboxId: mailbox._id.toString(),
      status: completed.status,
      trigger,
      mode,
      folders: folders.length,
      messagesSynced: totalSynced,
      durationMs: Date.now() - startedAt,
      correlationId,
      simulated: isMock,
    })

    return completed
  }
}

/** Shared instance. Per-run state is local, so one is safe to share. */
export const syncEngine = new SyncEngine()

export default syncEngine
