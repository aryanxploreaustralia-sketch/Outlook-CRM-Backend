/**
 * Mail engine.
 *
 * Owns the outbound message lifecycle: build the Graph payload, persist the
 * attempt, call Graph, record the outcome. Controllers deal with HTTP; this
 * module is the only place that knows how a CRM message becomes a Graph message.
 *
 * ## Persist-before-send
 *
 * The record is written with `status: 'pending'` *before* Graph is called, and
 * updated afterwards. Writing it only on success would be simpler and wrong: a
 * crash, a timeout, or a process restart mid-call would leave a message that may
 * well have been delivered with no record that it ever existed. The ordering
 * chosen here can leave a `pending` row for a send whose outcome is genuinely
 * unknown — which is the honest state, and one the user can see and act on.
 *
 * ## Failures are recorded, then re-thrown
 *
 * A Graph rejection updates the row to `failed` with the underlying code, and
 * *then* propagates. The caller still gets a real error, and the history still
 * explains what happened. Swallowing it would report success for a message that
 * was never sent.
 */

import crypto from 'node:crypto'
import { embedInlineImages } from '../utils/emailHtml.js'

import { config } from '../config/index.js'
import { MAIL_STATUS } from '../constants/mailStatus.js'
import { Mail } from '../models/mail.model.js'
import { ApiError } from '../utils/ApiError.js'
import { createContextLogger } from '../utils/logger.js'
import {
  createDraftMessage,
  deleteMailMessage,
  describeGraphError,
  sendMailMessage,
} from './graph.service.js'

const log = createContextLogger('mail')

/** Block-level tags whose boundaries are line breaks in the text alternative. */
const BLOCK_BOUNDARY = /<\/?(?:p|div|br|li|tr|h[1-6]|blockquote|pre)[^>]*>/gi

/** The five entities that must be decoded for text output to read correctly. */
const HTML_ENTITIES = Object.freeze({
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
})

/**
 * Derives a plain-text alternative from an HTML body.
 *
 * Not a general-purpose HTML renderer, and not trying to be. Its only job is to
 * give the history list and search something readable when the client sends
 * HTML alone. Structural tags become line breaks so paragraphs do not run
 * together, and `<script>`/`<style>` contents are dropped entirely — they are
 * never prose, and leaving them in would put code into a preview.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (!html) return ''

  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(BLOCK_BOUNDARY, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#?\w+;/g, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity)
    // Collapse the runs of blank lines the tag stripping leaves behind.
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

/** Maps stored recipients to the `emailAddress` shape Graph requires. */
const toGraphRecipients = (recipients) =>
  (recipients ?? []).map(({ address, name }) => ({
    emailAddress: name ? { address, name } : { address },
  }))

/**
 * Builds the Graph `message` resource.
 *
 * The body is always sent as HTML. Outlook derives its own text alternative for
 * clients that need one, so sending `contentType: 'Text'` when only plain text
 * was supplied would lose formatting for no gain — the plain-text input is
 * wrapped instead.
 *
 * Exported because it is a pure function and the exact shape it produces is the
 * contract with Graph — verifying it directly is far cheaper and more precise
 * than asserting on a mocked HTTP call.
 *
 * @param {object} payload Validated request body.
 * @returns {object}
 */
