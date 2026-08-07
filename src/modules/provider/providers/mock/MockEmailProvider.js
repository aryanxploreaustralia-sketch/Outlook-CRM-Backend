/**
 * In-memory provider used when no real one is configured.
 *
 * ## Why this exists
 *
 * The whole application above the provider interface — sync engine, folder
 * mapping, conflict resolution, the UI — can be built, demonstrated and tested
 * without Azure credentials, an Exchange mailbox or a network connection. That
 * matters practically: this project spent Phase 5 blocked on a mailbox that
 * turned out not to exist, and every layer above the adapter was untestable
 * while that was true.
 *
 * ## It never throws
 *
 * Every method resolves. A mock that fails is indistinguishable from a broken
 * integration, and the point of falling back to it is that the application keeps
 * working when credentials are absent. Operations that cannot be meaningfully
 * simulated return an honest negative result — `{ updated: false }` — rather
 * than pretending or raising.
 *
 * Mutations are held in memory for the process lifetime, so marking a message
 * read within a session behaves correctly. They are deliberately not persisted:
 * this is a simulator, not a second database.
 */

import crypto from 'node:crypto'

import { EmailProvider, CAPABILITIES } from '../../interfaces/EmailProvider.js'
import { CONNECTION_STATUS, PROVIDER_TYPES } from '../../constants/providerTypes.js'
import { FOLDERS, SYNCABLE_FOLDERS } from '../../constants/folderTypes.js'
import { buildMockFolders, buildMockMessages } from './mockData.js'
import { beginRequest } from '../../utils/providerLogger.js'

