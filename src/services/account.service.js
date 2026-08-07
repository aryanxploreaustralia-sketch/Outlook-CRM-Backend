/**
 * Account service.
 *
 * Assembles the account view the dashboard renders: who the user is, which
 * Microsoft mailbox is attached, and what state that attachment is in.
 *
 * Every payload is built from `toPublicJSON()` projections, so the encrypted
 * token cache can never reach a response by accident.
 */

import { ROLE_LABELS } from '../constants/roles.js'
import { ACCOUNT_TYPES, AUTH_PROVIDERS } from '../models/user.model.js'
import {
  getAuthenticationStatus,
  getConnectionStatus,
  probeGraph,
} from './status.service.js'

/** Display labels for account types. */
const ACCOUNT_TYPE_LABELS = Object.freeze({
  [ACCOUNT_TYPES.WORK_OR_SCHOOL]: 'Work or school account',
  [ACCOUNT_TYPES.PERSONAL]: 'Personal Microsoft account',
})

/**
 * Display labels for identity providers.
 *
 * Google was missing, so a Google-authenticated user's profile fell through to
 * the raw enum value and the Account page showed "google" where it meant to say
 * who signed them in.
 */
const PROVIDER_LABELS = Object.freeze({
  [AUTH_PROVIDERS.MICROSOFT]: 'Microsoft',
  [AUTH_PROVIDERS.GOOGLE]: 'Google',
})

/**
 * Builds the account profile payload.
 *
 * ## The Phase 13.2 distinction this payload now makes
 *
 * `identity` is who the person is in the CRM — the Google account they signed
 * in with. `mailboxes` is what the CRM may send and read mail through. They
 * used to be the same object and are now deliberately two, because labelling a
 * Google identity as "your Microsoft connected account" is precisely the
 * confusion the Account page exists to remove.
 *
 * @param {object}  auth              `req.auth`
 * @returns {Promise<object>}
 */
export async function buildAccountProfile(auth) {
  const user = auth.user.toPublicJSON()
  const account = auth.outlookAccount ? auth.outlookAccount.toPublicJSON() : null

  const { listMailboxes } = await import(
    '../modules/provider/repositories/mailbox.repository.js'
  )
  const mailboxes = (await listMailboxes({ user: auth.user._id })).map((mailbox) =>
    mailbox.toPublicJSON(),
  )

  return {
    user: {
      ...user,
      roleLabel: ROLE_LABELS[user.role] ?? user.role,
      providerLabel: PROVIDER_LABELS[user.provider] ?? user.provider,
      accountTypeLabel: ACCOUNT_TYPE_LABELS[user.accountType] ?? user.accountType,
      /** Initials for the avatar fallback, computed server-side so every client agrees. */
      initials: buildInitials(user.displayName, user.email),
    },

    /** Phase 13.2 — the CRM identity, stated as such. Additive. */
    identity: {
      provider: user.provider,
      providerLabel: PROVIDER_LABELS[user.provider] ?? user.provider,
      displayName: user.displayName,
      email: user.email,
      avatarUrl: user.avatarUrl ?? null,
    },

    /** Phase 13.2 — mailbox authorisation, independent of the identity above. */
    mailboxes,
    defaultMailboxId: mailboxes.find((mailbox) => mailbox.isDefault)?.id ?? null,
    canSendMail: mailboxes.some((mailbox) => mailbox.canSend),

    // Retained exactly as before so existing consumers are untouched.
    microsoftAccount: account,
    role: user.role,
    provider: user.provider,
    connection: getConnectionStatus(auth.outlookAccount),
  }
}

/**
 * Derives up to two initials for an avatar placeholder.
 *
 * Falls back through display name → email local part → `?`, so the avatar is
 * never blank regardless of what Graph returned.
 *
 * @param {?string} displayName
 * @param {?string} email
 * @returns {string}
 */
export function buildInitials(displayName, email) {
  const source = (displayName ?? '').trim() || (email ?? '').split('@')[0] || ''

  const words = source
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter(Boolean)

  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()

  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/**
 * Builds the detailed status payload for `/account/status`.
 *
 * @param {object}  auth        `req.auth`
 * @param {object}  [options]
 * @param {boolean} [options.probeGraphApi] Whether to make a live Graph call.
 * @returns {Promise<object>}
 */
export async function buildAccountStatus(auth, { probeGraphApi = true } = {}) {
  const { getBackendStatus, getDatabaseHealth } = await import('./status.service.js')

  const account = auth.outlookAccount ?? null
  const connection = getConnectionStatus(account)

  const graph = probeGraphApi
    ? await probeGraph(account && !account.disconnectedAt ? account._id.toString() : null)
    : {
        status: 'unknown',
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        detail: 'Live probe skipped.',
      }

  return {
    backend: getBackendStatus(),
    database: getDatabaseHealth(),
    graph,
    authentication: getAuthenticationStatus(auth.session),
    connection,
    // Surfaced at the top level as well because the dashboard shows token expiry
    // as its own field, and reaching into `connection.tokenExpiry` from the UI
    // would couple the card to this payload's nesting.
    tokenExpiry: connection.tokenExpiry,
    timestamp: new Date().toISOString(),
  }
}

export default {
  buildAccountProfile,
  buildAccountStatus,
  buildInitials,
}