export function buildGraphMessage(payload) {
  const composed =
    payload.html?.trim() !== ''
      ? payload.html
      : // Escaped, or a plain-text body containing "<" would silently become markup.
        `<p>${escapeHtml(payload.text ?? '').replace(/\n/g, '<br>')}</p>`

  /*
   * Embedded pictures become inline attachments before the body is sent.
   *
   * A body with no `data:` image passes through untouched and produces no
   * attachments, so every message that worked before this existed produces the
   * identical payload.
   */
  const { html, attachments: inlineAttachments } = embedInlineImages(composed)

  const message = {
    subject: payload.subject ?? '',
    body: { contentType: 'HTML', content: html },
    toRecipients: toGraphRecipients(payload.to),
  }

  // Omitted rather than sent empty: Graph accepts `[]`, but leaving the keys out
  // keeps the request minimal and the logs readable.
  if (payload.cc?.length) message.ccRecipients = toGraphRecipients(payload.cc)
  if (payload.bcc?.length) message.bccRecipients = toGraphRecipients(payload.bcc)

  /*
   * The reader's attachments and the body's inline images share one list.
   *
   * Graph carries both in `attachments`; `isInline` is what separates a file
   * the recipient sees listed from one the body refers to by Content-ID. The
   * user's files keep their original order and are unchanged — the inline
   * images are appended, never substituted for them.
   */
  const userAttachments = (payload.attachments ?? []).map((file) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: file.name,
    contentType: file.contentType,
    contentBytes: file.contentBytes,
  }))

  const attachments = [...userAttachments, ...inlineAttachments]

  // Omitted rather than sent empty, for the same reason as the recipients above.
  if (attachments.length) message.attachments = attachments

  return message
}

