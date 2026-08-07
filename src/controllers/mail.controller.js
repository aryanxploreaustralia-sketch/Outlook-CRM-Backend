/**
 * Mail controller.
 *
 * Thin by design, matching the rest of the API: parse and validate HTTP input,
 * delegate to `mail.service`, wrap the result in the standard envelope. No Graph
 * call and no database query appears in this file.
 */

import { HTTP_STATUS } from '../constants/httpStatus.js'
import {
  deleteMail,
  getMailById,
  getMailLimits,
  listHistory,
  saveDraft,
  sendMail,
} from '../services/mail.service.js'
import {
  draftMailSchema,
  historyQuerySchema,
  mailIdParamSchema,
  sendMailSchema,
} from '../validators/mail.validator.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { sendSuccess } from '../utils/ApiResponse.js'

/**
 * POST /api/v1/mail/send
 *
 * Sends a message and returns the persisted record.
 *
 * Responds **201**, not 200: a send always creates a history record, and the
 * client needs its id to link to the result. Note that a Graph failure still
 * creates that record — it is returned inside the error's `details.mailId` — so
 * a failed send is inspectable rather than lost.
 */
export const send = asyncHandler(async (req, res) => {
  const payload = sendMailSchema.parse(req.body)

  const record = await sendMail({ auth: req.auth, payload })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: 'Message sent successfully.',
    data: { mail: record.toPublicJSON() },
  })
})

/**
 * POST /api/v1/mail/draft
 *
 * Saves a draft locally and, when possible, to the user's Outlook drafts.
 *
 * Not in the original four-endpoint spec, but the compose screen's Draft button
 * needs somewhere to post. Overloading `/send` with a "do not actually send"
 * flag would make the most destructive endpoint in the module depend on a
 * boolean being correct, which is the wrong place to put that risk.
 */
export const draft = asyncHandler(async (req, res) => {
  const payload = draftMailSchema.parse(req.body)

  const record = await saveDraft({ auth: req.auth, payload })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: record.graphMessageId
      ? 'Draft saved to your Outlook drafts.'
      : 'Draft saved.',
    data: { mail: record.toPublicJSON() },
  })
})

/**
 * GET /api/v1/mail/history
 *
 * Paginated history for the signed-in user, newest first.
 * Supports `?page`, `?limit`, `?status` and `?search`.
 */
export const history = asyncHandler(async (req, res) => {
  const query = historyQuerySchema.parse(req.query)

  const { items, meta } = await listHistory({ auth: req.auth, query })

  return sendSuccess(res, {
    message: 'Mail history retrieved successfully.',
    data: { items, limits: getMailLimits() },
    meta,
  })
})

/**
 * GET /api/v1/mail/:id
 *
 * One message in full, including the HTML body.
 */
export const getById = asyncHandler(async (req, res) => {
  const { id } = mailIdParamSchema.parse(req.params)

  const record = await getMailById({ auth: req.auth, id })

  return sendSuccess(res, {
    message: 'Message retrieved successfully.',
    data: { mail: record.toPublicJSON() },
  })
})

/**
 * DELETE /api/v1/mail/:id
 *
 * Removes a record from history. A draft is also removed from Outlook; a sent
 * message is not — see `deleteMail` for why.
 */
export const remove = asyncHandler(async (req, res) => {
  const { id } = mailIdParamSchema.parse(req.params)

  const result = await deleteMail({ auth: req.auth, id })

  return sendSuccess(res, {
    message: 'Message deleted successfully.',
    data: result,
  })
})

export default { send, draft, history, getById, remove }
