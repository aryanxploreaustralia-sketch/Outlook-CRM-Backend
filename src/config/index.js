/**
 * Centralised application configuration.
 *
 * Raw environment variables are validated in `./env.js`; this module shapes them
 * into a structured, domain-oriented object. Consumers read
 * `config.database.uri` rather than `process.env.MONGODB_URI`, which keeps the
 * variable names an implementation detail and makes the settings discoverable.
 */

import path from 'node:path'

import { env, isAuthConfigured, isGoogleAuthConfigured, ROOT_DIR } from './env.js'

/** Package metadata, kept in one place for health responses and log context. */
const APP = {
  name: 'outlook-automation-crm-api',
  version: '1.0.0',
}

export const config = Object.freeze({
  app: Object.freeze({
    name: APP.name,
    version: APP.version,
    env: env.NODE_ENV,
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    isProduction: env.NODE_ENV === 'production',
    rootDir: ROOT_DIR,
  }),

  server: Object.freeze({
    port: env.PORT,
    host: env.HOST,
    apiPrefix: env.API_PREFIX,
    bodyLimit: env.BODY_LIMIT,
    /**
     * Grace period during shutdown, in milliseconds.
     *
     * Applied twice: once draining in-flight background work, once closing the
     * HTTP server and the database.
     */
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  }),

  /**
   * Audit logging.
   *
   * Retention is the only knob. Everything else about the audit system is
   * derived from the event registry, which is code rather than configuration —
   * an operator cannot switch off recording for a category, by design.
   */
  audit: Object.freeze({
    retentionDays: env.AUDIT_RETENTION_DAYS,
    /** `0` means keep forever. Read by the TTL index and shown in the console. */
    retentionEnabled: env.AUDIT_RETENTION_DAYS > 0,
    /** Hard cap on one export. Beyond this the operator narrows the filter. */
    exportLimit: 10_000,
  }),

  database: Object.freeze({
    uri: env.MONGODB_URI,
    options: Object.freeze({
      serverSelectionTimeoutMS: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
      // Fail a queued operation quickly instead of buffering it indefinitely
      // while the connection is down.
      bufferCommands: false,
    }),
    /** Reconnection policy applied by the connection manager. */
    retry: Object.freeze({
      maxAttempts: 5,
      initialDelayMs: 1000,
      maxDelayMs: 30_000,
    }),
  }),

  cors: Object.freeze({
    origins: Object.freeze([...env.CORS_ORIGINS]),
    credentials: true,
  }),

  logging: Object.freeze({
    level: env.LOG_LEVEL,
    dir: path.isAbsolute(env.LOG_DIR) ? env.LOG_DIR : path.join(ROOT_DIR, env.LOG_DIR),
    maxFiles: env.LOG_MAX_FILES,
  }),

  rateLimit: Object.freeze({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
  }),

  client: Object.freeze({
    url: env.FRONTEND_URL,
    postLoginPath: env.POST_LOGIN_REDIRECT_PATH,
    loginPath: env.CLIENT_LOGIN_PATH,
  }),

  microsoft: Object.freeze({
    /**
     * False when Azure credentials are absent. Auth routes check this and
     * return a descriptive 503 rather than throwing an opaque MSAL error.
     */
    enabled: isAuthConfigured,

    /**
     * Whether Microsoft may establish a **CRM identity**.
     *
     * Off by default from Phase 13.2, and this is the fix for the mailbox
     * registry switching between Microsoft accounts.
     *
     * `completeSignIn` upserts a `User` keyed on `(tenantId, microsoftId)`, so
     * every Microsoft account that signed in became *its own CRM user* with its
     * own workspace. The mailbox registry is scoped by user and was reporting
     * that faithfully — signing in as `sadhaliya18@…` showed one registry and
     * `aryan.xplore@…` showed another, because they genuinely were two different
     * CRM users. The list was never wrong; the identity underneath it changed.
     *
     * Google now owns CRM identity. Microsoft authorises mailboxes and nothing
     * else, so minting a CRM user from a Microsoft sign-in is no longer a
     * legitimate operation and is refused here rather than in one route that
     * somebody could later add a second entry point around.
     *
     * `MICROSOFT_ALLOW_SIGN_IN=true` restores the old behaviour for a
     * deployment that has not adopted Google. It should stay off otherwise:
     * turning it on reintroduces the defect described above.
     */
    allowSignIn: env.MICROSOFT_ALLOW_SIGN_IN === true,

    clientId: env.MICROSOFT_CLIENT_ID ?? null,
    clientSecret: env.MICROSOFT_CLIENT_SECRET ?? null,
    tenantId: env.MICROSOFT_TENANT_ID ?? null,
    redirectUri: env.MICROSOFT_REDIRECT_URI ?? null,

    /**
     * Where Microsoft returns after a **mailbox** authorisation.
     *
     * Defaults to the sign-in redirect URI, and that default is the fix for
     * Phase 13.3 rather than a shortcut.
     *
     * `buildAuthorizationUrl` previously always sent `redirectUri`, so every
     * mailbox connect and reconnect was returned to `/api/v1/auth/callback` —
     * the *sign-in* callback. `/api/v1/mailboxes/callback` existed as a route
     * and was never once reached. Before Microsoft sign-in was disabled that
     * meant a mailbox connection silently ran `completeSignIn` and minted a CRM
     * user; afterwards it meant a legitimate reconnect was refused as a legacy
     * login attempt.
     *
     * Sharing the URI is safe because the callback dispatches on the flow's
     * server-recorded `purpose`, not on which path it arrived at. Keeping the
     * default equal to the existing URI means no Entra ID portal change is
     * required for reconnect to work.
     *
     * Set `MICROSOFT_MAILBOX_REDIRECT_URI` to split them, once the dedicated
     * URI is registered in the app registration.
     */
    mailboxRedirectUri:
      env.MICROSOFT_MAILBOX_REDIRECT_URI ?? env.MICROSOFT_REDIRECT_URI ?? null,

    /** Full authority URL MSAL resolves OIDC metadata from. */
    authority: env.MICROSOFT_TENANT_ID
      ? `${env.MICROSOFT_AUTHORITY_HOST.replace(/\/$/, '')}/${env.MICROSOFT_TENANT_ID}`
      : null,

    graph: Object.freeze({
      baseUrl: env.MICROSOFT_GRAPH_BASE_URL.replace(/\/$/, ''),
      apiVersion: env.MICROSOFT_GRAPH_API_VERSION,
    }),

    /** Delegated permissions requested at sign-in. */
    scopes: Object.freeze([...env.MICROSOFT_GRAPH_SCOPES]),

    /**
     * Scopes reserved by the OIDC specification. MSAL manages these itself and
     * they are not valid in a silent-acquisition request, so they are filtered
     * out when refreshing a token.
     */
    reservedScopes: Object.freeze(['openid', 'profile', 'offline_access', 'email']),
  }),

  /**
   * Google sign-in (Phase 13.1).
   *
   * ## Why this is a sibling of `microsoft`, not a part of it
   *
   * The two answer different questions. `config.microsoft` describes a mailbox
   * authorisation — which tenant, which Graph scopes, which redirect. This
   * describes an identity provider and nothing else: there is no Graph URL
   * here, no mail scope, and no token cache, because Google in this product
   * never touches mail.
   *
   * Keeping them as separate, independently-enabled blocks is what allows Phase
   * 13.2 to add connected mailboxes without editing a line of this phase.
   */
  google: Object.freeze({
    /** False when the OAuth client has not been created yet. Routes 503. */
    enabled: isGoogleAuthConfigured,

    clientId: env.GOOGLE_CLIENT_ID ?? null,
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? null,
    callbackUrl: env.GOOGLE_CALLBACK_URL ?? null,

    /** Identity scopes only. No Gmail scope is requested, ever. */
    scopes: Object.freeze([...env.GOOGLE_SCOPES]),

    /** Empty means any Google account with a verified email. */
    allowedDomains: Object.freeze([...env.GOOGLE_ALLOWED_DOMAINS]),

    /**
     * Google's published endpoints.
     *
     * Hard-coded rather than configurable: unlike Entra ID there is no
     * sovereign-cloud variant to point at, and a configurable issuer on an
     * identity provider is a setting whose only use is to weaken it.
     */
    endpoints: Object.freeze({
      authorisation: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    }),

    /** Accepted `iss` values. Google issues both spellings. */
    issuers: Object.freeze(['accounts.google.com', 'https://accounts.google.com']),
  }),

  mail: Object.freeze({
    /** Body ceiling applied to the mail routes only — see env.js for why. */
    bodyLimit: env.MAIL_BODY_LIMIT,
    /** Combined across to + cc + bcc. */
    maxRecipients: env.MAIL_MAX_RECIPIENTS,
    maxAttachments: env.MAIL_MAX_ATTACHMENTS,
    /** Combined decoded size of all attachments on one message. */
    maxAttachmentBytes: env.MAIL_MAX_ATTACHMENT_BYTES,

    /** Page size limits for `GET /mail/history`. */
    history: Object.freeze({
      defaultLimit: 20,
      maxLimit: 100,
    }),
  }),

  /**
   * Everything this service writes to disk.
   *
   * ## Why every path is resolved here
   *
   * The queue's workbooks and the conversation attachments used to resolve
   * against `process.cwd()`, which is not a property of the application — it is
   * a property of how somebody happened to start it. `npm start` sets it to
   * `backend/`; `pm2 start src/server.js` from the repository root sets it to
   * the repository root; a systemd unit without `WorkingDirectory=` sets it to
   * `/`. Each produces a different storage tree, so a queued workbook or a
   * downloaded attachment written before a deployment change becomes
   * unreachable after it — silently, and only discovered when a job resumes and
   * cannot find its file.
   *
   * `ROOT_DIR` is the backend package directory, derived from this module's own
   * location. It is the same wherever the process is started from, which is the
   * property a storage path needs.
   */
  storage: Object.freeze({
    root: path.join(ROOT_DIR, 'storage'),
    /** Uploaded workbooks, held while a background job needs them. */
    workbooks: path.join(ROOT_DIR, 'storage', 'workbooks'),
    /** Attachment bytes fetched from customer replies. */
    attachments: path.join(ROOT_DIR, 'storage', 'attachments'),
    /**
     * Employee documents (Phase 17.1).
     *
     * Its own tree, not a subfolder of attachments: these are personal
     * identity documents with a different retention expectation and a
     * different audience from customer mail, and a backup or purge policy
     * should be able to name one without catching the other.
     */
    documents: path.join(ROOT_DIR, 'storage', 'documents'),
  }),

  /**
   * The morning scheduler.
   *
   * Only the inbox path lives here. Everything an operator changes — whether it
   * runs, at what time, in which zone, how often it retries — is per-workspace
   * state in `SchedulerSetting`, editable from the settings screen without a
   * redeploy.
   */
  scheduler: Object.freeze({
    // Absolute values are honoured so the inbox can be a mounted share; a
    // relative one resolves against the package root like the paths above.
    inboxDir: path.isAbsolute(env.WORKBOOK_INBOX_DIR)
      ? env.WORKBOOK_INBOX_DIR
      : path.join(ROOT_DIR, env.WORKBOOK_INBOX_DIR),
  }),

  session: Object.freeze({
    secret: env.SESSION_SECRET ?? null,
    cookieName: env.SESSION_COOKIE_NAME,
    ttlHours: env.SESSION_TTL_HOURS,
    ttlMs: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    authFlowTtlMs: env.AUTH_FLOW_TTL_MINUTES * 60 * 1000,

    /** Cookie attributes shared by every set/clear call, so they cannot drift. */
    cookieOptions: Object.freeze({
      httpOnly: true,
      // `secure` requires HTTPS; enabling it on plain-HTTP localhost would stop
      // the cookie being stored at all and break local development.
      secure: env.NODE_ENV === 'production',
      // 'lax' still sends the cookie on the top-level redirect back from
      // Microsoft, which 'strict' would block, breaking the callback.
      sameSite: 'lax',
      path: '/',
      signed: true,
    }),
  }),

  security: Object.freeze({
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY ?? null,
  }),
})

export default config