/** Escapes the five characters that change meaning inside HTML. */
function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Decoded size of a base64 payload, without allocating a Buffer for it. */
function decodedSize(base64) {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** Attachment metadata for storage — the bytes are deliberately not kept. */
const toStoredAttachments = (attachments) =>
  (attachments ?? []).map((file) => ({
    name: file.name,
    contentType: file.contentType,
    size: decodedSize(file.contentBytes),
  }))

/**
 * The signed-in user's id, for operations that read or delete local records.
 *
 * @param {object} auth
 * @returns {import('mongoose').Types.ObjectId}
 */
function requireUserId(auth) {
  if (!auth?.user) throw ApiError.unauthorized('You must sign in to access your mail.')
  return auth.user._id
}

/**
 * Decides which mailbox a message goes out from.
 *
 * ## Why this no longer reads `auth.outlookAccount`
 *
 * It used to, and that was the Compose half of the Phase 13.2 bug. The session's
 * Outlook account is null for a Google-authenticated user, so every send failed
 * with "connect your Microsoft account" for a workspace that had mailboxes
 * connected and working.
 *
 * The sender is now resolved from `Mailbox`, which is where mailbox access
 * actually lives:
 *
 *  1. `mailboxId` when the composer chose one in Send From.
 *  2. The workspace default otherwise.
 *  3. The session's Outlook account, only as a last resort — for a
 *     Microsoft-authenticated session on an installation whose mailboxes have
 *     not been materialised yet. Without this a pre-Phase-13.2 user could not
 *     send until something ran `resolveContext`, which would be a regression.
 *
 * The Graph credential is reached through `mailbox.sourceAccount`, so a send
 * from the second mailbox uses the second mailbox's authorisation and there is
 * still exactly one Graph implementation underneath.
 *
 * @param {object} auth
 * @param {?string} mailboxId
 * @returns {Promise<{ userId, accountId: ?object, mailboxId: ?object, from: ?string }>}
 */
async function resolveSender(auth, mailboxId = null) {
  const user = auth?.user

  if (!user) {
    throw ApiError.unauthorized('You must sign in to send mail.')
  }

  const mailboxRepo = await import('../modules/provider/repositories/mailbox.repository.js')

  const mailbox = mailboxId
    ? await mailboxRepo.findMailbox({ user: user._id, mailboxId })
    : await mailboxRepo.findDefaultMailbox({ user: user._id })

  /**
   * A named mailbox that does not resolve is refused, never silently swapped.
   *
   * Scoped by `user` in the repository, so this also covers an id belonging to
   * another workspace: it does not resolve, and the send is refused rather than
   * going out from somebody else's address.
   */
  if (mailboxId && !mailbox) {
    throw ApiError.notFound('That mailbox does not exist, or is not yours to send from.')
  }

  if (mailbox?.sourceAccount) {
    return {
      userId: user._id,
      accountId: mailbox.sourceAccount,
      mailboxId: mailbox._id,
      from: mailbox.emailAddress ?? user.email ?? null,
    }
  }

  // Legacy fallback — see (3) above.
  const account = auth?.outlookAccount ?? null

  return {
    userId: user._id,
    accountId: account?._id ?? null,
    mailboxId: mailbox?._id ?? null,
    from: account?.email ?? mailbox?.emailAddress ?? user.email ?? null,
  }
}

/** Builds the common document fields shared by sends and drafts. */
function buildMailDocument(payload, sender, status) {
  return {
    userId: sender.userId,
    outlookAccountId: sender.accountId,
    // Phase 13.2 — which connected mailbox actually sent it. Recorded alongside
    // `outlookAccountId` rather than replacing it, so history written before
    // this phase still reads back exactly as it did.
    mailbox: sender.mailboxId,
    from: sender.from,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    html: payload.html,
    // A caller-supplied text body wins; otherwise one is derived so history and
    // search are never empty for an HTML-only message.
    text: payload.text?.trim() !== '' ? payload.text : htmlToText(payload.html),
    attachments: toStoredAttachments(payload.attachments),
    status,

    /**
     * Phase 11 — which template the composer started from, when they used one.
     *
     * Recorded rather than inferred, and only when the client says so. The user
     * may have edited the message after applying a template, which is expressly
     * allowed; the rendered subject and body stored above are what actually
     * went out, and this is provenance, not a claim about the content.
     */
    template: payload.templateId ?? null,
    templateName: payload.templateName ?? null,
    templateVersion: payload.templateVersion ?? null,
  }
}

/**
 * Sends a message and records the attempt.
 *
 * @param {object} params
 * @param {object} params.auth `req.auth`
 * @param {object} params.payload Validated body from `sendMailSchema`.
 * @returns {Promise<import('mongoose').Document>} The persisted record.
 */
export async function sendMail({ auth, payload }) {
  const sender = await resolveSender(auth, payload.mailboxId ?? null)

  // `requireOutlookConnection` already guarantees this on the route. Repeated
  // here because the check costs nothing and the alternative — a TypeError on
  // `null.toString()` inside the Graph call — would surface as a 500 rather
  // than the actionable "connect your mailbox" message.
  if (!sender.accountId) {
    throw ApiError.forbidden(
      'No Outlook mailbox is connected to this session. Please connect your Microsoft account.',
    )
  }

  const clientRequestId = crypto.randomUUID()

  const record = await Mail.create({
    ...buildMailDocument(payload, sender, MAIL_STATUS.PENDING),
    graphRequestId: clientRequestId,
    attemptCount: 1,
  })

  const graphMessage = buildGraphMessage(payload)

  try {
    await sendMailMessage(sender.accountId.toString(), graphMessage, clientRequestId)

    record.status = MAIL_STATUS.SENT
    record.sentAt = new Date()
    record.error = null
    await record.save()

    log.info('Message sent', {
      mailId: record._id.toString(),
      recipients: payload.to.length,
      attachments: payload.attachments.length,
      clientRequestId,
    })

    return record
  } catch (error) {
    const described = describeGraphError(error)

    record.status = MAIL_STATUS.FAILED
    record.error = {
      code: described.code,
      message: described.message,
      statusCode: described.statusCode,
      failedAt: new Date(),
    }

    // The outcome must be recorded even if this write fails, so a save failure
    // is logged and swallowed rather than replacing the real cause below.
    await record.save().catch((saveError) => {
      log.error('Could not record a failed send', {
        mailId: record._id.toString(),
        message: saveError.message,
      })
    })

    log.warn('Message send failed', {
      mailId: record._id.toString(),
      code: described.code,
      statusCode: described.statusCode,
      clientRequestId,
    })

    // Re-thrown so the caller is told. `mailId` lets the client link straight to
    // the failed record rather than making the user hunt for it in history.
    //
    // Merged, not replaced: `translateGraphError` puts the Graph error code and
    // request id in `details`, and overwriting them would discard the only
    // values that make the failure traceable in Microsoft's logs.
    if (error instanceof ApiError) {
      error.details = {
        ...(error.details ?? {}),
        mailId: record._id.toString(),
        clientRequestId,
      }
      throw error
    }

    throw ApiError.serviceUnavailable('The message could not be sent.', { cause: error })
  }
}

/**
 * Saves a draft to the mailbox and records it locally.
 *
 * The Graph draft is best-effort: if it fails, the local record is still kept as
 * a draft. Losing a user's composed text because Outlook was briefly unreachable
 * would be the worst possible outcome for a "save draft" button.
 *
 * @param {object} params
 * @param {object} params.auth
 * @param {object} params.payload Validated body from `draftMailSchema`.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function saveDraft({ auth, payload }) {
  const sender = await resolveSender(auth, payload.mailboxId ?? null)
  const clientRequestId = crypto.randomUUID()

  const record = await Mail.create({
    ...buildMailDocument(payload, sender, MAIL_STATUS.DRAFT),
    graphRequestId: clientRequestId,
  })

  // Graph rejects a draft with no recipients *and* no subject on some mailbox
  // configurations, and there is nothing useful to store there anyway.
  const isWorthSyncing = payload.to.length > 0 || payload.subject.trim() !== ''

  if (sender.accountId && isWorthSyncing) {
    try {
      const draft = await createDraftMessage(
        sender.accountId.toString(),
        buildGraphMessage(payload),
        clientRequestId,
      )

      record.graphMessageId = draft.id
      await record.save()
    } catch (error) {
      log.warn('Draft saved locally but not synced to Outlook', {
        mailId: record._id.toString(),
        message: describeGraphError(error).message,
      })
    }
  }

  return record
}

/**
 * Returns one page of the signed-in user's mail history.
 *
 * `userId` is part of every query rather than checked afterwards, so there is no
 * code path on which one user can read another's mail.
 *
 * @param {object} params
 * @param {object} params.auth
 * @param {object} params.query Validated `historyQuerySchema` output.
 * @returns {Promise<{ items: object[], meta: object }>}
 */
export async function listHistory({ auth, query }) {
  // Read straight from the session. Reading history is not a send, so resolving
  // a mailbox for it would be a database round trip to answer a question the
  // session already answers — and would make history unreadable for a
  // workspace with no mailbox, which is exactly when someone wants to read it.
  const userId = requireUserId(auth)
  const { page, limit, status, search } = query

  const filter = { userId }
  if (status) filter.status = status

  if (search) {
    // Escaped before it reaches the regex: an unescaped "(" from a user is a
    // syntax error, and a pattern like "(a+)+" is a denial-of-service vector.
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(safe, 'i')
    filter.$or = [{ subject: pattern }, { 'to.address': pattern }, { text: pattern }]
  }

  const skip = (page - 1) * limit

  // Run together: the count does not depend on the page, and serialising them
  // would double the latency of every history request.
  const [documents, total] = await Promise.all([
    Mail.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Mail.countDocuments(filter),
  ])

  return {
    items: documents.map((document) => document.toSummaryJSON()),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNextPage: skip + documents.length < total,
      hasPreviousPage: page > 1,
    },
  }
}

