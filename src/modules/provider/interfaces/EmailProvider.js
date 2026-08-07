/**
 * The contract every mail provider adapter implements.
 *
 * This is the seam that keeps business logic provider-independent. The sync
 * engine, the controllers and the mail module call these methods and never
 * import a Graph, Gmail or IMAP client directly — which is what makes adding a
 * provider an additive change rather than an edit to everything.
 *
 * ## Why a base class rather than a bare JSDoc typedef
 *
 * A typedef documents the shape but enforces nothing: a half-written adapter
 * would fail at the call site, deep inside a sync run, with
 * `provider.syncInbox is not a function`. Extending this class means an
 * unimplemented method throws a named, catchable `ProviderError` identifying
 * the adapter and the operation, and `assertImplements()` can verify the whole
 * surface at registration time — before any user triggers a sync.
 *
 * ## Capabilities
 *
 * Not every provider can do everything: SMTP can send but has no folders to
 * read, SendGrid has no concept of a draft. Rather than have callers guess,
 * each adapter declares a `capabilities` set and the engine skips what is not
 * supported instead of collecting `UNSUPPORTED` errors it cannot act on.
 */

import { PROVIDER_ERROR_CODES, ProviderError } from '../constants/providerErrors.js'

/**
 * Optional behaviours an adapter may declare.
 *
 * A capability that is absent is not a bug — it is a statement that the provider
 * has no such concept.
 */
export const CAPABILITIES = Object.freeze({
  SEND: 'send',
  DRAFTS: 'drafts',
  REPLY: 'reply',
  FORWARD: 'forward',
  FOLDERS: 'folders',
  SYNC: 'sync',
  /** Provider issues delta tokens, so incremental sync is possible. */
  INCREMENTAL_SYNC: 'incremental_sync',
  ATTACHMENTS: 'attachments',
  FLAGS: 'flags',
  MOVE: 'move',
  SEARCH: 'search',
})

/**
 * @typedef  {object} ProviderMessage
 * @property {string}  providerMessageId
 * @property {?string} conversationId
 * @property {?string} threadId
 * @property {string}  folder            Canonical folder from `folderTypes.js`.
 * @property {string}  subject
 * @property {?string} bodyHtml
 * @property {?string} bodyText
 * @property {{ address: string, name: ?string }} from
 * @property {Array<{ address: string, name: ?string }>} to
 * @property {Array<{ address: string, name: ?string }>} cc
 * @property {Array<{ address: string, name: ?string }>} bcc
 * @property {boolean} isRead
 * @property {boolean} isStarred
 * @property {boolean} hasAttachments
 * @property {Array<{ id: string, name: string, contentType: string, size: number, isInline: boolean }>} attachments
 * @property {?Date}   sentAt
 * @property {?Date}   receivedAt
 * @property {?string} changeKey         Provider version marker, used for conflict detection.
 */

/**
 * @typedef  {object} ProviderFolder
 * @property {string}  providerFolderId
 * @property {string}  displayName
 * @property {string}  canonical         Canonical folder from `folderTypes.js`.
 * @property {?string} wellKnownName
 * @property {?string} parentFolderId
 * @property {number}  totalItemCount
 * @property {number}  unreadItemCount
 */

/**
 * @typedef  {object} SyncPage
 * @property {ProviderMessage[]} messages
 * @property {string[]} deletedMessageIds Ids removed at the provider since the last token.
 * @property {?string}  deltaToken        Persist and replay on the next incremental sync.
 * @property {boolean}  hasMore
 */

export class EmailProvider {
  /**
   * @param {object} [context] Injected dependencies. Adapters must not reach for
   *   globals or construct their own clients — everything they need arrives
   *   here, which is what makes them testable in isolation.
   */
  constructor(context = {}) {
    if (new.target === EmailProvider) {
      throw new TypeError('EmailProvider is abstract and cannot be constructed directly.')
    }

    this.context = context
  }

  /** Provider identity, from `PROVIDER_TYPES`. Adapters must override. */
  get type() {
    return this.#missing('type')
  }

  /** Human-readable name for the UI. */
  get label() {
    return this.type
  }

  /**
   * Declared capabilities. Adapters override with the subset they support.
   *
   * @returns {Set<string>}
   */
  get capabilities() {
    return new Set()
  }

  /**
   * @param {string} capability One of CAPABILITIES.
   * @returns {boolean}
   */
  supports(capability) {
    return this.capabilities.has(capability)
  }

