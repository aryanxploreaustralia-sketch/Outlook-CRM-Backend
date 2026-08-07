/**
 * Environment loading and validation.
 *
 * `.env` is read once, here, and validated against a schema. Every other module
 * imports the frozen `config` object from `./index.js` and never touches
 * `process.env` directly.
 *
 * The payoff is fail-fast behaviour: a typo in `MONGODB_URI` or a non-numeric
 * `PORT` stops the process at boot with a precise message, instead of surfacing
 * as a confusing runtime failure on the first request in production.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'
import { z } from 'zod'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path to the backend package root (two levels up from src/config). */
export const ROOT_DIR = path.resolve(currentDir, '..', '..')

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true })

/** Splits a comma-separated list into a clean array of trimmed, non-empty values. */
const csvToArray = (value) =>
  String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

/** Canonical GUID shape, used to tell an Azure identifier from a secret value. */
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Treats an empty or whitespace-only variable as absent. */
const optionalString = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' ? undefined : value))

/**
 * Azure credentials that signal intent to enable authentication.
 *
 * Only these three are treated as the "is Azure configured?" signal.
 * `MICROSOFT_REDIRECT_URI` is deliberately excluded because it has a sensible
 * default, so its presence says nothing about whether an app registration
 * exists — including it would make the API refuse to boot purely because the
 * default was left in place.
 */
const MICROSOFT_CREDENTIAL_FIELDS = [
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
]

/**
 * Secrets authentication cannot operate without.
 *
 * These are *required once Azure is configured* but are not themselves a signal
 * of intent: it is perfectly reasonable to generate them ahead of time, and
 * doing so must not force the whole Azure configuration to be present.
 */
const AUTH_SECRET_FIELDS = ['SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY']

/** Everything that must be present for the auth subsystem to run. */
const ALL_AUTH_FIELDS = [
  ...MICROSOFT_CREDENTIAL_FIELDS,
  'MICROSOFT_REDIRECT_URI',
  ...AUTH_SECRET_FIELDS,
]

/**
 * Google sign-in credentials (Phase 13.1).
 *
 * A separate group from the Microsoft one, and deliberately never merged with
 * it. Google establishes **who a CRM user is**; Microsoft authorises **a
 * mailbox**. They are configured independently, fail independently, and one
 * being absent says nothing about the other.
 *
 * Unlike the Microsoft group these are **not** required in production. Google
 * sign-in is additive: a deployment that has not yet created its OAuth client
 * must still boot and must still be able to sign in the way it does today. The
 * routes report a descriptive 503 instead, exactly as the Microsoft routes do
 * when Azure is unconfigured.
 */