/**
 * Loads one message belonging to the signed-in user.
 *
 * A record owned by someone else returns 404, not 403. Distinguishing the two
 * would confirm the id exists, which leaks the size and shape of other users'
 * data to anyone willing to enumerate.
 *
 * @param {object} params
 * @param {object} params.auth
 * @param {string} params.id
 * @returns {Promise<import('mongoose').Document>}
 */
export async function getMailById({ auth, id }) {
  const userId = requireUserId(auth)

  const record = await Mail.findOne({ _id: id, userId })

  if (!record) {
    throw ApiError.notFound('No message with that id exists in your history.')
  }

  return record
}

/**
 * Deletes a record from history.
 *
 * For a draft this also removes the copy in Outlook, since the two represent one
 * thing to the user. For a message already sent it does not: the mail has left,
 * and quietly deleting it from Sent Items would destroy the user's own record of
 * something this action did not undo.
 *
 * @param {object} params
 * @param {object} params.auth
 * @param {string} params.id
 * @returns {Promise<{ id: string, removedFromMailbox: boolean }>}
 */
export async function deleteMail({ auth, id }) {
  const userId = requireUserId(auth)

  const record = await Mail.findOne({ _id: id, userId })

  if (!record) {
    throw ApiError.notFound('No message with that id exists in your history.')
  }

  let removedFromMailbox = false

  /**
   * The draft is deleted through the account that created it.
   *
   * Taken from the record rather than from the caller's current default,
   * because with several mailboxes those are routinely different — a draft
   * saved in `sales@…` is not in `enquiry@…`, and asking the wrong mailbox to
   * delete it would 404 at best. The stored id is the only value that names the
   * mailbox the draft actually lives in.
   */
  const accountId = record.outlookAccountId ?? null

  if (record.status === MAIL_STATUS.DRAFT && record.graphMessageId && accountId) {
    try {
      removedFromMailbox = await deleteMailMessage(accountId.toString(), record.graphMessageId)
    } catch (error) {
      // Non-fatal by design: the local record is what the user asked to remove,
      // and leaving it behind because Outlook was unreachable would be worse.
      log.warn('Draft removed locally but not from Outlook', {
        mailId: id,
        message: describeGraphError(error).message,
      })
    }
  }

  await record.deleteOne()

  log.info('Mail record deleted', { mailId: id, removedFromMailbox })

  return { id, removedFromMailbox }
}