/** Simulated network latency, so the UI's loading states are exercised. */
const SIMULATED_LATENCY_MS = 120

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class MockEmailProvider extends EmailProvider {
  constructor(context = {}) {
    super(context)

    /**
     * Per-message state changed during this process's lifetime.
     * @type {Map<string, { isRead?: boolean, isStarred?: boolean, folder?: string, deleted?: boolean }>}
     */
    this.overrides = new Map()

    /** Drafts created through this adapter, so create → update → delete works. */
    this.drafts = new Map()
  }

  get type() {
    return PROVIDER_TYPES.MOCK
  }

  get label() {
    return 'Simulated mailbox'
  }

  get capabilities() {
    // Everything, deliberately: the mock's job is to let every code path above
    // it run, and a capability it withheld would leave that path untested.
    return new Set(Object.values(CAPABILITIES))
  }

  /** Address the simulated mailbox belongs to. */
  #ownerAddress(params = {}) {
    return params.mailbox?.emailAddress ?? 'demo.user@contoso.com'
  }

  #mailboxId(params = {}) {
    return params.mailbox?._id?.toString() ?? 'mock-mailbox'
  }

  /** Applies in-session mutations over the generated fixtures. */
  #withOverrides(messages) {
    return messages
      .map((message) => {
        const override = this.overrides.get(message.providerMessageId)
        return override ? { ...message, ...override } : message
      })
      .filter((message) => !message.deleted)
  }

  #messagesFor(folder, params) {
    return this.#withOverrides(
      buildMockMessages({
        folder,
        mailboxId: this.#mailboxId(params),
        ownerAddress: this.#ownerAddress(params),
      }),
    )
  }

  /**
   * Wraps an operation with latency and structured logging.
   *
   * Every method routes through this so mock traffic appears in the logs the
   * same way real traffic does — which is what makes the logging itself
   * testable without a provider.
   */
  async #simulate(operation, context, produce) {
    const finish = beginRequest(this.type, operation, context)
    await delay(SIMULATED_LATENCY_MS)
    const result = await produce()
    finish('success', { simulated: true })
    return result
  }

  // --- Lifecycle -----------------------------------------------------------

  async connect(params = {}) {
    return this.#simulate('connect', {}, () => ({
      connected: true,
      mailbox: {
        providerAccountId: `mock-account-${this.#mailboxId(params)}`,
        emailAddress: this.#ownerAddress(params),
        displayName: 'Demo User',
      },
    }))
  }

  async disconnect() {
    return this.#simulate('disconnect', {}, () => {
      this.overrides.clear()
      this.drafts.clear()
      return { disconnected: true }
    })
  }

  async refreshToken() {
    return this.#simulate('refreshToken', {}, () => ({
      refreshed: true,
      // An hour out, matching a real access-token lifetime so expiry handling
      // behaves the same against the mock.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'User.Read'],
    }))
  }

  async validateConnection(params = {}) {
    return this.#simulate('validateConnection', {}, () => ({
      status: CONNECTION_STATUS.CONNECTED,
      mailbox: {
        emailAddress: this.#ownerAddress(params),
        displayName: 'Demo User',
      },
      reason: null,
    }))
  }

  // --- Sending -------------------------------------------------------------

  async send(message, _params = {}) {
    return this.#simulate(
      'send',
      { recipients: message?.to?.length ?? 0 },
      () => ({
        providerMessageId: `mock-sent-${crypto.randomUUID()}`,
        correlationId: crypto.randomUUID(),
      }),
    )
  }

  async reply(messageId, _reply, _params = {}) {
    return this.#simulate('reply', { messageId }, () => ({
      providerMessageId: `mock-reply-${crypto.randomUUID()}`,
      correlationId: crypto.randomUUID(),
    }))
  }

  async replyAll(messageId, _reply, _params = {}) {
    return this.#simulate('replyAll', { messageId }, () => ({
      providerMessageId: `mock-replyall-${crypto.randomUUID()}`,
      correlationId: crypto.randomUUID(),
    }))
  }

  async forward(messageId, _forward, _params = {}) {
    return this.#simulate('forward', { messageId }, () => ({
      providerMessageId: `mock-forward-${crypto.randomUUID()}`,
      correlationId: crypto.randomUUID(),
    }))
  }

  // --- Drafts --------------------------------------------------------------

  async createDraft(message, _params = {}) {
    return this.#simulate('createDraft', {}, () => {
      const id = `mock-draft-${crypto.randomUUID()}`
      this.drafts.set(id, message)
      return { providerMessageId: id, webLink: `https://outlook.example/mock/${id}` }
    })
  }

  async updateDraft(messageId, message, _params = {}) {
    return this.#simulate('updateDraft', { messageId }, () => {
      this.drafts.set(messageId, message)
      return { providerMessageId: messageId }
    })
  }

  async deleteDraft(messageId, _params = {}) {
    return this.#simulate('deleteDraft', { messageId }, () => ({
      deleted: this.drafts.delete(messageId),
    }))
  }

  // --- Folders -------------------------------------------------------------

  async getFolders(_params = {}) {
    return this.#simulate('getFolders', {}, () => buildMockFolders())
  }

  async syncFolders(_params = {}) {
    return this.#simulate('syncFolders', {}, () => {
      const folders = buildMockFolders()
      return { folders, created: folders.length, updated: 0 }
    })
  }

  // --- Synchronisation -----------------------------------------------------

  /**
   * Produces a sync page for a folder.
   *
   * A replayed delta token returns an empty page with the same token — which is
   * exactly what a real provider does when nothing has changed, and is the case
   * most likely to be handled wrongly by an engine tested only against fresh
   * data.
   */
  async #syncFolder(folder, params = {}) {
    return this.#simulate('sync', { folder, incremental: Boolean(params.deltaToken) }, () => {
      if (params.deltaToken) {
        return {
          messages: [],
          deletedMessageIds: [],
          deltaToken: params.deltaToken,
          hasMore: false,
        }
      }

      const messages = this.#messagesFor(folder, params)

      return {
        messages,
        deletedMessageIds: [],
        deltaToken: `mock-delta-${folder}-${Date.now().toString(36)}`,
        hasMore: false,
      }
    })
  }

  async syncInbox(params = {}) {
    return this.#syncFolder(FOLDERS.INBOX, params)
  }

  async syncSent(params = {}) {
    return this.#syncFolder(FOLDERS.SENT, params)
  }

  async syncDrafts(params = {}) {
    return this.#syncFolder(FOLDERS.DRAFTS, params)
  }

  async syncTrash(params = {}) {
    return this.#syncFolder(FOLDERS.TRASH, params)
  }

  async syncArchive(params = {}) {
    return this.#syncFolder(FOLDERS.ARCHIVE, params)
  }

  async syncSingleMessage(messageId, params = {}) {
    return this.#simulate('syncSingleMessage', { messageId }, () => {
      for (const folder of SYNCABLE_FOLDERS) {
        const found = this.#messagesFor(folder, params).find(
          (message) => message.providerMessageId === messageId,
        )
        if (found) return found
      }
      return null
    })
  }

  async downloadAttachment(messageId, attachmentId, _params = {}) {
    return this.#simulate('downloadAttachment', { messageId, attachmentId }, () => ({
      name: 'mock-attachment.pdf',
      contentType: 'application/pdf',
      size: 12,
      // "mock file" in base64 — small, valid, and obviously not real content.
      contentBytes: Buffer.from('mock file').toString('base64'),
    }))
  }

  // --- Message state -------------------------------------------------------

  /** Records an in-session mutation and reports it as applied. */
  #override(messageId, patch) {
    this.overrides.set(messageId, { ...(this.overrides.get(messageId) ?? {}), ...patch })
    return { updated: true }
  }

  async markRead(messageId, _params = {}) {
    return this.#simulate('markRead', { messageId }, () =>
      this.#override(messageId, { isRead: true }),
    )
  }

  async markUnread(messageId, _params = {}) {
    return this.#simulate('markUnread', { messageId }, () =>
      this.#override(messageId, { isRead: false }),
    )
  }

  async move(messageId, targetFolder, _params = {}) {
    return this.#simulate('move', { messageId, targetFolder }, () => {
      this.#override(messageId, { folder: targetFolder })
      return { moved: true, folder: targetFolder }
    })
  }

  async delete(messageId, _params = {}) {
    return this.#simulate('delete', { messageId }, () => {
      this.#override(messageId, { folder: FOLDERS.TRASH })
      return { deleted: true, folder: FOLDERS.TRASH }
    })
  }

  async restore(messageId, targetFolder = FOLDERS.INBOX, _params = {}) {
    return this.#simulate('restore', { messageId, targetFolder }, () => {
      this.#override(messageId, { folder: targetFolder, deleted: false })
      return { restored: true, folder: targetFolder }
    })
  }

  async star(messageId, _params = {}) {
    return this.#simulate('star', { messageId }, () =>
      this.#override(messageId, { isStarred: true }),
    )
  }

  async unstar(messageId, _params = {}) {
    return this.#simulate('unstar', { messageId }, () =>
      this.#override(messageId, { isStarred: false }),
    )
  }

  async search(query, params = {}) {
    return this.#simulate('search', { query }, () => {
      const needle = String(query ?? '').toLowerCase()

      if (needle === '') return { messages: [], total: 0 }

      const matches = SYNCABLE_FOLDERS.flatMap((folder) =>
        this.#messagesFor(folder, params).filter(
          (message) =>
            message.subject.toLowerCase().includes(needle) ||
            message.bodyText.toLowerCase().includes(needle) ||
            message.from.address.toLowerCase().includes(needle),
        ),
      )

      return { messages: matches, total: matches.length }
    })
  }
}

export default MockEmailProvider
