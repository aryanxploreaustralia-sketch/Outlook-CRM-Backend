/**
 * Account lifecycle states, and the transitions permitted between them.
 *
 * ## Why a status field exists alongside `isActive` / `isDeleted`
 *
 * Those two booleans can express three states — active, inactive, removed — and
 * the enterprise directory needs four. Specifically, they cannot distinguish
 * *invited* (a record created by an administrator that nobody has signed into
 * yet) from *suspended* (an account that worked and was stopped). Both are
 * `isActive: false`, and they call for completely different words, different
 * actions and different alarm on a directory screen.
 *
 * So `status` is the vocabulary, and the booleans remain the **enforcement**.
 * That split is deliberate: `canSignIn()` and the Google sign-in flow already
 * read the booleans and are frozen, so status must never become the thing that
 * decides whether somebody may sign in. `syncStatusFlags()` below keeps the two
 * in step, and the invariant it encodes is what makes the field safe to add.
 */

export const USER_STATUS = Object.freeze({
  /**
   * Created by an administrator; has never signed in.
   *
   * The record carries an email and no `googleId`. On first Google sign-in the
   * existing identity flow finds it by verified email and links the identity —
   * so an invitation *becomes* the person's account with no change to
   * authentication. That is the whole reason invitations are modelled on `User`
   * rather than in a separate collection.
   */
  INVITED: 'invited',

  /** May sign in and use the CRM. */
  ACTIVE: 'active',

  /**
   * Stopped by an administrator. Retained in full.
   *
   * Never a deletion: sessions, leads, conversations, campaigns and import jobs
   * all reference a user by id, and removing the row would leave every one of
   * them pointing at nothing.
   */
  SUSPENDED: 'suspended',

  /**
   * Soft-deleted — `isDeleted: true`.
   *
   * ## Why the stored value stays `disabled`
   *
   * Phase 15.2 made this reachable: it is what "delete a user" produces. The
   * brief calls the state `deleted` and the interface says so, but the stored
   * value is unchanged deliberately — `deriveUserStatus` already maps a legacy
   * `isDeleted: true` document onto it, and introducing a second value meaning
   * exactly the same thing would force every filter to check for both forever.
   *
   * One state, one stored value, labelled the way people speak about it.
   */
  DISABLED: 'disabled',
})

export const USER_STATUS_VALUES = Object.freeze(Object.values(USER_STATUS))

export const USER_STATUS_LABELS = Object.freeze({
  [USER_STATUS.INVITED]: 'Invited',
  [USER_STATUS.ACTIVE]: 'Active',
  [USER_STATUS.SUSPENDED]: 'Suspended',
  [USER_STATUS.DISABLED]: 'Deleted',
})

/**
 * The state machine.
 *
 * Written as data rather than as a chain of `if`s so the permitted set can be
 * asserted in one place, listed in an error message, and read by a human
 * without tracing branches.
 *
 * Phase 15.2 opened `disabled` in both directions. It was previously terminal
 * and unreachable, with the note that "an account that was removed is not
 * brought back by an activate button" — which is still true: restoring is its
 * own endpoint, its own permission and its own confirmation, not a reuse of
 * activate. What changed is that deletion is now an action somebody can take,
 * so it needs a way in, and a deletion nobody can undo is a footgun rather than
 * a safety feature.
 */
export const USER_STATUS_TRANSITIONS = Object.freeze({
  [USER_STATUS.INVITED]: Object.freeze([USER_STATUS.ACTIVE, USER_STATUS.SUSPENDED, USER_STATUS.DISABLED]),
  [USER_STATUS.ACTIVE]: Object.freeze([USER_STATUS.SUSPENDED, USER_STATUS.DISABLED]),
  [USER_STATUS.SUSPENDED]: Object.freeze([USER_STATUS.ACTIVE, USER_STATUS.DISABLED]),
  /**
   * Restore returns an account to `active`, never to `suspended` or `invited`.
   *
   * Restoring to `invited` would claim they had never signed in, and restoring
   * to `suspended` would be a deletion that quietly became a lesser punishment.
   * Active is the only honest destination — and sessions stay revoked, so they
   * still have to sign in again.
   */
  [USER_STATUS.DISABLED]: Object.freeze([USER_STATUS.ACTIVE]),
})

/**
 * Whether a transition is permitted.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return (USER_STATUS_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * The status of a record that predates this field.
 *
 * Mongoose applies a schema default when it *creates* a document, not when it
 * reads one that lacks the path — and every read in the admin module is
 * `.lean()`, which returns raw BSON. So a user written before this phase has no
 * `status` at all, and something has to say what it means.
 *
 * Derived from the booleans that were the truth at the time, in the same order
 * `canSignIn()` tests them, so the answer agrees with what sign-in would do.
 *
 * @param {{ status?: string, isActive?: boolean, isDeleted?: boolean }} user
 * @returns {string}
 */
export function deriveUserStatus(user) {
  if (user?.status) return user.status
  if (user?.isDeleted === true) return USER_STATUS.DISABLED
  if (user?.isActive === false) return USER_STATUS.SUSPENDED

  return USER_STATUS.ACTIVE
}

/**
 * The `isActive` / `isDeleted` pair a status implies.
 *
 * **This is the load-bearing function of the whole phase.** Sign-in reads the
 * booleans and nothing else; every write that changes `status` must pass through
 * here, or a suspended account keeps signing in and an invited one is admitted
 * before anybody activated it.
 *
 * `isDeleted` is only ever *set* to true here, never cleared — un-deleting is
 * not a transition this phase offers, and quietly performing one as a side
 * effect of an activate button would be the wrong way to discover that.
 *
 * @param {string} status
 * @returns {{ isActive: boolean, isDeleted?: boolean }}
 */
export function statusFlags(status) {
  switch (status) {
    case USER_STATUS.ACTIVE:
      return { isActive: true }
    case USER_STATUS.INVITED:
    case USER_STATUS.SUSPENDED:
      return { isActive: false }
    case USER_STATUS.DISABLED:
      return { isActive: false, isDeleted: true }
    default:
      // An unknown status is treated as the safest thing it could be. Reaching
      // here means validation was bypassed, and admitting the account would be
      // the worse of the two failures.
      return { isActive: false }
  }
}

export default USER_STATUS
