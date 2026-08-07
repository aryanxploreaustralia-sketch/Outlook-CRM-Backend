/**
 * Session lifecycle.
 *
 * Sessions are opaque random tokens stored hashed in MongoDB. The plaintext
 * exists only inside a signed, HTTP-only cookie, so client-side JavaScript can
 * never read it — which is what keeps an XSS bug from becoming account takeover.
 */

import { config } from '../config/index.js'
import { Session } from '../models/session.model.js'
import { generateOpaqueToken, hashToken } from '../utils/crypto.js'
import { createContextLogger } from '../utils/logger.js'

const log = createContextLogger('session')

/** Extracts request metadata recorded for audit purposes. */
function requestMetadata(req) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  }
}

/**
 * Creates a session and writes its cookie onto the response.
 *
 * @param {object}  params
 * @param {import('express').Request}  params.req
 * @param {import('express').Response} params.res
 * @param {string}  params.userId
 * @param {string}  params.outlookAccountId
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createSession({ req, res, userId, outlookAccountId }) {
  const token = generateOpaqueToken(32)
  const expiresAt = new Date(Date.now() + config.session.ttlMs)

  const session = await Session.create({
    tokenHash: hashToken(token),
    user: userId,
    outlookAccount: outlookAccountId,
    expiresAt,
    ...requestMetadata(req),
  })

  res.cookie(config.session.cookieName, token, {
    ...config.session.cookieOptions,
    // `maxAge` keeps the cookie and the database record expiring together;
    // omitting it would leave a session cookie alive after its record was swept.
    maxAge: config.session.ttlMs,
  })

  log.info('Session created', { sessionId: session._id.toString(), userId })

  return session
}

/**
 * Resolves the session referenced by the request cookie.
 *
 * Returns `null` rather than throwing for every failure mode — absent, forged,
 * expired or orphaned — because callers need to distinguish "no session" from
 * "something broke", and an anonymous request is not an error.
 *
 * @param {import('express').Request} req
 * @returns {Promise<?import('mongoose').Document>}
 */
export async function resolveSession(req) {
  // `signedCookies` is only populated when the signature verifies, so a tampered
  // cookie simply never appears here.
  const token = req.signedCookies?.[config.session.cookieName]

  if (!token || typeof token !== 'string') return null

  const session = await Session.findOne({ tokenHash: hashToken(token) })
    .populate('user')
    .populate('outlookAccount')

  if (!session) return null

  // Expiry is enforced here as well as by the TTL index: the index sweeper runs
  // roughly once a minute, and correctness must not depend on its schedule.
  if (session.expiresAt.getTime() <= Date.now()) {
    await Session.deleteOne({ _id: session._id })
    log.debug('Rejected an expired session', { sessionId: session._id.toString() })
    return null
  }

  // A session whose user was deleted is unusable.
  if (!session.user) {
    await Session.deleteOne({ _id: session._id })
    log.warn('Deleted an orphaned session', { sessionId: session._id.toString() })
    return null
  }

  return session
}

/**
 * Records that a session was used, for idle-timeout reporting later.
 *
 * Throttled to at most one write per five minutes. Updating on every request
 * would add a database write to every authenticated call for information that is
 * only ever read at minute granularity.
 *
 * @param {import('mongoose').Document} session
 */
export async function touchSession(session) {
  const FIVE_MINUTES_MS = 5 * 60 * 1000
  const lastUsed = session.lastUsedAt?.getTime() ?? 0

  if (Date.now() - lastUsed < FIVE_MINUTES_MS) return

  await Session.updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } })
}

/**
 * Deletes a session and clears its cookie.
 *
 * @param {object} params
 * @param {import('express').Response} params.res
 * @param {?import('mongoose').Document} params.session
 */
export async function destroySession({ res, session }) {
  if (session) {
    await Session.deleteOne({ _id: session._id })
    log.info('Session destroyed', { sessionId: session._id.toString() })
  }

  // Cleared with the same attributes it was set with. A mismatch in `path` or
  // `sameSite` leaves the original cookie in place in some browsers.
  res.clearCookie(config.session.cookieName, config.session.cookieOptions)
}

/**
 * Deletes every session belonging to a user.
 *
 * Used when a connection is revoked, so a compromised account cannot remain
 * signed in elsewhere.
 *
 * @param {string} userId
 * @returns {Promise<number>} Number of sessions removed.
 */
export async function destroyAllUserSessions(userId) {
  const { deletedCount } = await Session.deleteMany({ user: userId })

  if (deletedCount > 0) {
    log.info('Destroyed all sessions for user', { userId, count: deletedCount })
  }

  return deletedCount ?? 0
}

export default {
  createSession,
  resolveSession,
  touchSession,
  destroySession,
  destroyAllUserSessions,
}
