/**
 * Response shapes for the provider API.
 *
 * DTOs exist so the wire format is decided in one place rather than assembled
 * ad hoc in each controller. A field renamed in a model cannot silently change
 * the API — it breaks here, visibly, where the contract is written down.
 *
 * Nothing here ever emits a credential. Delta tokens are reported as a boolean
 * (`hasDeltaToken`) rather than a value: they are resume handles into a user's
 * mailbox and have no business leaving the server.
 */

import { PROVIDER_LABELS } from '../constants/providerTypes.js'
import { FOLDER_LABELS } from '../constants/folderTypes.js'
import { SYNC_STATUS_LABELS } from '../constants/syncStatus.js'

/**
 * `GET /provider/status`.
 *
 * @param {object} params
 * @returns {object}
 */
export function toStatusDto({
  mailbox,
  mailboxes = [],
  token,
  states = [],
  lastRun = null,
  isMock,
  fallbackReason,
  capabilities = [],
  availableProviders = [],
}) {
  const lastSyncAt = mailbox?.stats?.lastSyncAt ?? null

  return {
    /** True when responses are simulated. The UI must say so. */
    mockMode: isMock,
    fallbackReason,

    connected: Boolean(mailbox?.status === 'connected'),

    /** The mailbox this payload describes. */
    mailbox: mailbox ? mailbox.toPublicJSON() : null,

    /**
     * Every mailbox in the workspace, for the page's selector.
     *
     * Includes disconnected ones: they are what the operator selects in order
     * to reconnect, and filtering them out would leave the page unable to offer
     * the one action they need. Already a `toPublicJSON()` projection, so no
     * credential material is present.
     */
    mailboxes,

    provider: mailbox
      ? {
          type: mailbox.provider,
          label: PROVIDER_LABELS[mailbox.provider] ?? mailbox.provider,
          capabilities,
        }
      : null,

    token: token ? token.toPublicJSON() : null,

    sync: {
      lastSyncAt,
      lastSuccessfulSyncAt: mailbox?.stats?.lastSuccessfulSyncAt ?? null,
      /**
       * Advisory only — no scheduler runs in this phase, so this is what the
       * next run *would* be were one scheduled. Reporting a time the system will
       * not honour would be worse than reporting none, so it is null when there
       * has never been a sync.
       */
      nextSyncAt: lastSyncAt ? new Date(lastSyncAt.getTime() + 15 * 60 * 1000) : null,
      totalMessagesSynced: mailbox?.stats?.totalMessagesSynced ?? 0,
      folderCount: mailbox?.stats?.folderCount ?? 0,
      status: lastRun?.status ?? 'idle',
      statusLabel: SYNC_STATUS_LABELS[lastRun?.status] ?? 'Never synced',
      errorCount: lastRun?.runErrors?.length ?? 0,
      folders: states.map((state) => state.toPublicJSON()),
    },

    lastRun: lastRun ? lastRun.toPublicJSON() : null,

    /** Adapters this deployment can serve, for the UI's provider picker. */
    availableProviders: availableProviders.map((type) => ({
      type,
      label: PROVIDER_LABELS[type] ?? type,
    })),
  }
}

/** `GET /provider/folders`. */
export function toFolderListDto({ folders, mailbox }) {
  const items = folders.map((folder) => folder.toPublicJSON())

  return {
    mailboxId: mailbox?._id?.toString() ?? null,
    total: items.length,
    /**
     * Grouped by canonical identity so a client can render "Inbox" without
     * knowing which provider folder backs it.
     */
    byCanonical: items.reduce((accumulator, folder) => {
      accumulator[folder.canonical] ??= []
      accumulator[folder.canonical].push(folder)
      return accumulator
    }, {}),
    items,
    canonicalLabels: FOLDER_LABELS,
  }
}

/** `POST /provider/connect`. */
export function toConnectDto({ mailbox, isMock, fallbackReason, capabilities }) {
  return {
    connected: true,
    mockMode: isMock,
    fallbackReason,
    mailbox: mailbox.toPublicJSON(),
    capabilities,
  }
}

/** `POST /provider/sync` and its per-folder variants. */
export function toSyncRunDto({ run, isMock }) {
  return {
    mockMode: isMock,
    run: run.toPublicJSON(),
  }
}

/** `GET /provider/history`. */
export function toHistoryDto({ items }) {
  return items.map((entry) => entry.toPublicJSON())
}

export default {
  toStatusDto,
  toFolderListDto,
  toConnectDto,
  toSyncRunDto,
  toHistoryDto,
}
