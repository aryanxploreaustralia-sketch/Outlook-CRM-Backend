/**
 * Translation between Microsoft Graph message resources and the
 * provider-independent shapes declared in `EmailProvider`.
 *
 * This is the only file in the codebase that knows Graph's field names. Keeping
 * that knowledge in one place is what allows a second provider to be added
 * without touching the sync engine, the models or the UI.
 *
 * Translation is defensive throughout: Graph omits fields rather than sending
 * nulls, and omits different ones depending on `$select`, the folder and the
 * mailbox's age. Every access assumes absence is normal.
 */

import { FOLDERS } from '../../constants/folderTypes.js'

/**
 * Graph `emailAddress` → `{ address, name }`.
 *
 * Graph nests it as `{ emailAddress: { address, name } }` and sometimes omits
 * `name`. Returns null when there is no address at all, which happens on drafts
 * that have never had a recipient.
 */
function toRecipient(entry) {
  const address = entry?.emailAddress?.address ?? entry?.address ?? null
  if (!address) return null

  return {
    address: address.toLowerCase(),
    name: entry?.emailAddress?.name ?? entry?.name ?? null,
  }
}

/** Maps a Graph recipient array, dropping unusable entries. */
const toRecipients = (entries) => (entries ?? []).map(toRecipient).filter(Boolean)

/** Parses a Graph ISO timestamp, tolerating absence and malformed values. */
function toDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Graph message → `ProviderMessage`.
 *
 * @param {object} message Raw Graph `message` resource.
 * @param {string} folder Canonical folder the message was read from.
 * @returns {import('../../interfaces/EmailProvider.js').ProviderMessage}
 */
export function toProviderMessage(message, folder = FOLDERS.INBOX) {
  const body = message?.body ?? {}
  const isHtml = body.contentType?.toLowerCase() === 'html'

  /**
   * Graph returns `bodyPreview` even when `body` was not selected, so it is the
   * reliable fallback for a text representation. Preferring the real body when
   * present keeps the full content; falling back keeps search working when only
   * headers were fetched.
   */
  const bodyText = isHtml ? (message?.bodyPreview ?? '') : (body.content ?? message?.bodyPreview ?? '')

  /**
   * Header lookup is case-insensitive.
   *
   * RFC 5322 defines header names as case-insensitive, and mail systems differ:
   * Exchange writes `In-Reply-To`, some gateways write `in-reply-to`. Matching
   * exactly on one spelling silently loses the thread for the other.
   */
  const headers = new Map(
    (message?.internetMessageHeaders ?? []).map((header) => [
      String(header?.name ?? '').toLowerCase(),
      header?.value ?? '',
    ]),
  )

  /** Splits a References header into individual message ids. */
  const messageIdList = (value) =>
    String(value ?? '')
      .split(/\s+/)
      .map((id) => id.trim())
      .filter((id) => id.startsWith('<') && id.endsWith('>'))

  return {
    providerMessageId: message?.id ?? null,
    conversationId: message?.conversationId ?? null,
    // Graph has no separate thread concept — `conversationId` is the thread.
    threadId: message?.conversationId ?? null,
    folder,

    /** The globally unique id this message carries across every mail system. */
    internetMessageId: message?.internetMessageId ?? null,
    /** The message this one answers. The strongest threading signal there is. */
    inReplyTo: headers.get('in-reply-to')?.trim() || null,
    /** The full ancestry, oldest first. Survives subject edits and forwards. */
    references: messageIdList(headers.get('references')),

    subject: message?.subject ?? '',
    bodyHtml: isHtml ? (body.content ?? '') : '',
    bodyText,

    from:
      toRecipient(message?.from) ??
      toRecipient(message?.sender) ?? { address: '', name: null },
    to: toRecipients(message?.toRecipients),
    cc: toRecipients(message?.ccRecipients),
    // Graph only ever returns bcc on a message the caller sent; absent otherwise.
    bcc: toRecipients(message?.bccRecipients),

    isRead: message?.isRead ?? false,
    // Outlook's flag is the nearest equivalent to a star. `notFlagged` and an
    // absent flag both mean unstarred.
    isStarred: (message?.flag?.flagStatus ?? 'notFlagged') === 'flagged',

    hasAttachments: message?.hasAttachments ?? false,
    attachments: (message?.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      name: attachment.name ?? 'attachment',
      contentType: attachment.contentType ?? 'application/octet-stream',
      size: attachment.size ?? 0,
      isInline: attachment.isInline ?? false,
    })),

    sentAt: toDate(message?.sentDateTime),
    receivedAt: toDate(message?.receivedDateTime),

    /**
     * Graph's optimistic-concurrency marker. Changes whenever the message does,
     * which is what makes cheap conflict detection possible.
     */
    changeKey: message?.changeKey ?? null,
  }
}

/**
 * `ProviderMessage`-shaped input → Graph `message` resource for writing.
 *
 * Used by `send`, `createDraft`, `reply` and `forward`.
 *
 * @param {object} message
 * @returns {object}
 */
export function toGraphMessage(message) {
  const graph = {
    subject: message.subject ?? '',
    body: {
      contentType: 'HTML',
      content: message.bodyHtml ?? message.html ?? '',
    },
    toRecipients: (message.to ?? []).map((recipient) => ({
      emailAddress: recipient.name
        ? { address: recipient.address, name: recipient.name }
        : { address: recipient.address },
    })),
  }

  // Omitted rather than sent empty — Graph accepts `[]`, but leaving the keys
  // out keeps the request minimal and the logs readable.
  if (message.cc?.length) {
    graph.ccRecipients = message.cc.map((r) => ({ emailAddress: { address: r.address } }))
  }
  if (message.bcc?.length) {
    graph.bccRecipients = message.bcc.map((r) => ({ emailAddress: { address: r.address } }))
  }

  if (message.attachments?.length) {
    graph.attachments = message.attachments.map((file) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: file.name,
      contentType: file.contentType ?? 'application/octet-stream',
      contentBytes: file.contentBytes,
    }))
  }

  if (message.importance) graph.importance = message.importance

  return graph
}

/**
 * Extracts the opaque delta token from a Graph delta response.
 *
 * Graph returns `@odata.deltaLink` as a full URL with the token embedded as a
 * query parameter. The **whole URL** is stored rather than the parsed token:
 * Graph expects it replayed verbatim, and reconstructing it from parts would
 * break as soon as Microsoft added a parameter.
 *
 * @param {object} response
 * @returns {?string}
 */
export function extractDeltaToken(response) {
  return response?.['@odata.deltaLink'] ?? response?.['@odata.nextLink'] ?? null
}

/**
 * Identifies tombstones in a delta response.
 *
 * Graph marks a removed message with `@removed`, keeping only its id. These must
 * be applied as deletions, not skipped — otherwise a message deleted in Outlook
 * stays visible in the CRM indefinitely.
 *
 * @param {object[]} values
 * @returns {{ messages: object[], deletedIds: string[] }}
 */
export function partitionDeltaValues(values = []) {
  const messages = []
  const deletedIds = []

  for (const value of values) {
    if (value?.['@removed']) {
      if (value.id) deletedIds.push(value.id)
    } else {
      messages.push(value)
    }
  }

  return { messages, deletedIds }
}

export default { toProviderMessage, toGraphMessage, extractDeltaToken, partitionDeltaValues }
