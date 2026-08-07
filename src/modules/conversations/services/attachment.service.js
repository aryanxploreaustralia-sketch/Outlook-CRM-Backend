/**
 * Fetching, storing and serving conversation attachments.
 *
 * ## Why a worker rather than inline with the sync
 *
 * A thread may carry a 12 MB itinerary. Downloading it while ingesting the
 * message would hold the sync open on a network round trip per file, and one
 * slow provider response would stall every later message in the batch. The sync
 * records metadata; this drains the queue afterwards.
 *
 * ## Storage layout
 *
 * `<root>/<owner>/<conversation>/<attachmentId>-<safeName>`
 *
 * The attachment id is in the filename so two files of the same name in one
 * thread cannot collide, and the owner is the top segment so a path traversal
 * would have to escape three levels to reach anything of another user's.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { config } from '../../../config/index.js'
import { ConversationAttachment, safeFileName } from '../../../models/conversationAttachment.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import {
  ATTACHMENT_STATUS,
  MAX_ATTACHMENT_BYTES,
  PREVIEWABLE_MIME_TYPES,
} from '../constants/conversationConstants.js'

const log = createContextLogger('conversations')

/**
 * Where attachment bytes live. Outside the source tree, alongside other state.
 *
 * Resolved from the backend package root rather than `process.cwd()`, so a
 * download link keeps working after a deployment change alters how the process
 * is started. The traversal guards below are unaffected — they compare against
 * whatever this resolves to.
 */
export const STORAGE_ROOT = config.storage.attachments

/**
 * Builds the on-disk path for an attachment, and proves it stays inside the root.
 *
 * The filename is sender-controlled. `safeFileName` strips separators, and this
 * re-checks the resolved path afterwards — a single sanitiser is a single point
 * of failure for the one bug class that would let a customer overwrite `.env`.
 */
export function resolveStoragePath(attachment) {
  const relative = path.join(
    String(attachment.owner),
    String(attachment.conversation),
    `${attachment._id}-${safeFileName(attachment.fileName)}`,
  )

  const absolute = path.resolve(STORAGE_ROOT, relative)

  if (!absolute.startsWith(STORAGE_ROOT + path.sep)) {
    throw ApiError.badRequest('The attachment path is not valid.')
  }

  return { relative, absolute }
}

/**
 * Downloads one attachment's bytes.
 *
 * @param {{ attachment, provider }} params  Scoped by the caller.
 * @returns {Promise<{ status: string, reason: ?string }>}
 */
export async function downloadAttachment({ attachment, provider }) {
  if (attachment.downloadStatus === ATTACHMENT_STATUS.DOWNLOADED) {
    return { status: ATTACHMENT_STATUS.DOWNLOADED, reason: null }
  }

  // Blocked and oversized rows were decided at ingest; re-deciding here would
  // let a retry bypass the policy.
  if ([ATTACHMENT_STATUS.BLOCKED, ATTACHMENT_STATUS.TOO_LARGE].includes(attachment.downloadStatus)) {
    return { status: attachment.downloadStatus, reason: attachment.downloadError }
  }

  const message = await attachment.populate('message')
  const providerMessageId = message.message?.providerMessageId

  if (!providerMessageId || !attachment.providerAttachmentId) {
    attachment.downloadStatus = ATTACHMENT_STATUS.FAILED
    attachment.downloadError = 'The message or attachment has no provider id; it cannot be fetched.'
    await attachment.save()
    return { status: ATTACHMENT_STATUS.FAILED, reason: attachment.downloadError }
  }

  try {
    const result = await provider.downloadAttachment(providerMessageId, attachment.providerAttachmentId, {})

    const bytes = Buffer.isBuffer(result?.content)
      ? result.content
      : Buffer.from(result?.content ?? result ?? '', 'base64')

    // Re-checked against the real bytes: the size the provider advertised in
    // the metadata is a claim, and a claim is not a limit.
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      attachment.downloadStatus = ATTACHMENT_STATUS.TOO_LARGE
      attachment.downloadError = `The file is ${Math.round(bytes.length / 1024 / 1024)} MB once fetched, beyond the limit.`
      await attachment.save()
      return { status: ATTACHMENT_STATUS.TOO_LARGE, reason: attachment.downloadError }
    }

    const { relative, absolute } = resolveStoragePath(attachment)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, bytes)

    attachment.storagePath = relative
    attachment.size = bytes.length
    attachment.checksum = createHash('sha256').update(bytes).digest('hex')
    attachment.downloadStatus = ATTACHMENT_STATUS.DOWNLOADED
    attachment.downloadError = null
    attachment.downloadedAt = new Date()
    await attachment.save()

    return { status: ATTACHMENT_STATUS.DOWNLOADED, reason: null }
  } catch (error) {
    attachment.downloadStatus = ATTACHMENT_STATUS.FAILED
    attachment.downloadError = error?.message ?? 'The download failed.'
    await attachment.save()

    log.warn('Attachment download failed', {
      attachment: attachment._id.toString(),
      error: error?.message,
    })

    return { status: ATTACHMENT_STATUS.FAILED, reason: attachment.downloadError }
  }
}

