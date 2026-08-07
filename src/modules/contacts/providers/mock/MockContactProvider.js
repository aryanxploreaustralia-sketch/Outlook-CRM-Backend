/**
 * In-memory contact provider used when no real one is configured.
 *
 * Same contract as Phase 5's `MockEmailProvider`, for the same reason: the sync
 * engine, duplicate detection, conflict resolution and the whole contacts UI can
 * be built, demonstrated and tested without Azure credentials or a network.
 *
 * It never throws, and its data is deterministic — generated from a seeded PRNG
 * keyed on the mailbox — so a demo looks the same on every reload and a failure
 * is reproducible.
 *
 * The fixture set deliberately contains **planted duplicates**: two entries
 * sharing an email, two sharing a phone, and two with the same display name but
 * different emails. Duplicate detection is the hardest part of this module to
 * get right, and a mock with no duplicates would leave it untested.
 */

import crypto from 'node:crypto'

import { ContactProvider, CONTACT_CAPABILITIES } from '../../interfaces/ContactProvider.js'
import { PROVIDER_TYPES } from '../../../provider/constants/providerTypes.js'
import { beginRequest } from '../../../provider/utils/providerLogger.js'
import { buildMockContacts, MOCK_GROUPS } from './mockContactData.js'

/** Simulated latency, so the UI's loading states are exercised. */
const SIMULATED_LATENCY_MS = 90

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class MockContactProvider extends ContactProvider {
  constructor(context = {}) {
    super(context)

    /** Contacts created or edited through this adapter, held for the process lifetime. */
    this.overrides = new Map()
    this.created = new Map()
    this.deleted = new Set()
  }

  get type() {
    return PROVIDER_TYPES.MOCK
  }

  get label() {
    return 'Simulated address book'
  }

  get capabilities() {
    // Everything: a capability withheld would leave a code path above untested.
    return new Set(Object.values(CONTACT_CAPABILITIES))
  }

  #mailboxId(params = {}) {
    return params.mailbox?._id?.toString() ?? 'mock-mailbox'
  }

  /** Wraps an operation with latency and structured logging. */
  async #simulate(operation, context, produce) {
    const finish = beginRequest(this.type, operation, context)
    await delay(SIMULATED_LATENCY_MS)
    const result = await produce()
    finish('success', { simulated: true })
    return result
  }

  /** Fixtures with in-session mutations applied. */
  #contactsFor(params) {
    const base = buildMockContacts({
      mailboxId: this.#mailboxId(params),
      count: params.count,
    })

    return [...base, ...this.created.values()]
      .filter((contact) => !this.deleted.has(contact.providerContactId))
      .map((contact) => {
        const override = this.overrides.get(contact.providerContactId)
        return override ? { ...contact, ...override } : contact
      })
  }

  async listContacts(params = {}) {
    return this.#simulate('listContacts', { incremental: Boolean(params.deltaToken) }, () => {
      // A replayed token returns an empty page — what a real provider does when
      // nothing changed, and the case most likely to be handled wrongly by a
      // sync engine tested only against fresh data.
      if (params.deltaToken) {
        return {
          contacts: [],
          deletedContactIds: [...this.deleted],
          deltaToken: params.deltaToken,
          hasMore: false,
        }
      }

      return {
        contacts: this.#contactsFor(params),
        deletedContactIds: [],
        deltaToken: `mock-contact-delta-${Date.now().toString(36)}`,
        hasMore: false,
      }
    })
  }

  async getContact(providerContactId, params = {}) {
    return this.#simulate('getContact', { providerContactId }, () => {
      return (
        this.#contactsFor(params).find(
          (contact) => contact.providerContactId === providerContactId,
        ) ?? null
      )
    })
  }

  async createContact(contact, _params = {}) {
    return this.#simulate('createContact', {}, () => {
      const id = `mock-contact-${crypto.randomUUID()}`

      this.created.set(id, {
        providerContactId: id,
        firstName: contact.firstName ?? null,
        lastName: contact.lastName ?? null,
        displayName: contact.displayName ?? null,
        company: contact.company ?? null,
        jobTitle: contact.jobTitle ?? null,
        emails: [contact.primaryEmail, contact.secondaryEmail].filter(Boolean),
        mobile: contact.mobile ?? null,
        businessPhone: contact.businessPhone ?? null,
        homePhone: contact.phone ?? null,
        website: contact.website ?? null,
        address: {
          street: contact.address ?? null,
          city: contact.city ?? null,
          state: contact.state ?? null,
          country: contact.country ?? null,
          postalCode: contact.postalCode ?? null,
        },
        notes: contact.notes ?? null,
        categories: [],
        birthday: contact.birthday ?? null,
        changeKey: `mock-ck-${Date.now().toString(36)}`,
        lastModifiedAt: new Date(),
      })

      return { providerContactId: id, changeKey: `mock-ck-${Date.now().toString(36)}` }
    })
  }

  async updateContact(providerContactId, contact, _params = {}) {
    return this.#simulate('updateContact', { providerContactId }, () => {
      const changeKey = `mock-ck-${Date.now().toString(36)}`

      this.overrides.set(providerContactId, {
        ...(this.overrides.get(providerContactId) ?? {}),
        firstName: contact.firstName ?? null,
        lastName: contact.lastName ?? null,
        displayName: contact.displayName ?? null,
        company: contact.company ?? null,
        jobTitle: contact.jobTitle ?? null,
        changeKey,
        lastModifiedAt: new Date(),
      })

      return { providerContactId, changeKey }
    })
  }

  async deleteContact(providerContactId, _params = {}) {
    return this.#simulate('deleteContact', { providerContactId }, () => {
      this.deleted.add(providerContactId)
      this.created.delete(providerContactId)
      return { deleted: true }
    })
  }

  async getContactPhoto(providerContactId, _params = {}) {
    return this.#simulate('getContactPhoto', { providerContactId }, () => {
      // Most real contacts have no photo; the mock reflects that rather than
      // returning an image for every one.
      return null
    })
  }

  async listGroups(_params = {}) {
    return this.#simulate('listGroups', {}, () => [...MOCK_GROUPS])
  }
}

export default MockContactProvider
