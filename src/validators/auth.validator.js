/**
 * Zod schemas for the authentication endpoints.
 *
 * The OAuth callback is reachable by anyone who can craft a URL, so its query
 * string is untrusted input and is validated before any of it is used. The error
 * handler already converts a `ZodError` into a 422 with field-level detail.
 */

import { z } from 'zod'

/** Printable-ASCII guard shared by the opaque OAuth parameters. */
const opaqueParameter = (label, max) =>
  z
    .string({ message: `${label} is required.` })
    .min(1, `${label} must not be empty.`)
    .max(max, `${label} is longer than expected.`)

/**
 * Query parameters on `GET /auth/callback`.
 *
 * Entra ID sends either `code` + `state` on success, or `error` +
 * `error_description` when the user declines consent or cancels. Both shapes must
 * parse, so `code` is optional here and the controller decides which path ran —
 * treating a user cancellation as a validation failure would produce a confusing
 * 422 for an ordinary "No thanks" click.
 */
export const callbackQuerySchema = z.object({
  // Authorization codes are long; 4096 is comfortably above what Entra ID issues.
  code: opaqueParameter('Authorization code', 4096).optional(),
  state: opaqueParameter('State', 512),
  error: z.string().max(256).optional(),
  error_description: z.string().max(2048).optional(),
})

/**
 * Query parameters on `GET /auth/login`.
 *
 * `returnPath` is sanitised again in the service layer; validating the shape here
 * rejects obvious junk early.
 */
export const loginQuerySchema = z.object({
  returnPath: z.string().max(512).optional(),
})

export default { callbackQuerySchema, loginQuerySchema }
