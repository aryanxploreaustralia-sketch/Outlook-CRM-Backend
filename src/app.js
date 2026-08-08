/**
 * Express application assembly.
 *
 * This module builds and returns the app but never listens on a port and never
 * connects to a database — those are `server.js`'s job. Keeping it side-effect
 * free means an integration test can import the app and drive it in-process.
 *
 * Middleware order is deliberate and load-bearing:
 *   1. trust proxy      → `req.ip` is correct behind a load balancer
 *   2. requestContext   → assigns the id everything downstream logs
 *   3. helmet           → security headers on every response, including errors
 *   4. cors             → must precede routes to answer preflight requests
 *   5. body parsers     → populate `req.body`
 *   6. cookieParser     → populates `req.signedCookies` for session lookup
 *   7. compression      → wraps the response stream before anything writes
 *   8. httpLogger       → observes the final status via the `finish` event
 *   9. rate limiter     → cheap rejection before routing work happens
 *  10. routes
 *  11. notFoundHandler  → only reached when nothing above matched
 *  12. errorHandler     → must be registered last to catch everything
 */

import compression from 'compression'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'

import { config } from './config/index.js'
import { ERROR_CODES } from './constants/errorCodes.js'
import {
  apiRateLimiter,
  errorHandler,
  httpLogger,
  notFoundHandler,
  requestContext,
} from './middlewares/index.js'
import apiRoutes from './routes/index.js'

/**
 * Builds the CORS options.
 *
 * Requests without an `Origin` header (curl, server-to-server, health probes)
 * are allowed: CORS is a browser protection, and blocking them would break
 * monitoring without improving security.
 */
function buildCorsOptions() {
  const allowed = new Set(config.cors.origins)

  return {
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) {
        callback(null, true)
        return
      }

      const error = new Error(`Origin "${origin}" is not permitted by the CORS policy.`)
      error.code = ERROR_CODES.CORS_REJECTED
      callback(error)
    },
    credentials: config.cors.credentials,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Filename',
      'X-Import-Options',
      'X-Document-Meta'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  }
}

/**
 * Builds the JSON body parser.
 *
 * The mail endpoints carry base64 attachments and need a much larger ceiling
 * than everything else. Raising `BODY_LIMIT` globally to accommodate them would
 * let *any* endpoint buffer megabytes before rejecting it, so the larger limit
 * is scoped to the one path prefix that needs it and the rest of the API keeps
 * rejecting oversized bodies cheaply.
 *
 * Selection happens per request rather than by mounting the parser on the mail
 * router, because a router-level parser would run after the global one has
 * already read the stream and enforced the smaller limit.
 *
 * @returns {import('express').RequestHandler}
 */
function buildJsonParser() {
  const standard = express.json({ limit: config.server.bodyLimit })
  const generous = express.json({ limit: config.mail.bodyLimit })

  const mailPathPrefix = `${config.server.apiPrefix}/v1/mail`

  return (req, res, next) =>
    req.path.startsWith(mailPathPrefix) ? generous(req, res, next) : standard(req, res, next)
}

/**
 * Creates the configured Express application.
 *
 * @returns {import('express').Express}
 */
export function createApp() {
  const app = express()

  // Behind a reverse proxy the client IP arrives in X-Forwarded-For. Trusting
  // one hop keeps `req.ip` accurate for rate limiting and logs. Trusting
  // everything would let a client spoof its own IP, so the value is not `true`.
  app.set('trust proxy', 1)

  // Do not advertise the framework to attackers scanning for known Express CVEs.
  app.disable('x-powered-by')

  app.use(requestContext)
  app.use(helmet())
  app.use(cors(buildCorsOptions()))
  app.use(buildJsonParser())
  app.use(express.urlencoded({ extended: true, limit: config.server.bodyLimit }))

  // Signed cookies carry the session token. The secret is only present once the
  // auth subsystem is configured; without it cookie-parser still runs so
  // `req.cookies` works, but `req.signedCookies` stays empty — which is correct,
  // since no session could have been issued without a secret either.
  app.use(cookieParser(config.session.secret ?? undefined))

  app.use(compression())
  app.use(httpLogger)
  app.use(apiRateLimiter)

  app.use(config.server.apiPrefix, apiRoutes)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

export default createApp
