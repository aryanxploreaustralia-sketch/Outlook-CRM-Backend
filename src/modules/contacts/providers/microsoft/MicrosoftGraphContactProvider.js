/**
 * Microsoft Graph implementation of `ContactProvider`.
 *
 * Reuses Phase 5's `callGraph` transport rather than building its own, so MSAL
 * token acquisition, refresh-on-demand, the auth-error capture and the whole
 * error-translation table apply here unchanged — one implementation, not two
 * that can drift.
 */

import { ContactProvider, CONTACT_CAPABILITIES } from '../../interfaces/ContactProvider.js'
import { PROVIDER_TYPES } from '../../../provider/constants/providerTypes.js'
import { PROVIDER_ERROR_CODES, ProviderError } from '../../../provider/constants/providerErrors.js'
import { callGraph as defaultCallGraph } from '../../../provider/providers/microsoft/graphClient.js'
import { beginRequest } from '../../../provider/utils/providerLogger.js'
import {
  extractDeltaToken,
  partitionDeltaContacts,
  toGraphContact,
  toProviderContact,
} from './contactMapper.js'

/**
 * Fields requested for a contact.
 *
 * Selected explicitly rather than taking Graph's default, which returns a large
 * resource including several address blocks and phone arrays this application
 * never reads.
 */
const CONTACT_FIELDS = [
  'id',
  'givenName',
  'surname',
  'displayName',
  'companyName',
  'jobTitle',
  'emailAddresses',
  'mobilePhone',
  'businessPhones',
  'homePhones',
  'businessHomePage',
  'businessAddress',
  'homeAddress',
  'personalNotes',
  'categories',
  'birthday',
  'changeKey',
  'lastModifiedDateTime',
].join(',')

/** Contacts fetched per page. */
const PAGE_SIZE = 50

export class MicrosoftGraphContactProvider extends ContactProvider {
  /**
   * @param {object} [dependencies]
   * @param {Function} [dependencies.callGraph] Injected for testing.
   */
  constructor({ callGraph = defaultCallGraph, ...context } = {}) {
    super(context)
    this.callGraph = callGraph
  }

  get type() {
    return PROVIDER_TYPES.MICROSOFT_GRAPH
  }

  get label() {
    return 'Microsoft Outlook'
  }

  get capabilities() {
    return new Set([
      CONTACT_CAPABILITIES.READ,
      CONTACT_CAPABILITIES.WRITE,
      CONTACT_CAPABILITIES.DELETE,
      CONTACT_CAPABILITIES.INCREMENTAL_SYNC,
      CONTACT_CAPABILITIES.PHOTOS,
      CONTACT_CAPABILITIES.GROUPS,
    ])
  }

  /** Resolves the `OutlookAccount` id the Graph client authenticates as. */
  #accountId(params = {}) {
    const id = params.mailbox?.sourceAccount ?? params.outlookAccountId ?? null

    if (!id) {
      throw new ProviderError(
        PROVIDER_ERROR_CODES.NOT_CONNECTED,
        'This mailbox is not linked to a Microsoft sign-in.',
        { provider: this.type },
      )
    }

    return id.toString()
  }

  /** Runs a Graph call with structured request/response logging. */
  async #run(operation, params, context, work) {
    const accountId = this.#accountId(params)
    const finish = beginRequest(this.type, operation, context)

    try {
      const result = await this.callGraph(accountId, operation, work)
      finish('success')
      return result
    } catch (error) {
      finish('failure', { code: error?.code ?? null, providerCode: error?.providerCode ?? null })
      throw error
    }
  }

  async listContacts(params = {}) {
    const response = await this.#run(
      'listContacts',
      params,
      { incremental: Boolean(params.deltaToken) },
      (client) => {
        // A delta link is a complete URL and must be replayed verbatim.
        if (params.deltaToken) return client.api(params.deltaToken).get()

        return client
          .api('/me/contacts/delta')
          .select(CONTACT_FIELDS)
          .top(params.pageSize ?? PAGE_SIZE)
          .get()
      },
    )

    const { contacts, deletedIds } = partitionDeltaContacts(response?.value ?? [])

    return {
      contacts: contacts.map(toProviderContact),
      deletedContactIds: deletedIds,
      deltaToken: extractDeltaToken(response),
      hasMore: Boolean(response?.['@odata.nextLink']),
    }
  }

  async getContact(providerContactId, params = {}) {
    try {
      const contact = await this.#run(
        'getContact',
        params,
        { providerContactId },
        (client) => client.api(`/me/contacts/${providerContactId}`).select(CONTACT_FIELDS).get(),
      )

      return toProviderContact(contact)
    } catch (error) {
      if (error.code === PROVIDER_ERROR_CODES.NOT_FOUND) return null
      throw error
    }
  }

  async createContact(contact, params = {}) {
    const created = await this.#run('createContact', params, {}, (client) =>
      client.api('/me/contacts').post(toGraphContact(contact)),
    )

    return { providerContactId: created?.id ?? null, changeKey: created?.changeKey ?? null }
  }

  async updateContact(providerContactId, contact, params = {}) {
    const updated = await this.#run(
      'updateContact',
      params,
      { providerContactId },
      (client) => client.api(`/me/contacts/${providerContactId}`).patch(toGraphContact(contact)),
    )

    return {
      providerContactId: updated?.id ?? providerContactId,
      changeKey: updated?.changeKey ?? null,
    }
  }

  async deleteContact(providerContactId, params = {}) {
    try {
      await this.#run('deleteContact', params, { providerContactId }, (client) =>
        client.api(`/me/contacts/${providerContactId}`).delete(),
      )
      return { deleted: true }
    } catch (error) {
      // Already gone is the outcome the caller wanted.
      if (error.code === PROVIDER_ERROR_CODES.NOT_FOUND) return { deleted: false }
      throw error
    }
  }

  async getContactPhoto(providerContactId, params = {}) {
    try {
      const photo = await this.#run(
        'getContactPhoto',
        params,
        { providerContactId },
        (client) => client.api(`/me/contacts/${providerContactId}/photo/$value`).get(),
      )

      if (!photo) return null

      // The SDK hands back an ArrayBuffer or Buffer depending on the transport;
      // both are normalised to base64 so callers never have to check.
      const buffer = Buffer.isBuffer(photo) ? photo : Buffer.from(photo)

      return { contentType: 'image/jpeg', contentBytes: buffer.toString('base64') }
    } catch (error) {
      // Most contacts have no photo. That is not an error worth propagating.
      if (error.code === PROVIDER_ERROR_CODES.NOT_FOUND) return null
      throw error
    }
  }

  async listGroups(params = {}) {
    const response = await this.#run('listGroups', params, {}, (client) =>
      client.api('/me/contactFolders').select('id,displayName').top(100).get(),
    )

    return (response?.value ?? []).map((folder) => ({
      providerGroupId: folder.id,
      displayName: folder.displayName ?? 'Unnamed folder',
    }))
  }
}

export default MicrosoftGraphContactProvider
