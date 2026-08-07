/**
 * Directory serialisers.
 *
 * Same rule as `admin.dto.js`: every field is written out by name from an
 * allowlist, never spread from a document. `User` holds no credential — there
 * are no passwords in this system and tokens live on other collections — but
 * the discipline is what keeps that true when somebody adds a field later.
 *
 * `tokenHash` on `Session` is the one credential-shaped value anywhere near this
 * module, and nothing here reads a session document; the repository projects
 * only `lastUsedAt`, `ipAddress` and `userAgent`.
 */

import { ROLE_LABELS } from '../../../constants/roles.js'
import { permissionListForRole } from '../../../constants/roleMatrix.js'
import { USER_STATUS_LABELS, deriveUserStatus } from '../../../constants/userStatus.js'

const id = (value) => (value ? String(value._id ?? value) : null)

/** A person reduced to what one line of interface needs. */
function actorRef(user) {
  if (!user) return null

  return {
    id: id(user),
    displayName: user.displayName ?? null,
    email: user.email ?? null,
  }
}

/**
 * A directory row.
 *
 * @param {object} user  A lean `User` document.
 * @param {{ mailboxes?: { total: number, connected: number },
 *           activity?: { lastActivityAt?: Date, activeSessions?: number } }} [extra]
 */
export function userDirectoryDTO(user, extra = {}) {
  const status = deriveUserStatus(user)

  return {
    id: id(user),

    /**
     * An invited account has a name but no avatar and no principal name — the
     * identity provider has not been involved yet. Falling back to the address
     * keeps the column meaningful rather than rendering a lone dash.
     */
    displayName: user.displayName ?? null,
    email: user.email ?? user.userPrincipalName ?? null,
    avatarUrl: user.avatarUrl ?? null,
    jobTitle: user.jobTitle ?? null,

    role: user.role ?? null,
    roleLabel: ROLE_LABELS[user.role] ?? user.role ?? null,

    status,
    statusLabel: USER_STATUS_LABELS[status] ?? status,

    provider: user.provider ?? null,

    /**
     * Which providers can sign this person in, and when each last did.
     *
     * Derived from whether the identifier is present rather than stored as a
     * flag — a boolean beside the id would be a second copy of the same fact,
     * able to disagree with it.
     *
     * `linked` is the case the Phase 14.8B brief names: one CRM account reached
     * through both Google and Microsoft. Never two accounts.
     */
    identities: {
      google: {
        linked: Boolean(user.googleId),
        lastLoginAt: user.lastGoogleLoginAt ?? null,
      },
      microsoft: {
        linked: Boolean(user.microsoftId),
        lastLoginAt: user.lastMicrosoftLoginAt ?? null,
      },
      linked: Boolean(user.googleId) && Boolean(user.microsoftId),
      establishedBy: user.provider ?? null,
    },

    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt ?? null,

    /** Session-derived, so null once every session has expired. See the repository. */
    lastActivityAt: extra.activity?.lastActivityAt ?? null,
    activeSessions: extra.activity?.activeSessions ?? 0,

    mailboxes: {
      total: extra.mailboxes?.total ?? 0,
      connected: extra.mailboxes?.connected ?? 0,
    },

    invitedAt: user.invitedAt ?? null,
    statusChangedAt: user.statusChangedAt ?? null,

    /**
     * Which verbs the directory should offer for this row.
     *
     * Derived server-side from the same state machine the write endpoints
     * enforce, so a button can never be offered for a transition the server
     * would refuse. This is presentation guidance, not authorisation — the
     * server checks again regardless of what the client chose to render.
     */
    availableActions: {
      activate: status === 'invited' || status === 'suspended',
      suspend: status === 'active' || status === 'invited',
    },
  }
}

/**
 * The profile drawer: everything the row has, plus provenance and volume.
 *
 * @param {object} user
 * @param {{ activity?: object, mailboxes?: object, invitedBy?: ?object,
 *           statusChangedBy?: ?object, viewerId?: ?string }} [extra]
 */
export function userProfileDTO(user, extra = {}) {
  const base = userDirectoryDTO(user, {
    mailboxes: extra.mailboxes,
    activity: extra.activity,
  })

  return {
    ...base,

    userPrincipalName: user.userPrincipalName ?? null,

    /**
     * What this account's role grants.
     *
     * Resolved from the same matrix the middleware enforces, so the profile
     * cannot describe an access level the server would not honour. Sent as the
     * plain permission strings; the client pairs them with the labels and
     * groups it already received from `/admin/me/permissions`.
     */
    permissions: permissionListForRole(user.role),

    /**
     * Whether the caller is looking at themselves.
     *
     * Only changes a heading — "My permissions" rather than "Permissions" — but
     * that is the difference between a debugging aid somebody stumbles on and
     * one they have to be told exists.
     */
    isSelf: extra.viewerId ? String(user._id) === String(extra.viewerId) : false,

    invitation: {
      invitedAt: user.invitedAt ?? null,
      invitedBy: actorRef(extra.invitedBy),
      notes: user.inviteNotes ?? null,
    },

    lastStatusChange: {
      at: user.statusChangedAt ?? null,
      by: actorRef(extra.statusChangedBy),
    },

    /**
     * How much of the business this account touches.
     *
     * Counts, never records. "Does anything depend on this person" is a question
     * about volume, and returning the rows would make the profile a second leads
     * screen — and would put customer data behind a directory permission.
     */
    activity: {
      leads: extra.activity?.leads ?? 0,
      campaigns: extra.activity?.campaigns ?? 0,
      conversations: extra.activity?.conversations ?? 0,
      mailboxes: extra.activity?.mailboxes ?? 0,
      activeSessions: extra.activity?.activeSessions ?? 0,
      lastActivityAt: extra.activity?.lastActivityAt ?? null,
      lastIp: extra.activity?.lastIp ?? null,
    },
  }
}

export default { userDirectoryDTO, userProfileDTO }