  /** Raised for any method an adapter has not implemented. */
  #missing(method) {
    throw new ProviderError(
      PROVIDER_ERROR_CODES.UNSUPPORTED,
      `${this.constructor.name} does not implement "${method}".`,
      { provider: this.constructor.name, details: { method } },
    )
  }

  // --- Lifecycle -----------------------------------------------------------

  /**
   * Establishes a usable session for a mailbox.
   *
   * @param {object} _params
   * @returns {Promise<{ connected: boolean, mailbox: object }>}
   */
  async connect(_params) {
    return this.#missing('connect')
  }

  /**
   * Releases the connection and invalidates cached credentials.
   *
   * @param {object} _params
   * @returns {Promise<{ disconnected: boolean }>}
   */
  async disconnect(_params) {
    return this.#missing('disconnect')
  }

  /**
   * Renews credentials.
   *
   * Adapters whose SDK refreshes transparently should still implement this as a
   * forced renewal, because the token manager uses it to prove the refresh path
   * works rather than waiting for an expiry to find out.
   *
   * @param {object} _params
   * @returns {Promise<{ refreshed: boolean, expiresAt: ?Date }>}
   */
  async refreshToken(_params) {
    return this.#missing('refreshToken')
  }

  /**
   * Reports whether the mailbox is reachable **right now**.
   *
   * Must perform a real round trip. A cached "connected" flag is exactly the
   * thing this method exists to distrust.
   *
   * @param {object} _params
   * @returns {Promise<{ status: string, mailbox: ?object, reason: ?string }>}
   */
  async validateConnection(_params) {
    return this.#missing('validateConnection')
  }

  // --- Sending -------------------------------------------------------------

  /** @returns {Promise<{ providerMessageId: ?string, correlationId: string }>} */
  async send(_message, _params) {
    return this.#missing('send')
  }

  /** @returns {Promise<{ providerMessageId: ?string, correlationId: string }>} */
  async reply(_messageId, _reply, _params) {
    return this.#missing('reply')
  }

  /** @returns {Promise<{ providerMessageId: ?string, correlationId: string }>} */
  async replyAll(_messageId, _reply, _params) {
    return this.#missing('replyAll')
  }

  /** @returns {Promise<{ providerMessageId: ?string, correlationId: string }>} */
  async forward(_messageId, _forward, _params) {
    return this.#missing('forward')
  }

  // --- Drafts --------------------------------------------------------------

  /** @returns {Promise<{ providerMessageId: string, webLink: ?string }>} */
  async createDraft(_message, _params) {
    return this.#missing('createDraft')
  }

  /** @returns {Promise<{ providerMessageId: string }>} */
  async updateDraft(_messageId, _message, _params) {
    return this.#missing('updateDraft')
  }

  /** @returns {Promise<{ deleted: boolean }>} */
  async deleteDraft(_messageId, _params) {
    return this.#missing('deleteDraft')
  }

  // --- Folders -------------------------------------------------------------

  /** @returns {Promise<ProviderFolder[]>} */
  async getFolders(_params) {
    return this.#missing('getFolders')
  }

  /** @returns {Promise<{ folders: ProviderFolder[], created: number, updated: number }>} */
  async syncFolders(_params) {
    return this.#missing('syncFolders')
  }

  // --- Synchronisation -----------------------------------------------------
  //
  // Each returns a SyncPage. Passing a `deltaToken` requests an incremental
  // read; omitting it requests a full one.

  /** @returns {Promise<SyncPage>} */
  async syncInbox(_params) {
    return this.#missing('syncInbox')
  }

  /** @returns {Promise<SyncPage>} */
  async syncSent(_params) {
    return this.#missing('syncSent')
  }

  /** @returns {Promise<SyncPage>} */
  async syncDrafts(_params) {
    return this.#missing('syncDrafts')
  }

  /** @returns {Promise<SyncPage>} */
  async syncTrash(_params) {
    return this.#missing('syncTrash')
  }

  /** @returns {Promise<SyncPage>} */
  async syncArchive(_params) {
    return this.#missing('syncArchive')
  }

  /** @returns {Promise<?ProviderMessage>} */
  async syncSingleMessage(_messageId, _params) {
    return this.#missing('syncSingleMessage')
  }

  /** @returns {Promise<{ name: string, contentType: string, size: number, contentBytes: string }>} */
  async downloadAttachment(_messageId, _attachmentId, _params) {
    return this.#missing('downloadAttachment')
  }

  // --- Message state -------------------------------------------------------

  /** @returns {Promise<{ updated: boolean }>} */
  async markRead(_messageId, _params) {
    return this.#missing('markRead')
  }

  /** @returns {Promise<{ updated: boolean }>} */
  async markUnread(_messageId, _params) {
    return this.#missing('markUnread')
  }

  /** @returns {Promise<{ moved: boolean, folder: string }>} */
  async move(_messageId, _targetFolder, _params) {
    return this.#missing('move')
  }

  /** Moves to trash. Permanent removal is not exposed — see `MicrosoftGraphProvider`. */
  async delete(_messageId, _params) {
    return this.#missing('delete')
  }

  /** @returns {Promise<{ restored: boolean, folder: string }>} */
  async restore(_messageId, _targetFolder, _params) {
    return this.#missing('restore')
  }

  /** @returns {Promise<{ updated: boolean }>} */
  async star(_messageId, _params) {
    return this.#missing('star')
  }

  /** @returns {Promise<{ updated: boolean }>} */
  async unstar(_messageId, _params) {
    return this.#missing('unstar')
  }

  /** @returns {Promise<{ messages: ProviderMessage[], total: number }>} */
  async search(_query, _params) {
    return this.#missing('search')
  }
}

/**
 * Every method an adapter is expected to provide.
 *
 * Derived from the prototype rather than hand-listed, so it can never drift out
 * of step with the class above.
 */
export const REQUIRED_METHODS = Object.freeze(
  Object.getOwnPropertyNames(EmailProvider.prototype).filter(
    (name) =>
      name !== 'constructor' &&
      name !== 'supports' &&
      typeof Object.getOwnPropertyDescriptor(EmailProvider.prototype, name)?.value === 'function',
  ),
)

/**
 * Verifies an adapter implements the whole interface.
 *
 * Called by the registry at startup. Finding a gap here — at registration, with
 * the method named — is enormously cheaper than finding it midway through a sync
 * run against a live mailbox.
 *
 * @param {EmailProvider} provider
 * @returns {{ ok: boolean, missing: string[], unsupported: string[] }}
 *   `missing` means the method is genuinely absent. `unsupported` means it is
 *   inherited from the base and will throw — acceptable when the corresponding
 *   capability is not declared, which is why the two are reported separately.
 */
export function assertImplements(provider) {
  const missing = []
  const unsupported = []

  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== 'function') {
      missing.push(method)
      continue
    }

    // Still the base implementation, so calling it would throw UNSUPPORTED.
    if (provider[method] === EmailProvider.prototype[method]) {
      unsupported.push(method)
    }
  }

  return { ok: missing.length === 0, missing, unsupported }
}

export default EmailProvider
