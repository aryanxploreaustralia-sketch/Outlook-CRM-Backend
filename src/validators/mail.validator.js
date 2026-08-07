/**
 * Zod schemas for the mail endpoints.
 *
 * These run before anything reaches Microsoft Graph, which is the point: Graph
 * charges a network round trip to tell you an address is malformed, and its
 * error text ("ErrorInvalidRecipients") is not something a user can act on.
 * Rejecting locally is faster and the message is legible.
 *
 * The error handler turns a `ZodError` into a 422 with field-level detail, so
 * every message here is written to be shown to a person.
 */

import { z } from 'zod'

import { config } from '../config/index.js'
import { MAIL_STATUS_VALUES } from '../constants/mailStatus.js'

/**
 * Recipients accept two shapes.
 *
 * A bare string is what a client naturally sends and what the compose form
 * produces; the object form carries a display name. Normalising both to the
 * object shape here means the service layer only ever handles one.
 */
const recipientSchema = z.union([
  z
    .string()
    .trim()
    .toLowerCase()
    .email('“{input}” is not a valid email address.')
    .transform((address) => ({ address, name: null })),

  z.object({
    address: z.string().trim().toLowerCase().email('“{input}” is not a valid email address.'),
    name: z.string().trim().max(256).optional().nullable().default(null),
  }),
])

/**
 * A recipient list.
 *
 * Duplicates are removed rather than rejected: the same address arriving twice
 * is a copy-paste slip, not something worth failing a send over, and Graph would
 * deliver two copies.
 */
const recipientList = (label, { required = false } = {}) => {
  let schema = z
    .array(recipientSchema)
    .max(
      config.mail.maxRecipients,
      `${label} cannot exceed ${config.mail.maxRecipients} recipients.`,
    )
    .transform((entries) => {
      const seen = new Map()
      for (const entry of entries) {
        // First occurrence wins, so a named entry is not replaced by a bare one.
        if (!seen.has(entry.address)) seen.set(entry.address, entry)
      }
      return [...seen.values()]
    })

  if (required) {
    schema = schema.refine(
      (entries) => entries.length > 0,
      `${label} must contain at least one recipient.`,
    )
  }

  return schema
}

/** Base64 with optional padding. Rejects the data-URI prefix a browser may include. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Decoded byte length of a base64 string, computed without allocating a Buffer.
 *
 * Matters because the check runs before the payload is accepted: decoding a
 * 50 MB string to discover it is too large would do exactly the work the limit
 * exists to prevent.
 *
 * @param {string} value
 * @returns {number}
 */
function base64ByteLength(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.floor((value.length * 3) / 4) - padding
}

const attachmentSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Each attachment needs a file name.')
    .max(255, 'Attachment file names cannot exceed 255 characters.')
    // A name containing a path separator can escape a directory if anything
    // downstream ever writes it to disk. Stripped rather than rejected, since
    // some browsers include the full path on older platforms.
    .transform((name) => name.replace(/^.*[\\/]/, '')),

  contentType: z
    .string()
    .trim()
    .max(255)
    .optional()
    .default('application/octet-stream')
    .transform((value) => (value === '' ? 'application/octet-stream' : value)),

  contentBytes: z
    .string()
    .min(1, 'Attachment content is empty.')
    // A browser's FileReader yields `data:<mime>;base64,<payload>`. Accepting
    // and stripping the prefix is kinder than making every client remember to.
    .transform((value) => value.replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, ''))
    .refine((value) => BASE64_PATTERN.test(value), 'Attachment content must be base64-encoded.'),
})

/**
 * The body shared by sending and drafting.
 *
 * Drafts relax it: a half-written draft with no recipients and no subject is a
 * completely normal thing to save, so `sendMailSchema` adds those requirements
 * rather than the base carrying them.
 */
