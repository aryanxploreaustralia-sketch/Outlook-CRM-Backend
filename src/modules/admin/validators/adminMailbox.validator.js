/**
 * Assignment validation.
 *
 * The bodies here name *sets of ids*, which is the shape that needs bounding:
 * an unbounded `userIds` array is an unbounded number of document loads and an
 * unbounded `$in`, from a single request.
 *
 * Everything semantic — is the mailbox connected, is the user suspended, is the
 * mailbox already theirs — belongs to `mailboxAssignment.service`, because those
 * answers require the database and a schema cannot know them.
 */

import { z } from 'zod'

/** A Mongo ObjectId in a path parameter or a body. */
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'That is not a valid id.')

/**
 * A set of ids.
 *
 * Deduplicated in the schema, so the service receives a set and no call site has
 * to remember that a multi-select can submit the same id twice. Capped at fifty:
 * far beyond a real assignment, and firmly short of a request that loads the
 * whole user table.
 */
const idSet = (label) =>
  z
    .array(objectId, { message: `${label} must be a list of ids.` })
    .min(1, `Select at least one ${label.toLowerCase().replace(/s$/, '')}.`)
    .max(50, `No more than 50 ${label.toLowerCase()} at a time.`)
    .transform((ids) => [...new Set(ids)])

/** `POST /admin/mailboxes/:id/assign` and `/unassign` */
export const mailboxAssignSchema = z.object({
  userIds: idSet('Users'),
})

/** `PATCH /admin/mailboxes/:id/default` */
export const mailboxDefaultSchema = z.object({
  userId: objectId,
})

/**
 * `PUT /admin/users/:id/mailboxes`
 *
 * An empty array is valid and meaningful here, unlike the assign body: it is how
 * an administrator removes every assignment a person has. The set semantics make
 * that unambiguous where an add-list plus a remove-list would not.
 */
export const userMailboxesSchema = z.object({
  mailboxIds: z
    .array(objectId, { message: 'Mailboxes must be a list of ids.' })
    .max(50, 'No more than 50 mailboxes at a time.')
    .transform((ids) => [...new Set(ids)]),
})

/** `GET /admin/mailboxes` — the directory filters. */
export const adminMailboxListSchema = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  status: z
    .enum(['connected', 'disconnected', 'expired', 'degraded', 'error', 'not_configured'])
    .optional(),
  provider: z.string().trim().min(1).max(64).optional(),
  health: z.enum(['healthy', 'disconnected', 'token_expiring', 'reconnect_required']).optional(),
  /** Narrows to mailboxes one person can use — the "assigned user" filter. */
  assignedTo: objectId.optional(),
})

export default {
  adminMailboxListSchema,
  mailboxAssignSchema,
  mailboxDefaultSchema,
  objectId,
  userMailboxesSchema,
}
