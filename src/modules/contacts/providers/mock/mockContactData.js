/**
 * Deterministic contact fixtures.
 *
 * Seeded from the mailbox id, so the same mailbox produces the same address book
 * on every run. Random fixtures make demos change on reload and failures
 * unreproducible.
 *
 * ## Planted duplicates
 *
 * The set deliberately ends with four contacts that duplicate earlier ones — by
 * email, by phone, and by display name with a different email. Duplicate
 * detection is the subtlest logic in this module, and a fixture set of uniformly
 * distinct people would exercise none of it.
 */

/** Mulberry32 — small, fast, seedable. Chosen for reproducibility, not crypto. */
function seededRandom(seed) {
  let state = seed >>> 0

  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** FNV-1a — turns a mailbox id into a stable numeric seed. */
function seedFrom(value) {
  const text = String(value ?? 'contacts')
  let hash = 2_166_136_261

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }

  return hash >>> 0
}

export const COMPANIES = Object.freeze([
  { name: 'Northwind Trading', domain: 'northwind-trading.com', country: 'United Kingdom', city: 'Manchester' },
  { name: 'Meridian Logistics', domain: 'meridian-logistics.com', country: 'Netherlands', city: 'Rotterdam' },
  { name: 'Lumen Parts', domain: 'lumenparts.io', country: 'Portugal', city: 'Porto' },
  { name: 'Brightpath AB', domain: 'brightpath.se', country: 'Sweden', city: 'Gothenburg' },
  { name: 'Cedarbrook Supply', domain: 'cedarbrook.co', country: 'Ireland', city: 'Cork' },
  { name: 'Harborview Freight', domain: 'harborview.net', country: 'United States', city: 'Baltimore' },
  { name: 'Sakura Works', domain: 'sakuraworks.jp', country: 'Japan', city: 'Osaka' },
  { name: 'Via Corda', domain: 'viacorda.it', country: 'Italy', city: 'Turin' },
  { name: 'Kestrel Analytics', domain: 'kestrel-analytics.com', country: 'United States', city: 'Austin' },
  { name: 'Alderman & Fitch', domain: 'aldermanfitch.co.uk', country: 'United Kingdom', city: 'Leeds' },
  { name: 'Orion Components', domain: 'orion-components.de', country: 'Germany', city: 'Stuttgart' },
  { name: 'Pacific Rim Imports', domain: 'pacificrimimports.com', country: 'Australia', city: 'Melbourne' },
  { name: 'Verdant Packaging', domain: 'verdantpack.com', country: 'Canada', city: 'Vancouver' },
  { name: 'Silverline Marine', domain: 'silverlinemarine.no', country: 'Norway', city: 'Bergen' },
  { name: 'Copperfield Mills', domain: 'copperfieldmills.com', country: 'United States', city: 'Charlotte' },
  { name: 'Estuary Chemicals', domain: 'estuarychem.be', country: 'Belgium', city: 'Antwerp' },
  { name: 'Redwood Instruments', domain: 'redwoodinstruments.com', country: 'United States', city: 'Portland' },
  { name: 'Tannenbaum GmbH', domain: 'tannenbaum.de', country: 'Germany', city: 'Freiburg' },
  { name: 'Lighthouse Media', domain: 'lighthousemedia.co', country: 'Ireland', city: 'Galway' },
  { name: 'Solstice Textiles', domain: 'solsticetextiles.in', country: 'India', city: 'Coimbatore' },
])

const FIRST_NAMES = [
  'Priya', 'Daniel', 'Sofia', 'Marcus', 'Aisha', 'Tom', 'Yuki', 'Elena', 'Rahul', 'Clara',
  'Mateo', 'Ingrid', 'Omar', 'Hannah', 'Kwame', 'Lucia', 'Nils', 'Fatima', 'Diego', 'Anya',
  'Sean', 'Mei', 'Viktor', 'Amara', 'Josef', 'Nadia', 'Callum', 'Ravi', 'Beatriz', 'Henrik',
]

const LAST_NAMES = [
  'Raman', 'Okafor', 'Almeida', 'Lindqvist', 'Haddad', 'Whitfield', 'Tanaka', 'Rossi',
  'Mehta', 'Bergström', 'Navarro', 'Sørensen', 'Farouk', 'Weber', 'Mensah', 'Delgado',
  'Andersen', 'Zaidi', 'Costa', 'Petrov', 'Gallagher', 'Chen', 'Novak', 'Adeyemi',
  'Fischer', 'Karim', 'Doherty', 'Iyer', 'Fonseca', 'Larsen',
]

const JOB_TITLES = [
  'Procurement Manager', 'Head of Operations', 'Logistics Coordinator', 'Finance Director',
  'Account Manager', 'Supply Chain Analyst', 'Managing Director', 'Warehouse Supervisor',
  'Quality Assurance Lead', 'Commercial Manager', 'Export Coordinator', 'Category Buyer',
]

const NOTE_TEMPLATES = [
  'Prefers email over phone. Responds within a working day.',
  'Main contact for the quarterly supply agreement.',
  'Handles customs documentation for EU shipments.',
  'Escalation point for delivery disputes.',
  'Introduced at the trade fair; follow up on pricing.',
  'Signs off on orders above 10,000 units.',
  'Out of office most Fridays.',
  'Prefers scheduled calls rather than ad-hoc.',
]