/**
 * Drains the pending download queue.
 *
 * Sequential and capped. A mailbox that has just synced 200 messages may have
 * hundreds of attachments waiting, and fetching them in parallel is the fastest
 * way to be rate limited by the provider — which would then delay the message
 * sync that matters more.
 */
export async function processDownloadQueue({ owner, provider, limit = 25 }) {
  const pending = await ConversationAttachment.find({
    owner,
    downloadStatus: ATTACHMENT_STATUS.PENDING,
    isDeleted: false,
  })
    .sort({ createdAt: 1 })
    .limit(limit)

  const outcome = { attempted: pending.length, downloaded: 0, failed: 0, skipped: 0 }

  for (const attachment of pending) {
    const { status } = await downloadAttachment({ attachment, provider })

    if (status === ATTACHMENT_STATUS.DOWNLOADED) outcome.downloaded += 1
    else if (status === ATTACHMENT_STATUS.FAILED) outcome.failed += 1
    else outcome.skipped += 1
  }

  if (outcome.attempted > 0) log.info('Attachment queue drained', outcome)

  return outcome
}

/**
 * Opens a stored attachment for streaming.
 *
 * Ownership is checked here, not by the route, so no caller can serve another
 * user's file by passing an id it happened to learn.
 */
export async function openAttachment({ owner, attachmentId }) {
  const attachment = await ConversationAttachment.findOne({ _id: attachmentId, owner, isDeleted: false })

  if (!attachment) throw ApiError.notFound('No attachment with that id exists.')

  if (attachment.downloadStatus !== ATTACHMENT_STATUS.DOWNLOADED || !attachment.storagePath) {
    throw ApiError.badRequest(
      attachment.downloadError ?? 'The attachment has not been downloaded yet.',
    )
  }

  const absolute = path.resolve(STORAGE_ROOT, attachment.storagePath)

  if (!absolute.startsWith(STORAGE_ROOT + path.sep)) {
    throw ApiError.badRequest('The attachment path is not valid.')
  }

  try {
    await stat(absolute)
  } catch {
    attachment.downloadStatus = ATTACHMENT_STATUS.FAILED
    attachment.downloadError = 'The stored file is missing.'
    await attachment.save()
    throw ApiError.notFound('The stored file is missing; re-sync the conversation.')
  }

  return {
    attachment,
    stream: createReadStream(absolute),
    /**
     * Inline only for types a browser renders safely.
     *
     * Serving an arbitrary type inline invites the browser to sniff it and
     * execute; anything not on the preview list is forced to download.
     */
    disposition: PREVIEWABLE_MIME_TYPES.has(attachment.mimeType) ? 'inline' : 'attachment',
  }
}

/** Removes an attachment's bytes and marks the row deleted. */
export async function deleteAttachment({ owner, attachmentId }) {
  const attachment = await ConversationAttachment.findOne({ _id: attachmentId, owner, isDeleted: false })
  if (!attachment) throw ApiError.notFound('No attachment with that id exists.')

  if (attachment.storagePath) {
    const absolute = path.resolve(STORAGE_ROOT, attachment.storagePath)
    if (absolute.startsWith(STORAGE_ROOT + path.sep)) {
      await unlink(absolute).catch(() => {})
    }
  }

  attachment.isDeleted = true
  attachment.storagePath = null
  await attachment.save()

  return attachment
}

export default {
  downloadAttachment,
  processDownloadQueue,
  openAttachment,
  deleteAttachment,
  resolveStoragePath,
  STORAGE_ROOT,
}
