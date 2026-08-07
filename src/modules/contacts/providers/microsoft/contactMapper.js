/**
 * Translation between Microsoft Graph `contact` resources and the
 * provider-independent shape declared in `ContactProvider`.
 *
 * The only file in the contacts module that knows Graph's field names.
 *
 * Translation is defensive throughout: Graph omits fields rather than sending
 * nulls, and omits different ones depending on `$select` and how the contact was
 * created. Every access assumes absence is normal.
 */

/** Parses a Graph ISO timestamp, tolerating absence and malformed values. */
function toDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** First non-empty phone in a Graph phone array. */
const firstPhone = (numbers) => (numbers ?? []).find((entry) => entry?.trim()) ?? null

/**
 * Graph contact → `ProviderContact`.
 *
 * @param {object} contact Raw Graph `contact` resource.
 * @returns {import('../../interfaces/ContactProvider.js').ProviderContact}
 */
export function toProviderContact(contact) {
  const address = contact?.businessAddress ?? contact?.homeAddress ?? {}

  /**
   * Graph returns `emailAddresses` as `[{ name, address }]`, ordered with the
   * primary first. Entries without an address do occur — a contact can carry a
   * label with no value — and are dropped rather than stored as empty strings.
   */
  const emails = (contact?.emailAddresses ?? [])
    .map((entry) => entry?.address?.trim().toLowerCase())
    .filter(Boolean)

  return {
    providerContactId: contact?.id ?? null,

    firstName: contact?.givenName ?? null,
    lastName: contact?.surname ?? null,
    // `displayName` is what Outlook shows; falling back to the name parts keeps
    // a contact identifiable when it was created without one.
    displayName:
      contact?.displayName ??
      [contact?.givenName, contact?.surname].filter(Boolean).join(' ') ??
      null,

    company: contact?.companyName ?? null,
    jobTitle: contact?.jobTitle ?? null,

    emails,

    mobile: contact?.mobilePhone ?? null,
    businessPhone: firstPhone(contact?.businessPhones),
    homePhone: firstPhone(contact?.homePhones),

    // Graph has no single website field; the first business URL is the closest.
    website: firstPhone(contact?.businessHomePage ? [contact.businessHomePage] : []),

    address: {
      street: address?.street ?? null,
      city: address?.city ?? null,
      state: address?.state ?? null,
      country: address?.countryOrRegion ?? null,
      postalCode: address?.postalCode ?? null,
    },

    notes: contact?.personalNotes ?? null,
    categories: contact?.categories ?? [],

    birthday: toDate(contact?.birthday),

    /** Graph's optimistic-concurrency marker, the basis for conflict detection. */
    changeKey: contact?.changeKey ?? null,
    lastModifiedAt: toDate(contact?.lastModifiedDateTime),
  }
}

/**
 * CRM contact → Graph `contact` resource for writing.
 *
 * Only fields Graph actually owns are sent. CRM-specific concepts — tags,
 * category, favourite, owner — are deliberately excluded: they have no Graph
 * equivalent, and inventing extended properties for them would make the CRM's
 * own data depend on a mail provider's schema.
 *
 * @param {object} contact A `Contact` document or plain object.
 * @returns {object}
 */
export function toGraphContact(contact) {
  const graph = {
    givenName: contact.firstName ?? null,
    surname: contact.lastName ?? null,
    displayName: contact.displayName ?? null,
    companyName: contact.company ?? null,
    jobTitle: contact.jobTitle ?? null,
    personalNotes: contact.notes ?? null,
  }

  const emails = [contact.primaryEmail, contact.secondaryEmail].filter(Boolean)
  if (emails.length > 0) {
    graph.emailAddresses = emails.map((address) => ({
      address,
      name: contact.displayName ?? address,
    }))
  }

  if (contact.mobile) graph.mobilePhone = contact.mobile
  // Graph models these as arrays even though Outlook's UI shows one field.
  if (contact.businessPhone) graph.businessPhones = [contact.businessPhone]
  if (contact.phone) graph.homePhones = [contact.phone]
  if (contact.website) graph.businessHomePage = contact.website

  const hasAddress =
    contact.address || contact.city || contact.state || contact.country || contact.postalCode

  if (hasAddress) {
    graph.businessAddress = {
      street: contact.address ?? null,
      city: contact.city ?? null,
      state: contact.state ?? null,
      countryOrRegion: contact.country ?? null,
      postalCode: contact.postalCode ?? null,
    }
  }

  if (contact.birthday) {
    // Graph expects a full ISO timestamp even though only the date matters.
    graph.birthday = new Date(contact.birthday).toISOString()
  }

  return graph
}

/**
 * Extracts the opaque delta token from a Graph delta response.
 *
 * The whole URL is kept rather than the parsed token: Graph expects it replayed
 * verbatim, and reconstructing it from parts would break the moment Microsoft
 * added a parameter.
 */
export function extractDeltaToken(response) {
  return response?.['@odata.deltaLink'] ?? response?.['@odata.nextLink'] ?? null
}

/**
 * Separates tombstones from live contacts in a delta response.
 *
 * Graph marks a removed contact with `@removed`, keeping only its id. These must
 * be applied as deletions — otherwise a contact deleted in Outlook stays in the
 * CRM indefinitely.
 */
export function partitionDeltaContacts(values = []) {
  const contacts = []
  const deletedIds = []

  for (const value of values) {
    if (value?.['@removed']) {
      if (value.id) deletedIds.push(value.id)
    } else {
      contacts.push(value)
    }
  }

  return { contacts, deletedIds }
}

export default { toProviderContact, toGraphContact, extractDeltaToken, partitionDeltaContacts }