/**
 * Aggregates the counters the dashboard displays.
 *
 * Done with a single `$group` in MongoDB rather than four `countDocuments`
 * calls: one round trip instead of four, and every counter necessarily describes
 * the same instant — separate queries could disagree if a send lands between
 * them.
 *
 * @param {import('mongoose').Types.ObjectId} userId
 * @returns {Promise<object>}
 */
export async function getMailStatistics(userId) {
  const [grouped, recent] = await Promise.all([
    Mail.aggregate([
      { $match: { userId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Mail.find({ userId }).sort({ createdAt: -1 }).limit(5),
  ])

  const counts = Object.fromEntries(grouped.map(({ _id, count }) => [_id, count]))

  const sent = counts[MAIL_STATUS.SENT] ?? 0
  const failed = counts[MAIL_STATUS.FAILED] ?? 0
  const pending = counts[MAIL_STATUS.PENDING] ?? 0
  const draft = counts[MAIL_STATUS.DRAFT] ?? 0

  // Drafts are excluded: a saved draft was never an attempt to deliver, so
  // counting it would drag the rate down for doing nothing wrong. Pending is
  // excluded too — its outcome is not yet known.
  const attempted = sent + failed

  return {
    totalSent: sent,
    totalFailed: failed,
    totalPending: pending,
    totalDrafts: draft,
    totalMessages: sent + failed + pending + draft,
    /** Percentage, rounded to one decimal. Null when nothing has been attempted. */
    successRate: attempted === 0 ? null : Math.round((sent / attempted) * 1000) / 10,
    recent: recent.map((document) => document.toSummaryJSON()),
  }
}

/** Limits surfaced to the client so the compose form can enforce them up front. */
export function getMailLimits() {
  return {
    maxRecipients: config.mail.maxRecipients,
    maxAttachments: config.mail.maxAttachments,
    maxAttachmentBytes: config.mail.maxAttachmentBytes,
  }
}

export default {
  buildGraphMessage,
  sendMail,
  saveDraft,
  listHistory,
  getMailById,
  deleteMail,
  getMailStatistics,
  getMailLimits,
  htmlToText,
}
