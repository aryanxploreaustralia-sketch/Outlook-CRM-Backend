/**
 * Response serialisers for the admin module.
 *
 * ## The rule these exist to enforce
 *
 * **Nothing reaches an admin response except by passing through this file.**
 * Every serialiser builds its output field by field from an allowlist; none of
 * them spreads a document. That is what makes the guarantee below checkable by
 * reading one file rather than by auditing every query.
 *
 * The guarantee: no credential material is ever serialised. Not an access
 * token, not a refresh token, not an MSAL cache, not a client secret, not a
 * session token hash — in whole or in part, in any field, for any caller.
 *
 * `Mailbox` is the one that matters most. The document itself holds no token
 * (they live on `OutlookAccount` and `ProviderToken`, linked by
 * `sourceAccount`), and `mailboxAdminDTO` never populates that link. Two
 * independent reasons for the same outcome, which is the point.
 */

import { ADMIN_USER_STATUS, ADMIN_USER_STATUS_LABELS } from '../constants/adminConstants.js'
import { ROLE_LABELS } from '../../../constants/roles.js'
import { PROVIDER_LABELS } from '../../provider/constants/providerTypes.js'

/** Safe id extraction — the value may be an ObjectId, a populated doc, or null. */
const id = (value) => (value ? String(value._id ?? value) : null)

/**
 * Derives the displayed account status from the two flags `User` actually has.
 *
 * There is no "invited" state, and this deliberately does not invent one:
 * invitations need a `Membership` document that does not exist yet, and a status
 * that can never occur is a filter option that never matches.
 */
export function resolveUserStatus(user) {
  if (user.isDeleted === true) return 'deleted'
  if (user.isActive === false) return ADMIN_USER_STATUS.SUSPENDED
  return ADMIN_USER_STATUS.ACTIVE
}

/**
 * A user row for the admin table.
 *
 * `mailboxCount` is supplied by the caller rather than read here, because it
 * comes from an aggregation over `Mailbox` — one grouped query for the whole
 * page instead of one query per row.
 *
 * @param {object} user  A lean `User` document.
 * @param {{ mailboxCount?: number, leadCount?: number }} [extra]
 */
export function userAdminDTO(user, extra = {}) {
  const status = resolveUserStatus(user)

  return {
    id: id(user),
    displayName: user.displayName ?? null,
    email: user.email ?? user.userPrincipalName ?? null,
    /** The identity provider's picture URL. Display only; never a credential. */
    avatarUrl: user.avatarUrl ?? null,
    jobTitle: user.jobTitle ?? null,
    role: user.role ?? null,
    roleLabel: ROLE_LABELS[user.role] ?? user.role ?? null,
    status,
    statusLabel: ADMIN_USER_STATUS_LABELS[status] ?? 'Deleted',
    provider: user.provider ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt ?? null,
    mailboxCount: extra.mailboxCount ?? 0,
    leadCount: extra.leadCount ?? 0,
  }
}

/**
 * A mailbox row for the admin table.
 *
 * ## Health, and why it is derived rather than probed
 *
 * The Phase 14.0 design specifies live probes — a Graph `/me` call per mailbox,
 * token expiry inspection, folder checks. Those are writes to `Mailbox.health`
 * and network calls to Microsoft, and this phase is read-only and must not touch
 * the mailbox engine. So health here is *inferred* from the state the sync
 * engine already records: the connection status, and how long ago the last
 * successful sync was. That is a weaker signal, honestly labelled, and it costs
 * nothing and changes nothing.
 *
 * @param {object} mailbox  A lean `Mailbox` document.
 * @param {{ assignedUserCount?: number, staleAfterMs?: number }} [extra]
 */
export function mailboxAdminDTO(mailbox, extra = {}) {
  const lastSyncAt = mailbox.stats?.lastSuccessfulSyncAt ?? null
  const staleAfterMs = extra.staleAfterMs ?? 6 * 60 * 60 * 1000

  let health = 'healthy'
  let healthDetail = 'Connected and syncing normally.'

  if (mailbox.status === 'error') {
    health = 'offline'
    healthDetail = mailbox.statusReason ?? 'The provider rejected this connection.'
  } else if (mailbox.status === 'disconnected' || mailbox.status === 'not_configured') {
    health = 'unknown'
    healthDetail = mailbox.statusReason ?? 'This mailbox is not connected.'
  } else if (mailbox.status === 'expired') {
    health = 'offline'
    healthDetail = 'The authorisation expired. Reconnect to restore access.'
  } else if (mailbox.syncEnabled === false) {
    health = 'healthy'
    healthDetail = 'Connected. Reply sync is switched off for this mailbox.'
  } else if (!lastSyncAt) {
    health = 'unknown'
    healthDetail = 'Connected, but no successful sync has been recorded yet.'
  } else if (Date.now() - new Date(lastSyncAt).getTime() > staleAfterMs) {
    health = 'warning'
    healthDetail = 'Connected, but the last successful sync is older than expected.'
  }

  return {
    id: id(mailbox),
    emailAddress: mailbox.emailAddress ?? null,
    displayName: mailbox.displayName ?? null,
    provider: mailbox.provider ?? null,
    providerLabel: PROVIDER_LABELS[mailbox.provider] ?? mailbox.provider ?? null,
    status: mailbox.status ?? null,
    statusReason: mailbox.statusReason ?? null,
    isDefault: mailbox.isDefault === true,
    syncEnabled: mailbox.syncEnabled !== false,
    canSend: mailbox.status === 'connected' && !mailbox.disconnectedAt,
    connectedAt: mailbox.connectedAt ?? null,
    lastSyncAt,
    /**
     * How many CRM users may use this mailbox.
     *
     * One, always, until Phase 14.7 adds `assignedUsers`. `Mailbox.user` is a
     * single owner today, so the count is reported rather than fabricated —
     * a column showing a number the schema cannot produce would be a lie the
     * interface tells consistently.
     */
    assignedUserCount: extra.assignedUserCount ?? 1,
    owner: extra.owner ?? null,
    health: { state: health, detail: healthDetail },
    stats: {
      totalMessagesSynced: mailbox.stats?.totalMessagesSynced ?? 0,
      folderCount: mailbox.stats?.folderCount ?? 0,
    },
  }
}

/**
 * One health component.
 *
 * `detail` is required, not optional. "Warning" tells an operator nothing they
 * can act on; "last successful sync was 4 hours ago" tells them where to look.
 */
export function healthComponentDTO({ id: componentId, name, group, state, detail, metrics = [] }) {
  return { id: componentId, name, group, state, detail, metrics }
}

export default { healthComponentDTO, mailboxAdminDTO, resolveUserStatus, userAdminDTO }
