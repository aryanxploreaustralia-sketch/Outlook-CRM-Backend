/**
 * Microsoft Graph implementation of `EmailProvider`.
 *
 * Everything Graph-specific in Phase 5 lives here or in the two mappers beside
 * it. Nothing above this file — sync engine, controllers, models, UI — imports
 * a Graph symbol, which is the property that makes adding Gmail or IMAP an
 * additive change rather than a rewrite.
 *
 * ## Dependencies are injected
 *
 * The constructor takes its collaborators rather than importing them, so a test
 * can drive the adapter against a fake Graph client with no network, no MSAL and
 * no database. The defaults are the real implementations, so production callers
 * construct it with nothing.
 *
 * ## What this adapter cannot do
 *
 * `POST /me/sendMail` returns 202 with an empty body and issues no message id,
 * so `send()` reports a correlation id and a null `providerMessageId`. That is a
 * property of Graph, not an omission here — `createDraft()` does return a real
 * id because `POST /me/messages` provides one.
 */

import crypto from 'node:crypto'

import { CAPABILITIES, EmailProvider } from '../../interfaces/EmailProvider.js'
import { CONNECTION_STATUS, PROVIDER_TYPES } from '../../constants/providerTypes.js'
import { FOLDERS } from '../../constants/folderTypes.js'
import { PROVIDER_ERROR_CODES, ProviderError } from '../../constants/providerErrors.js'
import { beginRequest } from '../../utils/providerLogger.js'
import { callGraph as defaultCallGraph } from './graphClient.js'
import { resolveFolderPath, toGraphWellKnownName, toProviderFolder } from './folderMapper.js'
import {
  extractDeltaToken,
  partitionDeltaValues,
  toGraphMessage,
  toProviderMessage,
} from './messageMapper.js'

/**
 * Fields requested for a message.
 *
 * Selected explicitly rather than taking Graph's default: the default includes
 * the full body on every message in a list, which for a 2,000-message folder is
 * an enormous transfer for data the list view never shows.
 */
const MESSAGE_FIELDS = [
  'id',
  'conversationId',
  /**
   * RFC 5322 threading headers.
   *
   * `conversationId` is Microsoft's own thread key and works perfectly inside
   * Outlook, but it is absent the moment a reply arrives from Gmail, an
   * on-premise Exchange or a mail client that rewrites the thread. These are
   * the standard headers every mail system honours, and they are what lets a
   * reply be matched back to the enquiry that produced it.
   *
   * `internetMessageHeaders` carries In-Reply-To and References; Graph only
   * populates it when explicitly selected.
   */
  'internetMessageId',
  'internetMessageHeaders',
  'subject',
  'bodyPreview',
  'body',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'isRead',
  'flag',
  'hasAttachments',
  'sentDateTime',
  'receivedDateTime',
  'changeKey',
].join(',')

const FOLDER_FIELDS = [
  'id',
  'displayName',
  'parentFolderId',
  'wellKnownName',
  'totalItemCount',
  'unreadItemCount',
].join(',')

/** Messages fetched per delta page. Graph caps this well below its own limit. */
const PAGE_SIZE = 50

export class MicrosoftGraphProvider extends EmailProvider {
  /**
   * @param {object} [dependencies]
   * @param {Function} [dependencies.callGraph] Graph transport, injected for testing.
   * @param {Function} [dependencies.getAccessToken] MSAL accessor, injected for testing.
   */
  constructor({ callGraph = defaultCallGraph, getAccessToken = null, ...context } = {}) {
    super(context)

    this.callGraph = callGraph
    this.getAccessToken = getAccessToken
  }

  get type() {
    return PROVIDER_TYPES.MICROSOFT_GRAPH
  }

  get label() {
    return 'Microsoft Outlook'
  }

  get capabilities() {
    return new Set([
      CAPABILITIES.SEND,
      CAPABILITIES.DRAFTS,
      CAPABILITIES.REPLY,
      CAPABILITIES.FORWARD,
      CAPABILITIES.FOLDERS,
      CAPABILITIES.SYNC,
      CAPABILITIES.INCREMENTAL_SYNC,
      CAPABILITIES.ATTACHMENTS,
      CAPABILITIES.FLAGS,
      CAPABILITIES.MOVE,
      CAPABILITIES.SEARCH,
    ])
  }

  /**
   * Resolves the `OutlookAccount` id the Graph client authenticates as.
   *
   * Every method needs it, and its absence is a programming error rather than a
   * user-facing condition — so it fails loudly and specifically.
   */
  #accountId(params = {}) {
    const id = params.mailbox?.sourceAccount ?? params.outlookAccountId ?? null

