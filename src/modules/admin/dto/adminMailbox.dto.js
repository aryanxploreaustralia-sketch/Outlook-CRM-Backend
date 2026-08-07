/**
 * Mailbox serialisers for the assignment engine.
 *
 * ## The rule, restated because this is the module where it matters most
 *
 * Every field is written out by name from an allowlist. Nothing spreads a
 * document. `Mailbox` links to the OAuth grant through `sourceAccount`, and the
 * encrypted material lives on `OutlookAccount` and `ProviderToken` — none of
 * which is read here, populated here, or reachable from anything returned here.
 *
 * No access token, no refresh token, no client secret, no MSAL cache, in whole
 * or in part, for any caller.
 */

import { CONNECTION_STATUS, PROVIDER_LABELS } from '../../provider/constants/providerTypes.js'
import { ROLE_LABELS } from '../../../constants/roles.js'
import { USER_STATUS_LABELS, deriveUserStatus } from '../../../constants/userStatus.js'

const id = (value) => (value ? String(value._id ?? value) : null)

/**
 * Mailbox health, in the four words an operator can act on.
 *
 * Derived from recorded state rather than probed: a live provider call per
 * mailbox on every list render would reach into the mailbox engine, which this
 * phase must not touch. The signal is weaker and is labelled as such.
 *
 * `token_expiring` is deliberately **not** derived from a token value — nothing
 * here reads one. It is inferred from a connection that has stopped syncing
 * while still claiming to be connected, which is what an expiring grant looks
 * like from the outside.
 */
export function mailboxHealth(mailbox) {
  const lastSync = mailbox.stats?.lastSuccessfulSyncAt ?? null

  if (mailbox.status === CONNECTION_STATUS.EXPIRED) {
    return { state: 'reconnect_required', detail: 'The authorisation expired. Reconnect to restore access.' }
  }

  if (mailbox.status === CONNECTION_STATUS.ERROR) {
    return {
      state: 'reconnect_required',
      detail: mailbox.statusReason ?? 'The provider rejected this connection.',
    }
  }

  if (mailbox.status !== CONNECTION_STATUS.CONNECTED) {
    return { state: 'disconnected', detail: mailbox.statusReason ?? 'This mailbox is not connected.' }
  }

  if (mailbox.syncEnabled === false) {
    return { state: 'healthy', detail: 'Connected. Reply sync is switched off for this mailbox.' }
  }

  if (!lastSync) {
    return { state: 'healthy', detail: 'Connected. No synchronisation has been recorded yet.' }
  }

  const hoursSince = (Date.now() - new Date(lastSync).getTime()) / 3_600_000

  if (hoursSince > 24) {
    return {
      state: 'token_expiring',
      detail: 'Connected, but nothing has synchronised for over a day. The grant may be lapsing.',
    }
  }

  return { state: 'healthy', detail: 'Connected and syncing normally.' }
}

/** A person reduced to what one row of interface needs. Never a credential. */
export function assigneeDTO(user) {
  if (!user) return null

  const status = deriveUserStatus(user)

  return {
    id: id(user),
    displayName: user.displayName ?? null,
    email: user.email ?? null,
    avatarUrl: user.avatarUrl ?? null,
    role: user.role ?? null,
    roleLabel: ROLE_LABELS[user.role] ?? user.role ?? null,
    status,
    statusLabel: USER_STATUS_LABELS[status] ?? status,
  }
}

/**
 * The compact shape every assignment operation returns.
 *
 * Counts rather than ids: the caller of an assign/unassign wants confirmation of
 * the new state, not a list to re-render a screen it is about to refetch anyway.
 */
export function mailboxAssignmentDTO(mailbox) {
  return {
    id: id(mailbox),
    emailAddress: mailbox.emailAddress ?? null,
    displayName: mailbox.displayName ?? null,
    provider: mailbox.provider ?? null,
    providerLabel: PROVIDER_LABELS[mailbox.provider] ?? mailbox.provider ?? null,
    status: mailbox.status ?? null,
    health: mailboxHealth(mailbox),
    assignedUserCount: (mailbox.assignedUsers ?? []).length,
    defaultUserCount: (mailbox.defaultUsers ?? []).length,
    canSend: mailbox.status === CONNECTION_STATUS.CONNECTED && !mailbox.disconnectedAt,
  }
}

/**
 * A directory row for the admin mailbox table.
 *
 * @param {object} mailbox
 * @param {{ connectedBy?: ?object, metrics?: object }} [extra]
 */
export function mailboxRowDTO(mailbox, extra = {}) {
  return {
    ...mailboxAssignmentDTO(mailbox),

    statusReason: mailbox.statusReason ?? null,
    isDefault: mailbox.isDefault === true,
    syncEnabled: mailbox.syncEnabled !== false,

    connectedBy: assigneeDTO(extra.connectedBy),
    connectedAt: mailbox.connectedAt ?? null,
    lastSyncAt: mailbox.stats?.lastSuccessfulSyncAt ?? null,

    /**
     * Prepared for Phase 14.6, populated only where a caller supplies it.
     *
     * The brief asks for the shape now and the implementation later. Present
     * with nulls rather than absent, so the client can render the columns and
     * the analytics phase fills them in without a contract change — and so
     * "not measured yet" is visibly distinct from "zero".
     */
    metrics: {
      emailsSent: extra.metrics?.emailsSent ?? null,
      replies: extra.metrics?.replies ?? null,
      campaigns: extra.metrics?.campaigns ?? null,
      messagesSynced: mailbox.stats?.totalMessagesSynced ?? 0,
    },
  }
}

/**
 * One mailbox with the people who can use it.
 *
 * @param {object} mailbox
 * @param {{ connectedBy?: ?object, assignees?: object[] }} [extra]
 */
export function mailboxDetailDTO(mailbox, extra = {}) {
  const defaults = new Set((mailbox.defaultUsers ?? []).map(String))

  return {
    ...mailboxRowDTO(mailbox, { connectedBy: extra.connectedBy }),

    /**
     * The connector, listed separately from the assignees.
     *
     * They are not in `assignedUsers` — their access comes from the grant — so
     * the interface has to show them as a distinct kind of member, or "remove"
     * appears next to somebody it cannot remove.
     */
    connector: extra.connectedBy
      ? {
          ...assigneeDTO(extra.connectedBy),
          accessVia: 'connector',
          isDefault: defaults.has(String(mailbox.user)) || mailbox.isDefault === true,
          removable: false,
        }
      : null,

    assignees: (extra.assignees ?? []).map((user) => ({
      ...assigneeDTO(user),
      accessVia: 'assigned',
      isDefault: defaults.has(String(user._id)),
      removable: true,
    })),
  }
}

export default { assigneeDTO, mailboxAssignmentDTO, mailboxDetailDTO, mailboxHealth, mailboxRowDTO }
