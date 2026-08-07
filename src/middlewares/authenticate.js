/**
 * Authentication middleware.
 *
 * Two variants, because endpoints have genuinely different needs:
 *
 *  - `requireAuth`  rejects anonymous requests with 401. Use on anything acting
 *                   on a user's behalf.
 *  - `loadSession`  attaches a session when one exists and otherwise continues.
 *                   Use on endpoints that must answer for anonymous callers too,
 *                   such as `/auth/status` — reporting "not signed in" is a
 *                   successful response, not an error.
 *
 * Both populate `req.auth`, so downstream code has one shape to read.
 */

import { resolveSession, touchSession } from '../services/session.service.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * @typedef  {object} AuthContext
 * @property {boolean} isAuthenticated
 * @property {?object} session
 * @property {?object} user
 * @property {?object} outlookAccount
 */

/** The shape used when no valid session is present. */
const ANONYMOUS = Object.freeze({
  isAuthenticated: false,
  session: null,
  user: null,
  outlookAccount: null,
})

/**
 * Attaches session context when available; never rejects.
 *
 * @type {import('express').RequestHandler}
 */
export const loadSession = asyncHandler(async (req, _res, next) => {
  const session = await resolveSession(req)

  if (!session) {
    req.auth = { ...ANONYMOUS }
    next()
    return
  }

  req.auth = {
    isAuthenticated: true,
    session,
    user: session.user,
    outlookAccount: session.outlookAccount ?? null,
  }

  // Fire-and-forget: a failed audit-timestamp write must not fail the request.
  void touchSession(session).catch(() => {})

  next()
})

/**
 * Requires a valid session.
 *
 * Runs `loadSession` itself rather than depending on route ordering, so a route
 * can never be protected by accident or left unprotected by an ordering mistake.
 *
 * @type {import('express').RequestHandler}
 */
export const requireAuth = asyncHandler(async (req, res, next) => {
  if (!req.auth) {
    await new Promise((resolve, reject) => {
      loadSession(req, res, (error) => (error ? reject(error) : resolve()))
    })
  }

  if (!req.auth?.isAuthenticated) {
    // No longer "sign in with Microsoft": from Phase 13.2 the CRM session is
    // established by Google, and naming one provider here would tell a
    // Google-authenticated user to do the wrong thing.
    throw ApiError.unauthorized('You must sign in to access this resource.')
  }

  next()
})

/**
 * Requires a mailbox this workspace can actually send through.
 *
 * ## What changed in Phase 13.2, and why it had to
 *
 * This used to read `req.auth.outlookAccount` — the mailbox attached to the
 * *session* at sign-in. That was correct while Microsoft sign-in was the only
 * way in, because signing in and connecting a mailbox were one act.
 *
 * Google sign-in separated them. A Google session legitimately has
 * `session.outlookAccount === null`, so the old check refused every mail
 * operation for a workspace that might have three healthy mailboxes connected.
 * The session is not where mailbox access lives any more; `Mailbox` is.
 *
 * So the question this asks is now the right one: *does this workspace have a
 * connected mailbox?* — not *did this particular sign-in bring one with it?*
 *
 * This is deliberately still a refusal. Mail security is not weakened here: an
 * operation that genuinely needs Graph still cannot proceed without a usable
 * credential. Only the place the credential is looked up has moved.
 *
 * The resolved mailbox is attached to `req.auth.mailbox` so handlers do not
 * repeat the query.
 *
 * @type {import('express').RequestHandler}
 */
export const requireMailbox = asyncHandler(async (req, _res, next) => {
  if (!req.auth?.isAuthenticated) {
    throw ApiError.unauthorized('You must sign in to access this resource.')
  }

  // Imported lazily to keep this middleware free of a static dependency on the
  // provider module, which imports config and models this file otherwise needs
  // nothing from.
  const mailboxRepo = await import('../modules/provider/repositories/mailbox.repository.js')

  const mailbox = await mailboxRepo.findDefaultMailbox({ user: req.auth.user._id })

  if (!mailbox) {
    /**
     * 403 with an actionable message, not 401.
     *
     * The distinction matters to the client: a 401 makes the web app treat the
     * session as dead and bounce the user to a login page they do not need,
     * which is precisely the bug this phase exists to fix. The CRM session is
     * valid; it is the mailbox that is missing.
     */
    throw ApiError.forbidden(
      'No Microsoft mailbox is connected. Connect a mailbox from Account before sending email.',
      { details: { reason: 'no_mailbox_connected' } },
    )
  }

  req.auth.mailbox = mailbox

  next()
})

/**
 * Previous name for `requireMailbox`.
 *
 * Kept as an alias rather than renamed at every call site, so the three routes
 * that already use it (`/mail/send`, `/mail/draft`, `/templates/test-email`)
 * keep working without being touched by this phase.
 */
export const requireOutlookConnection = requireMailbox

export default { loadSession, requireAuth, requireMailbox, requireOutlookConnection }