const GOOGLE_CREDENTIAL_FIELDS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL']

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    PORT: z.coerce.number().int().min(1).max(65535).default(5000),
    HOST: z.string().min(1).default('localhost'),
    API_PREFIX: z
      .string()
      .startsWith('/', 'API_PREFIX must begin with a forward slash, e.g. "/api".')
      .default('/api'),

    MONGODB_URI: z
      .string()
      .min(1)
      .refine(
        (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
        'MONGODB_URI must start with "mongodb://" or "mongodb+srv://".',
      ),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(10),

    CORS_ORIGINS: z.string().default('http://localhost:5173').transform(csvToArray),

    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
    LOG_DIR: z.string().min(1).default('logs'),
    LOG_MAX_FILES: z.string().min(1).default('14d'),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

    BODY_LIMIT: z.string().min(1).default('1mb'),

    /**
     * How long a shutdown waits, in milliseconds.
     *
     * Spent twice: first letting an in-flight background run finish, then
     * closing the HTTP server and the database.
     *
     * The default is the value this was hardcoded to before it became
     * configurable, so nothing changes by upgrading. Raise it above your
     * longest morning run — a workbook pacing 500 introductions takes about
     * seventeen minutes — if you want a restart to wait for that run rather
     * than requeue it.
     */
    SHUTDOWN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(60 * 60 * 1000)
      .default(10_000),

    /**
     * How long audit entries are kept, in days.
     *
     * 365 by default: a year is the shortest window that answers "what changed
     * before the last annual review", which is the question an audit log is
     * usually opened for.
     *
     * Enforced by a TTL index, so expiry is MongoDB's background job rather
     * than a sweep this application has to schedule and monitor. Raising it
     * takes effect immediately; lowering it deletes on the next TTL pass, which
     * is why the console shows the value and there is no UI to change it.
     *
     * `0` disables expiry entirely — for a deployment under a legal hold, where
     * automatic deletion is the wrong default.
     */
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(365),

    // --- Web client -------------------------------------------------------
    // Where the OAuth callback sends the browser once sign-in completes.
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    POST_LOGIN_REDIRECT_PATH: z.string().startsWith('/').default('/dashboard'),
    /**
     * Public sign-in page. Sign-in *failures* redirect here rather than to the
     * post-login path, because that path is behind a route guard: an
     * unauthenticated browser would be bounced again and the error message lost.
     */
    CLIENT_LOGIN_PATH: z.string().startsWith('/').default('/login'),

    // --- Microsoft identity platform --------------------------------------
    // Optional as a group in development so the API boots before Azure is set
    // up; the cross-field rules below enforce all-or-nothing and require them
    // in production.
    MICROSOFT_CLIENT_ID: optionalString(),
    MICROSOFT_CLIENT_SECRET: optionalString(),
    MICROSOFT_TENANT_ID: optionalString(),
    MICROSOFT_REDIRECT_URI: optionalString(),

    /**
     * Optional dedicated redirect URI for mailbox authorisation.
     *
     * Omit it and mailbox flows share `MICROSOFT_REDIRECT_URI`, which needs no
     * Entra ID change. Set it only after registering the dedicated URI there.
     */
    MICROSOFT_MAILBOX_REDIRECT_URI: optionalString(),

    /**
     * Whether Microsoft may establish a CRM identity. Off by default.
     *
     * See `config.microsoft.allowSignIn` for why. Parsed explicitly against the
     * string `'true'` rather than with `z.coerce.boolean()`, which coerces by
     * JavaScript truthiness — under that rule `MICROSOFT_ALLOW_SIGN_IN=false`
     * is a non-empty string and evaluates to **true**, silently re-enabling the
     * exact behaviour this flag exists to keep switched off.
     */
    MICROSOFT_ALLOW_SIGN_IN: z
      .string()
      .optional()
      .transform((value) => value?.trim().toLowerCase() === 'true'),

    MICROSOFT_AUTHORITY_HOST: z.string().url().default('https://login.microsoftonline.com'),
    MICROSOFT_GRAPH_BASE_URL: z.string().url().default('https://graph.microsoft.com'),
    MICROSOFT_GRAPH_API_VERSION: z.enum(['v1.0', 'beta']).default('v1.0'),

    /**
     * Delegated permissions requested at sign-in.
     *
     * `openid` identifies the user and `offline_access` is what causes Entra ID
     * to issue a refresh token — without it, access expires in about an hour
     * with no way to renew it silently.
     */
    MICROSOFT_GRAPH_SCOPES: z
      .string()
      .default('openid,offline_access,User.Read,Mail.Send,Mail.Read,Mail.ReadWrite')
      .transform(csvToArray),

    // --- Mail engine -------------------------------------------------------
    /**
     * Body ceiling for the mail endpoints only.
     *
     * Attachments travel as base64, which inflates them by roughly a third, so
     * the global `BODY_LIMIT` (1mb) is far too small. It is kept separate rather
     * than raised globally so every other endpoint still rejects an oversized
     * body cheaply, before it is buffered.
     */
    MAIL_BODY_LIMIT: z.string().min(1).default('8mb'),

    MAIL_MAX_RECIPIENTS: z.coerce.number().int().positive().max(500).default(100),
    MAIL_MAX_ATTACHMENTS: z.coerce.number().int().min(0).max(50).default(10),

    /**
     * Ceiling on the combined *decoded* size of all attachments.
     *
     * `POST /me/sendMail` rejects any request over 4 MB, and that budget covers
     * the body and headers too. 3 MB leaves headroom, and keeping the check here
     * means the user gets a clear message instead of an opaque Graph error.
     * Larger files need an upload session against a draft, which this phase does
     * not implement.
     */
    MAIL_MAX_ATTACHMENT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(3 * 1024 * 1024),

    // --- Morning scheduler (Phase H3) --------------------------------------
    /**
     * Where the daily export is dropped for the scheduler to find.
     *
     * Deployment configuration rather than a settings field, deliberately: a
     * server path arriving in a request body is a path a caller can choose, and
     * the scheduler reads whatever it finds there and emails the people inside
     * it. Relative values resolve against the backend package root.
     *
     * The default sits beside the queue's own storage so a deployment that
     * already persists `backend/storage` keeps the inbox across restarts
     * without any extra configuration.
     */
    WORKBOOK_INBOX_DIR: z.string().min(1).default('storage/workbooks/inbox'),

    // --- Google sign-in (Phase 13.1) ---------------------------------------
    //
    // Identity only. Google is never used to send, read or sync mail; that
    // remains entirely the Microsoft provider's job.
    GOOGLE_CLIENT_ID: optionalString(),
    GOOGLE_CLIENT_SECRET: optionalString(),
    GOOGLE_CALLBACK_URL: optionalString(),

    /**
     * Optional Workspace restriction, as a comma-separated domain list.
     *
     * Empty means any Google account with a verified email may sign in. Setting
     * it to `yourcompany.com` limits the CRM to that Workspace, which is what a
     * business deployment normally wants — and it is enforced against the ID
     * token's `hd` claim and the verified email domain, not against anything
     * the browser supplied.
     */
    GOOGLE_ALLOWED_DOMAINS: z.string().default('').transform(csvToArray),

    /** Scopes requested at Google sign-in. Identity only — deliberately minimal. */
    GOOGLE_SCOPES: z.string().default('openid,email,profile').transform(csvToArray),

    // --- Sessions and token storage ---------------------------------------
    SESSION_SECRET: optionalString(),
    SESSION_COOKIE_NAME: z.string().min(1).default('oac.sid'),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168), // 7 days
    /** OAuth flows abandoned mid-way are swept after this long. */
    AUTH_FLOW_TTL_MINUTES: z.coerce.number().int().positive().default(10),

    TOKEN_ENCRYPTION_KEY: optionalString(),
  })
  .superRefine((data, ctx) => {
    const isProduction = data.NODE_ENV === 'production'

    // Intent is signalled by the Azure credentials alone. Setting any one of the
    // three means an app registration is being wired up, so the rest must follow.
    const anyCredentialSet = MICROSOFT_CREDENTIAL_FIELDS.some((field) => Boolean(data[field]))
    const authRequired = isProduction || anyCredentialSet

    if (authRequired) {
      // Partial configuration is always a mistake — it produces an auth flow
      // that fails only once a user clicks "sign in", the worst time to find out.
      for (const field of ALL_AUTH_FIELDS) {
        if (!data[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: isProduction
              ? `${field} is required when NODE_ENV=production.`
              : `${field} is required because Microsoft credentials are partially configured. ` +
                'Complete the group, or clear MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET ' +
                'and MICROSOFT_TENANT_ID to run without authentication.',
          })
        }
      }
    }

    /**
     * Google is all-or-nothing, but never mandatory.
     *
     * The same partial-configuration rule the Microsoft group uses, and for the
     * same reason: a half-filled OAuth client produces a sign-in that only
     * fails once somebody clicks the button. It is deliberately *not* tied to
     * `NODE_ENV=production` — a deployment that has not created its Google
     * client yet must still boot and must still sign users in the way it does
     * today.
     */
    const anyGoogleSet = GOOGLE_CREDENTIAL_FIELDS.some((field) => Boolean(data[field]))

    if (anyGoogleSet) {
      for (const field of GOOGLE_CREDENTIAL_FIELDS) {
        if (!data[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message:
              `${field} is required because Google sign-in is partially configured. ` +
              'Complete the group, or clear GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ' +
              'GOOGLE_CALLBACK_URL to run without Google sign-in.',
          })
        }
      }

      // Google applies the same transport rule Entra ID does, and enforcing it
      // here turns a redirect-mismatch at the consent screen into a boot error
      // naming the variable.
      if (data.GOOGLE_CALLBACK_URL) {
        let parsed
        try {
          parsed = new URL(data.GOOGLE_CALLBACK_URL)
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['GOOGLE_CALLBACK_URL'],
            message: 'GOOGLE_CALLBACK_URL must be an absolute URL.',
          })
          parsed = null
        }

        if (parsed) {
          const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
          if (parsed.protocol !== 'https:' && !isLoopback) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['GOOGLE_CALLBACK_URL'],
              message:
                'GOOGLE_CALLBACK_URL must use HTTPS unless it points at localhost. ' +
                'Google rejects a non-HTTPS redirect URI for any other host.',
            })
          }
        }
      }
    }

    // Format checks below apply whenever a value is present, configured or not:
    // a malformed secret is worth reporting even while auth is disabled.

    if (data.SESSION_SECRET && data.SESSION_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_SECRET'],
        message:
          'SESSION_SECRET must be at least 32 characters. Generate one with: npm run generate:secrets',
      })
    }

    if (data.TOKEN_ENCRYPTION_KEY) {
      const decoded = Buffer.from(data.TOKEN_ENCRYPTION_KEY, 'base64')
      if (decoded.length !== 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['TOKEN_ENCRYPTION_KEY'],
          message:
            'TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key ' +
            `(decoded to ${decoded.length} bytes). Generate one with: npm run generate:secrets`,
        })
      }
    }

    /**
     * Catches the single most common Azure copy-paste mistake.
     *
     * The "Client secrets" blade shows two columns, **Value** and **Secret ID**.
     * The Secret ID is a GUID and sits next to the value, so it is frequently
     * copied instead. Entra ID only rejects it at the token-exchange step, as
     * `AADSTS7000215: Invalid client secret provided` — after the user has
     * already signed in and consented, which makes it look like a callback bug
     * rather than a configuration one. A real secret value is never a GUID.
     */
    if (data.MICROSOFT_CLIENT_SECRET && GUID_PATTERN.test(data.MICROSOFT_CLIENT_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MICROSOFT_CLIENT_SECRET'],
        message:
          'MICROSOFT_CLIENT_SECRET looks like a Secret ID (a GUID), not a secret Value. ' +
          'In the Azure Portal open your app registration → Certificates & secrets → ' +
          'Client secrets and copy the "Value" column, not "Secret ID". The value is ' +
          'only shown once, immediately after the secret is created.',
      })
    }

    if (data.MICROSOFT_REDIRECT_URI) {
      let parsed
      try {
        parsed = new URL(data.MICROSOFT_REDIRECT_URI)
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MICROSOFT_REDIRECT_URI'],
          message: 'MICROSOFT_REDIRECT_URI must be an absolute URL.',
        })
        return
      }

      // Entra ID permits plain HTTP only for localhost loopback addresses.
      const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      if (parsed.protocol !== 'https:' && !isLoopback) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MICROSOFT_REDIRECT_URI'],
          message:
            'MICROSOFT_REDIRECT_URI must use HTTPS unless it points at localhost. ' +
            'Microsoft Entra ID rejects non-HTTPS redirect URIs for any other host.',
        })
      }
    }
  })

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')

  // The logger itself depends on config, so this one message must use console.
  // eslint-disable-next-line no-console
  console.error(
    `\nInvalid backend environment configuration:\n${details}\n\n` +
      'Check backend/.env against backend/.env.example.\n',
  )
  process.exit(1)
}

export const env = Object.freeze(parsed.data)

/**
 * True only when every value the authentication subsystem needs is present.
 *
 * The auth routes read this to return a descriptive 503 rather than throwing an
 * opaque MSAL error when Azure has not been configured yet.
 */
export const isAuthConfigured = ALL_AUTH_FIELDS.every((field) => Boolean(env[field]))

/**
 * True only when Google sign-in can actually run.
 *
 * `SESSION_SECRET` is included because Google sign-in ends by issuing the
 * application's ordinary session cookie, and that cookie is signed. Without the
 * secret the flow would complete at Google and then silently fail to hold a
 * session — the worst possible place to discover a missing variable.
 *
 * `TOKEN_ENCRYPTION_KEY` is deliberately **not** required: nothing in the
 * Google flow is stored encrypted, because nothing in it is a long-lived
 * credential. Google's tokens are used once, inside the callback, to establish
 * identity and are then discarded.
 */
export const isGoogleAuthConfigured =
  GOOGLE_CREDENTIAL_FIELDS.every((field) => Boolean(env[field])) && Boolean(env.SESSION_SECRET)

export default env