const mailBodyShape = {
  // Optional in the base shape so a draft with no recipient yet is valid.
  // `sendMailSchema` replaces this with the required variant.
  to: recipientList('“To”').optional().default([]),
  cc: recipientList('“Cc”').optional().default([]),
  bcc: recipientList('“Bcc”').optional().default([]),

  subject: z
    .string()
    .trim()
    .max(998, 'The subject line cannot exceed 998 characters.')
    .optional()
    .default(''),

  /** HTML body. Sanitisation is Graph's and Outlook's responsibility, not ours. */
  html: z.string().max(1_000_000, 'The message body is too large.').optional().default(''),

  /** Optional plain-text alternative; derived from `html` when omitted. */
  text: z.string().max(1_000_000, 'The message body is too large.').optional().default(''),

  attachments: z
    .array(attachmentSchema)
    .max(
      config.mail.maxAttachments,
      `A message cannot carry more than ${config.mail.maxAttachments} attachments.`,
    )
    .optional()
    .default([]),

  /**
   * Phase 11 — provenance when the composer started from a template.
   *
   * All optional, so every existing client keeps working unchanged. They record
   * where the message came from; `subject` and `html` above remain the sole
   * record of what was actually sent, because the user is free to edit after
   * applying a template.
   */
  templateId: z
    .string()
    .regex(/^[0-9a-f]{24}$/i, 'That is not a valid template id.')
    .optional(),
  templateName: z.string().trim().max(200).optional(),
  templateVersion: z.coerce.number().int().min(1).optional(),

  /**
   * Phase 13.2 — which connected mailbox to send from.
   *
   * Optional, so every existing client continues to send from the workspace
   * default exactly as it did. Validated only for *shape* here; whether the id
   * belongs to the caller is decided in `resolveSender`, against the database
   * and scoped by user. A format check is not an ownership check, and treating
   * it as one would be the classic mistake.
   */
  mailboxId: z
    .string()
    .regex(/^[0-9a-f]{24}$/i, 'That is not a valid mailbox id.')
    .optional(),
}

/** Rejects an attachment set whose combined decoded size exceeds the cap. */
function enforceAttachmentBudget(data, ctx) {
  const total = data.attachments.reduce(
    (sum, file) => sum + base64ByteLength(file.contentBytes),
    0,
  )

  if (total > config.mail.maxAttachmentBytes) {
    const limitMb = (config.mail.maxAttachmentBytes / (1024 * 1024)).toFixed(1)
    const actualMb = (total / (1024 * 1024)).toFixed(1)

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['attachments'],
      message:
        `Attachments total ${actualMb} MB, which exceeds the ${limitMb} MB limit. ` +
        'Microsoft Graph rejects messages larger than this. Send fewer or smaller files, ' +
        'or share a link instead.',
    })
  }
}

/**
 * `POST /mail/send`.
 *
 * A message with neither a body nor an attachment is almost always a mis-click,
 * and it costs a Graph call to discover that. An empty subject is allowed —
 * Outlook permits it and warns the user, which is the established convention.
 */
export const sendMailSchema = z
  .object({
    ...mailBodyShape,
    to: recipientList('“To”', { required: true }),
  })
  .superRefine((data, ctx) => {
    enforceAttachmentBudget(data, ctx)

    const hasBody = data.html.trim() !== '' || data.text.trim() !== ''
    if (!hasBody && data.attachments.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['html'],
        message: 'The message needs a body or at least one attachment.',
      })
    }
  })

/** `POST /mail/draft` — every field optional, because a draft is by definition incomplete. */
export const draftMailSchema = z.object(mailBodyShape).superRefine(enforceAttachmentBudget)

/** `GET /mail/history` query parameters. */
export const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),

  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(
      config.mail.history.maxLimit,
      `“limit” cannot exceed ${config.mail.history.maxLimit}.`,
    )
    .optional()
    .default(config.mail.history.defaultLimit),

  status: z
    .enum(MAIL_STATUS_VALUES, {
      message: `“status” must be one of: ${MAIL_STATUS_VALUES.join(', ')}.`,
    })
    .optional(),

  /** Case-insensitive substring match against subject and recipient addresses. */
  search: z.string().trim().max(256).optional(),
})

/** Route parameter shared by the detail and delete endpoints. */
export const mailIdParamSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{24}$/i, 'That is not a valid message id.'),
})

export default {
  sendMailSchema,
  draftMailSchema,
  historyQuerySchema,
  mailIdParamSchema,
  base64ByteLength,
}

export { base64ByteLength }
