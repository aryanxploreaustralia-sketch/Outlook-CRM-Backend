/**
 * The contract every contact-source adapter implements.
 *
 * Deliberately separate from `EmailProvider` rather than bolted onto it. The two
 * describe different capabilities of what may be different systems: a CRM might
 * sync contacts from a directory while sending mail through SMTP, and an SMTP
 * relay has no contacts at all. Merging them would force every mail adapter to
 * stub out eight contact methods it can never implement.
 *
 * The pattern is otherwise identical to Phase 5's — abstract base, capability
 * declaration, startup conformance check — so the two read the same way and the
 * registry logic is familiar.
 */

import { PROVIDER_ERROR_CODES, ProviderError } from '../../provider/constants/providerErrors.js'

/** Optional behaviours an adapter may declare. */
export const CONTACT_CAPABILITIES = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  /** Provider issues delta tokens, so incremental sync is possible. */
  INCREMENTAL_SYNC: 'incremental_sync',
  PHOTOS: 'photos',
  GROUPS: 'groups',
})

/**
 * @typedef  {object} ProviderContact
 * @property {string}  providerContactId
 * @property {?string} firstName
 * @property {?string} lastName
 * @property {?string} displayName
 * @property {?string} company
 * @property {?string} jobTitle
 * @property {string[]} emails            Primary first.
 * @property {?string} mobile
 * @property {?string} businessPhone
 * @property {?string} homePhone
 * @property {?string} website
 * @property {object}  address            `{ street, city, state, country, postalCode }`
 * @property {?string} notes
 * @property {string[]} categories
 * @property {?Date}   birthday
 * @property {?string} changeKey          Provider version marker, for conflict detection.
 * @property {?Date}   lastModifiedAt
 */

/**
 * @typedef  {object} ContactSyncPage
 * @property {ProviderContact[]} contacts
 * @property {string[]} deletedContactIds
 * @property {?string}  deltaToken
 * @property {boolean}  hasMore
 */

export class ContactProvider {
  constructor(context = {}) {
    if (new.target === ContactProvider) {
      throw new TypeError('ContactProvider is abstract and cannot be constructed directly.')
    }

    this.context = context
  }

  /** Provider identity, from `PROVIDER_TYPES`. Adapters must override. */
  get type() {
    return this.#missing('type')
  }

  get label() {
    return this.type
  }

  /** @returns {Set<string>} */
  get capabilities() {
    return new Set()
  }

  supports(capability) {
    return this.capabilities.has(capability)
  }

  #missing(method) {
    throw new ProviderError(
      PROVIDER_ERROR_CODES.UNSUPPORTED,
      `${this.constructor.name} does not implement "${method}".`,
      { provider: this.constructor.name, details: { method } },
    )
  }

  /**
   * Reads a page of contacts.
   *
   * Passing a `deltaToken` requests an incremental read; omitting it requests a
   * full one.
   *
   * @param {object} _params
   * @returns {Promise<ContactSyncPage>}
   */
  async listContacts(_params) {
    return this.#missing('listContacts')
  }

  /**
   * @param {string} _providerContactId
   * @returns {Promise<?ProviderContact>}
   */
  async getContact(_providerContactId, _params) {
    return this.#missing('getContact')
  }

  /** @returns {Promise<{ providerContactId: string, changeKey: ?string }>} */
  async createContact(_contact, _params) {
    return this.#missing('createContact')
  }

  /** @returns {Promise<{ providerContactId: string, changeKey: ?string }>} */
  async updateContact(_providerContactId, _contact, _params) {
    return this.#missing('updateContact')
  }

  /** @returns {Promise<{ deleted: boolean }>} */
  async deleteContact(_providerContactId, _params) {
    return this.#missing('deleteContact')
  }

  /**
   * Fetches a contact photo.
   *
   * Returns null rather than throwing when the contact simply has no photo —
   * the overwhelmingly common case, and not an error.
   *
   * @returns {Promise<?{ contentType: string, contentBytes: string }>}
   */
  async getContactPhoto(_providerContactId, _params) {
    return this.#missing('getContactPhoto')
  }

  /** @returns {Promise<Array<{ providerGroupId: string, displayName: string }>>} */
  async listGroups(_params) {
    return this.#missing('listGroups')
  }
}

/** Every method an adapter is expected to provide. */
export const REQUIRED_CONTACT_METHODS = Object.freeze(
  Object.getOwnPropertyNames(ContactProvider.prototype).filter(
    (name) =>
      name !== 'constructor' &&
      name !== 'supports' &&
      typeof Object.getOwnPropertyDescriptor(ContactProvider.prototype, name)?.value === 'function',
  ),
)

/**
 * Verifies an adapter implements the whole interface.
 *
 * Run at registration, so a gap is a startup failure naming the method rather
 * than a `TypeError` midway through a sync against a live address book.
 *
 * @param {ContactProvider} provider
 * @returns {{ ok: boolean, missing: string[], unsupported: string[] }}
 */
export function assertImplementsContactProvider(provider) {
  const missing = []
  const unsupported = []

  for (const method of REQUIRED_CONTACT_METHODS) {
    if (typeof provider[method] !== 'function') {
      missing.push(method)
      continue
    }

    if (provider[method] === ContactProvider.prototype[method]) {
      unsupported.push(method)
    }
  }

  return { ok: missing.length === 0, missing, unsupported }
}

export default ContactProvider