    if (!id) {
      throw new ProviderError(
        PROVIDER_ERROR_CODES.NOT_CONNECTED,
        'This mailbox is not linked to a Microsoft sign-in.',
        { provider: this.type },
      )
    }

    return id.toString()
  }

  /** Runs a Graph call with structured request/response logging. */
  async #run(operation, params, context, work) {
    const accountId = this.#accountId(params)
    const finish = beginRequest(this.type, operation, context)

    try {
      const result = await this.callGraph(accountId, operation, work)
      finish('success')
      return result
    } catch (error) {
      finish('failure', { code: error?.code ?? null, providerCode: error?.providerCode ?? null })
      throw error
    }
  }

  // --- Lifecycle -----------------------------------------------------------

  async connect(params = {}) {
    const profile = await this.#run('connect', params, {}, (client) =>
      client.api('/me').select('id,displayName,mail,userPrincipalName').get(),
    )

    return {
      connected: true,
      mailbox: {
        providerAccountId: profile.id,
        emailAddress: (profile.mail ?? profile.userPrincipalName ?? '').toLowerCase() || null,
        displayName: profile.displayName ?? null,
      },
    }
  }

  /**
   * Ends the local session's use of the mailbox.
   *
   * Deliberately does **not** revoke the Entra ID grant. Revocation is a
   * tenant-wide action affecting every device the user has signed in from, and
   * disconnecting one CRM integration should not sign them out of Outlook on
   * their phone. Credential invalidation is handled by `TokenManager.revoke`.
   */
  async disconnect() {
    return { disconnected: true }
  }

  /**
   * Forces MSAL to renew the access token.
   *
   * MSAL refreshes transparently during normal operation, so this exists to
   * *prove* the refresh path works rather than to make it work — the token
   * manager calls it to surface a broken grant before a sync depends on it.
   */
  async refreshToken(params = {}) {
    const accountId = this.#accountId(params)

    if (!this.getAccessToken) {
      // Injected only when a caller wants forced refresh; without it there is
      // nothing to force, and reporting that honestly beats pretending.
      return { refreshed: false, expiresAt: null, scope: [] }
    }

    const finish = beginRequest(this.type, 'refreshToken', {})

    try {
      const result = await this.getAccessToken(accountId)
      finish('success')

      return {
        refreshed: true,
        expiresAt: result.expiresOn ?? null,
        scope: result.scopes ?? [],
      }
    } catch (error) {
      finish('failure', { code: error?.code ?? null })
      throw new ProviderError(
        PROVIDER_ERROR_CODES.TOKEN_REFRESH_FAILED,
        error?.message ?? 'Could not renew Microsoft credentials.',
        { provider: this.type, cause: error },
      )
    }
  }

  /**
   * Proves the mailbox is reachable right now.
   *
   * Reads a single message header rather than the profile: `/me` succeeds for
   * identities with no mailbox at all, so it would report a healthy connection
   * for an account that cannot send or sync anything.
   */
  async validateConnection(params = {}) {
    try {
      /**
       * Mailbox reachability, not merely token validity.
       *
       * `/me/messages` is the cheapest call that proves the Mail scopes work
       * end to end. `/me` alone would not: a guest or unlicensed identity
       * returns 200 there — that is Entra directory data — while every Exchange
       * endpoint refuses.
       */
      await this.#run('validateConnection', params, {}, (client) =>
        client.api('/me/messages').select('id').top(1).get(),
      )

      /**
       * Who Graph says answered.
       *
       * Reported so the probe is *evidence* of which credential was used rather
       * than an echo of the mailbox the caller asked about. With several
       * mailboxes in one workspace that distinction is the whole point of the
       * button: an address returned by Microsoft proves the request
       * authenticated as that account.
       *
       * Best-effort — the reachability check above has already succeeded, and
       * failing the probe over a display string would report a healthy mailbox
       * as broken.
       */
      let identity = null
      try {
        const profile = await this.#run('validateConnection:identity', params, {}, (client) =>
          client.api('/me').select('id,mail,userPrincipalName,displayName').get(),
        )

        identity = {
          emailAddress:
            (profile?.mail ?? profile?.userPrincipalName ?? '').toLowerCase() || null,
          displayName: profile?.displayName ?? null,
          providerAccountId: profile?.id ?? null,
        }
      } catch {
        // Left null; the connection is still proven reachable.
      }

      return { status: CONNECTION_STATUS.CONNECTED, mailbox: identity, reason: null }
    } catch (error) {
      const status =
        error.code === PROVIDER_ERROR_CODES.MAILBOX_UNAVAILABLE
          ? CONNECTION_STATUS.ERROR
          : error.code === PROVIDER_ERROR_CODES.TOKEN_EXPIRED
            ? CONNECTION_STATUS.EXPIRED
            : CONNECTION_STATUS.DEGRADED

      return { status, mailbox: null, reason: error.message }
    }
  }

  // --- Sending -------------------------------------------------------------

  async send(message, params = {}) {
    const correlationId = crypto.randomUUID()

    await this.#run(
      'send',
      params,
      { recipients: message?.to?.length ?? 0, correlationId },
      (client) =>
        client
          .api('/me/sendMail')
          .header('client-request-id', correlationId)
          .post({ message: toGraphMessage(message), saveToSentItems: true }),
    )

    // Null by necessity: sendMail answers 202 with no body and no id.
    return { providerMessageId: null, correlationId }
  }

  /** Shared by reply, replyAll and forward — Graph shapes all three identically. */
  async #respond(action, messageId, payload, params) {
    const correlationId = crypto.randomUUID()

    await this.#run(action, params, { messageId, correlationId }, (client) =>
      client
        .api(`/me/messages/${messageId}/${action}`)
        .header('client-request-id', correlationId)
        .post(payload),
    )

    return { providerMessageId: null, correlationId }
  }

  async reply(messageId, reply, params = {}) {
    return this.#respond('reply', messageId, { comment: reply?.comment ?? '' }, params)
  }

  async replyAll(messageId, reply, params = {}) {
    return this.#respond('replyAll', messageId, { comment: reply?.comment ?? '' }, params)
  }

  async forward(messageId, forward, params = {}) {
    return this.#respond(
      'forward',
      messageId,
      {
        comment: forward?.comment ?? '',
        toRecipients: (forward?.to ?? []).map((r) => ({ emailAddress: { address: r.address } })),
      },
      params,
    )
  }

  // --- Drafts --------------------------------------------------------------

  async createDraft(message, params = {}) {
    const created = await this.#run('createDraft', params, {}, (client) =>
      client.api('/me/messages').post(toGraphMessage(message)),
    )

    return { providerMessageId: created?.id ?? null, webLink: created?.webLink ?? null }
  }

  async updateDraft(messageId, message, params = {}) {
    const updated = await this.#run('updateDraft', params, { messageId }, (client) =>
      client.api(`/me/messages/${messageId}`).patch(toGraphMessage(message)),
    )

    return { providerMessageId: updated?.id ?? messageId }
  }

  async deleteDraft(messageId, params = {}) {
    try {
      await this.#run('deleteDraft', params, { messageId }, (client) =>
        client.api(`/me/messages/${messageId}`).delete(),
      )
      return { deleted: true }
    } catch (error) {
      // Already gone is the outcome the caller wanted.
      if (error.code === PROVIDER_ERROR_CODES.NOT_FOUND) return { deleted: false }
      throw error
    }
  }

  // --- Folders -------------------------------------------------------------

  async getFolders(params = {}) {
    const response = await this.#run('getFolders', params, {}, (client) =>
      client.api('/me/mailFolders').select(FOLDER_FIELDS).top(100).get(),
    )

    return (response?.value ?? []).map(toProviderFolder)
  }

  async syncFolders(params = {}) {
    const folders = await this.getFolders(params)
    return { folders, created: folders.length, updated: 0 }
  }

  // --- Synchronisation -----------------------------------------------------

  /**
   * Reads one page of changes for a folder.
   *
   * Uses Graph's `/delta` endpoint, which is what makes incremental sync
   * possible: given a token it returns only what changed, including tombstones
   * for deletions. Without a token it walks the folder from the beginning and
   * issues a fresh token at the end.
   *
   * A stale token surfaces as `DELTA_TOKEN_EXPIRED`, which the engine treats as
   * a prompt to resync rather than a failure.
   */
  async #syncFolder(canonicalFolder, params = {}) {
    const folderPath =
      resolveFolderPath({
        canonical: canonicalFolder,
        providerFolderId: params.providerFolderId,
      }) ?? toGraphWellKnownName(canonicalFolder)

    if (!folderPath) {
      throw new ProviderError(
        PROVIDER_ERROR_CODES.INVALID_REQUEST,
        `No Graph folder corresponds to "${canonicalFolder}".`,
        { provider: this.type },
      )
    }

    const response = await this.#run(
      'sync',
      params,
      { folder: canonicalFolder, incremental: Boolean(params.deltaToken) },
      (client) => {
        // A delta link is a complete URL and must be replayed verbatim —
        // re-deriving it from parts would break whenever Graph changed the format.
        if (params.deltaToken) {
          return client.api(params.deltaToken).get()
        }

        return client
          .api(`/me/mailFolders/${folderPath}/messages/delta`)
          .select(MESSAGE_FIELDS)
          .top(params.pageSize ?? PAGE_SIZE)
          .get()
      },
    )

    const { messages, deletedIds } = partitionDeltaValues(response?.value ?? [])

    return {
      messages: messages.map((message) => toProviderMessage(message, canonicalFolder)),
      deletedMessageIds: deletedIds,
      deltaToken: extractDeltaToken(response),
      hasMore: Boolean(response?.['@odata.nextLink']),
    }
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
    try {
      const message = await this.#run('syncSingleMessage', params, { messageId }, (client) =>
        client.api(`/me/messages/${messageId}`).select(MESSAGE_FIELDS).get(),
      )

      return toProviderMessage(message, params.folder ?? FOLDERS.INBOX)
    } catch (error) {
      if (error.code === PROVIDER_ERROR_CODES.NOT_FOUND) return null
      throw error
    }
  }

  async downloadAttachment(messageId, attachmentId, params = {}) {
    const attachment = await this.#run(
      'downloadAttachment',
      params,
      { messageId, attachmentId },
      (client) => client.api(`/me/messages/${messageId}/attachments/${attachmentId}`).get(),
    )

    return {
      name: attachment?.name ?? 'attachment',
      contentType: attachment?.contentType ?? 'application/octet-stream',
      size: attachment?.size ?? 0,
      contentBytes: attachment?.contentBytes ?? '',
    }
  }

  // --- Message state -------------------------------------------------------

  /** Every flag change is a PATCH on the message; only the body differs. */
  async #patchMessage(operation, messageId, patch, params) {
    await this.#run(operation, params, { messageId }, (client) =>
      client.api(`/me/messages/${messageId}`).patch(patch),
    )

    return { updated: true }
  }

  async markRead(messageId, params = {}) {
    return this.#patchMessage('markRead', messageId, { isRead: true }, params)
  }

  async markUnread(messageId, params = {}) {
    return this.#patchMessage('markUnread', messageId, { isRead: false }, params)
  }

  async star(messageId, params = {}) {
    return this.#patchMessage(
      'star',
      messageId,
      { flag: { flagStatus: 'flagged' } },
      params,
    )
  }

  async unstar(messageId, params = {}) {
    return this.#patchMessage(
      'unstar',
      messageId,
      { flag: { flagStatus: 'notFlagged' } },
      params,
    )
  }

  async move(messageId, targetFolder, params = {}) {
    const destination =
      resolveFolderPath({ canonical: targetFolder, providerFolderId: params.providerFolderId }) ??
      toGraphWellKnownName(targetFolder)

    if (!destination) {
      throw new ProviderError(
        PROVIDER_ERROR_CODES.INVALID_REQUEST,
        `No Graph folder corresponds to "${targetFolder}".`,
        { provider: this.type },
      )
    }

    await this.#run('move', params, { messageId, targetFolder }, (client) =>
      client.api(`/me/messages/${messageId}/move`).post({ destinationId: destination }),
    )

    return { moved: true, folder: targetFolder }
  }

  /**
   * Moves a message to Deleted Items.
   *
   * A move, not `DELETE`. Graph's `DELETE /me/messages/{id}` on an item already
   * in Deleted Items destroys it irrecoverably, and a sync engine must never be
   * one bug away from permanently erasing a user's mail.
   */
  async delete(messageId, params = {}) {
    await this.move(messageId, FOLDERS.TRASH, params)
    return { deleted: true, folder: FOLDERS.TRASH }
  }

  async restore(messageId, targetFolder = FOLDERS.INBOX, params = {}) {
    await this.move(messageId, targetFolder, params)
    return { restored: true, folder: targetFolder }
  }

  async search(query, params = {}) {
    const term = String(query ?? '').trim()
    if (term === '') return { messages: [], total: 0 }

    /**
     * `$search` rather than `$filter`: it covers subject, body and participants
     * in one expression, where an equivalent `$filter` would be a long OR chain
     * that Exchange evaluates far less efficiently.
     *
     * The term is quoted and internal quotes stripped, so a value containing `"`
     * cannot terminate the expression early and change its meaning.
     */
    const safeTerm = term.replace(/"/g, '')

    const response = await this.#run('search', params, { query: safeTerm }, (client) =>
      client
        .api('/me/messages')
        .search(`"${safeTerm}"`)
        .select(MESSAGE_FIELDS)
        .top(params.limit ?? 25)
        .get(),
    )

    const messages = (response?.value ?? []).map((message) =>
      toProviderMessage(message, params.folder ?? FOLDERS.INBOX),
    )

    return { messages, total: messages.length }
  }
}

export default MicrosoftGraphProvider
