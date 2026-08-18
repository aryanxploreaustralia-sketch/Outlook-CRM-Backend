/**
 * Follow-up query and body validation.
 *
 * The send body is the one that matters. It carries a list of ids and free text
 * that becomes an email to a customer, so both are bounded: an unbounded id
 * array is a way to email the entire register in one request, and an unbounded
 * body is a way to put anything at all in front of a client under the
 * workspace's own name.
 */

import { z } from 'zod'

import { MARKET_VALUES } from '../constants/leadConstants.js'
import { FOLLOW_UP_STATUS, REPLY_STATUS } from '../constants/followUpConstants.js'

const objectId = z.string().regex(/^[a-f\d]{24}$/i)

/** One value or a comma-separated list, parsed to an array either way. */
const enumList = (values) =>
  z
    .string()
    .transform((raw) => raw.split(',').map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1))
    .optional()

export const followUpQuerySchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  replyStatus: z.enum(Object.values(REPLY_STATUS)).optional(),
  followUpStatus: z.enum(Object.values(FOLLOW_UP_STATUS)).optional(),
  market: enumList(MARKET_VALUES),
  /** "Waiting 5+ days". Capped at a year, past which the filter is meaningless. */
  minWaitingDays: z.coerce.number().int().min(0).max(365).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

/**
 * Body for `POST /leads/follow-up/send`.
 *
 * Capped at 100 leads per request. Sending is sequential and paced by the
 * provider, so a larger batch is a request that runs for minutes and times out
 * halfway — leaving the operator unable to tell who was emailed. A hundred is
 * comfortably within one request and is more than a person reviews in a sitting.
 */
export const followUpSendSchema = z.object({
  leadIds: z.array(objectId).min(1).max(100),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(10_000),
})

export default { followUpQuerySchema, followUpSendSchema }