const TAG_POOL = [
  'key-account', 'supplier', 'logistics', 'finance', 'decision-maker',
  'follow-up', 'eu', 'apac', 'renewal', 'technical',
]

/** Deterministic phone number in a plausible international format. */
function buildPhone(random, countryCode) {
  const digits = () => Math.floor(random() * 9_000_000 + 1_000_000)
  return `+${countryCode} ${String(digits()).slice(0, 3)} ${String(digits()).slice(0, 4)}`
}

const COUNTRY_CODES = {
  'United Kingdom': '44', Netherlands: '31', Portugal: '351', Sweden: '46', Ireland: '353',
  'United States': '1', Japan: '81', Italy: '39', Germany: '49', Australia: '61',
  Canada: '1', Norway: '47', Belgium: '32', India: '91',
}

/**
 * Builds a deterministic contact set.
 *
 * @param {object} params
 * @param {string} params.mailboxId Seeds the PRNG.
 * @param {number} [params.count] Distinct contacts before duplicates are added.
 * @returns {import('../../interfaces/ContactProvider.js').ProviderContact[]}
 */
export function buildMockContacts({ mailboxId, count = 40 }) {
  const random = seededRandom(seedFrom(mailboxId))
  const contacts = []

  for (let index = 0; index < count; index += 1) {
    const firstName = FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length)]
    const lastName = LAST_NAMES[Math.floor(random() * LAST_NAMES.length)]
    const company = COMPANIES[Math.floor(random() * COMPANIES.length)]
    const countryCode = COUNTRY_CODES[company.country] ?? '44'

    const local = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '')
    const email = `${local}@${company.domain}`

    const tagCount = Math.floor(random() * 3)
    const tags = []
    for (let t = 0; t < tagCount; t += 1) {
      const tag = TAG_POOL[Math.floor(random() * TAG_POOL.length)]
      if (!tags.includes(tag)) tags.push(tag)
    }

    // Spread birthdays across plausible working-age years.
    const birthYear = 1962 + Math.floor(random() * 40)
    const birthMonth = 1 + Math.floor(random() * 12)
    const birthDay = 1 + Math.floor(random() * 28)

    contacts.push({
      providerContactId: `mock-contact-${seedFrom(`${mailboxId}${email}${index}`).toString(16)}`,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      company: company.name,
      jobTitle: JOB_TITLES[Math.floor(random() * JOB_TITLES.length)],
      emails: [email],
      mobile: random() > 0.4 ? buildPhone(random, countryCode) : null,
      businessPhone: buildPhone(random, countryCode),
      homePhone: null,
      website: random() > 0.7 ? `https://www.${company.domain}` : null,
      address: {
        street: `${1 + Math.floor(random() * 200)} ${lastName} Street`,
        city: company.city,
        state: null,
        country: company.country,
        postalCode: String(10_000 + Math.floor(random() * 89_999)),
      },
      notes: random() > 0.5 ? NOTE_TEMPLATES[Math.floor(random() * NOTE_TEMPLATES.length)] : null,
      categories: tags,
      birthday: new Date(Date.UTC(birthYear, birthMonth - 1, birthDay)),
      changeKey: `mock-ck-${seedFrom(`${email}${index}`).toString(16)}`,
      lastModifiedAt: new Date(Date.now() - Math.floor(random() * 90 * 86_400_000)),
    })
  }

  // --- Planted duplicates, so detection has something real to find ----------
  const [first, second, third] = contacts

  if (first) {
    // Same email, different name spelling — the highest-confidence match.
    contacts.push({
      ...first,
      providerContactId: `${first.providerContactId}-dup-email`,
      firstName: first.firstName,
      lastName: first.lastName,
      displayName: `${first.firstName} ${first.lastName[0]}.`,
      jobTitle: 'Procurement Lead',
      changeKey: `${first.changeKey}-d1`,
    })
  }

  if (second) {
    // Same mobile, different email — a weaker signal that still matters.
    contacts.push({
      ...second,
      providerContactId: `${second.providerContactId}-dup-phone`,
      emails: [`${second.firstName}.alt@${second.emails[0].split('@')[1]}`.toLowerCase()],
      displayName: `${second.displayName} (mobile)`,
      changeKey: `${second.changeKey}-d2`,
    })
  }

  if (third) {
    // Identical display name, entirely different person — must NOT auto-merge.
    contacts.push({
      ...third,
      providerContactId: `${third.providerContactId}-namesake`,
      emails: [`${third.firstName}.${third.lastName}@lumenparts.io`.toLowerCase()],
      company: 'Lumen Parts',
      mobile: null,
      businessPhone: null,
      changeKey: `${third.changeKey}-d3`,
    })
  }

  return contacts
}

/** Contact folders the mock reports. */
export const MOCK_GROUPS = Object.freeze([
  { providerGroupId: 'mock-folder-default', displayName: 'Contacts' },
  { providerGroupId: 'mock-folder-suppliers', displayName: 'Suppliers' },
  { providerGroupId: 'mock-folder-customers', displayName: 'Customers' },
])

export default { buildMockContacts, COMPANIES, MOCK_GROUPS }
