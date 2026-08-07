#!/usr/bin/env node
/**
 * Seeds a realistic address book.
 *
 * Run with:  npm run seed:contacts [-- --reset] [-- --count 500]
 *
 * Generates 500 contacts across 20 companies in 10 groups, deterministically —
 * the same run produces the same data, so a demo looks identical on every reload
 * and a bug found here is reproducible.
 *
 * Contacts are created through the `Contact` model, so the pre-save hook that
 * derives display names and normalised match keys runs exactly as it does in
 * production. Inserting raw documents would bypass it and leave duplicate
 * detection unable to see any of the seeded data.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Contact } from '../src/models/contact.model.js'
import { ContactGroup } from '../src/models/contactGroup.model.js'
import { User } from '../src/models/user.model.js'
import {
  CONTACT_CATEGORY,
  CONTACT_SOURCE,
  CONTACT_SYNC_STATUS,
  GROUP_COLORS,
} from '../src/modules/contacts/constants/contactConstants.js'
import { COMPANIES } from '../src/modules/contacts/providers/mock/mockContactData.js'

const out = (line = '') => process.stdout.write(`${line}\n`)
const rule = (char = '─') => out(char.repeat(72))

/** Mulberry32 — seedable, so the address book is reproducible. */
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

const FIRST_NAMES = [
  'Priya','Daniel','Sofia','Marcus','Aisha','Tom','Yuki','Elena','Rahul','Clara',
  'Mateo','Ingrid','Omar','Hannah','Kwame','Lucia','Nils','Fatima','Diego','Anya',
  'Sean','Mei','Viktor','Amara','Josef','Nadia','Callum','Ravi','Beatriz','Henrik',
  'Zara','Tobias','Leila','Andres','Freya','Idris','Camila','Bjorn','Noor','Emeka',
  'Sinead','Hiroshi','Valentina','Lars','Chidi','Rosa','Anton','Meera','Pia','Gustav',
]

const LAST_NAMES = [
  'Raman','Okafor','Almeida','Lindqvist','Haddad','Whitfield','Tanaka','Rossi',
  'Mehta','Bergström','Navarro','Sørensen','Farouk','Weber','Mensah','Delgado',
  'Andersen','Zaidi','Costa','Petrov','Gallagher','Chen','Novak','Adeyemi',
  'Fischer','Karim','Doherty','Iyer','Fonseca','Larsen','Moreau','Kowalski',
  'Silva','Vermeulen','Nakamura','Bianchi','Espinoza','Halvorsen','Byrne','Osei',
]

const JOB_TITLES = [
  'Procurement Manager','Head of Operations','Logistics Coordinator','Finance Director',
  'Account Manager','Supply Chain Analyst','Managing Director','Warehouse Supervisor',
  'Quality Assurance Lead','Commercial Manager','Export Coordinator','Category Buyer',
  'Regional Sales Lead','Compliance Officer','Customer Success Manager','Plant Manager',
]

const NOTES = [
  'Prefers email over phone. Responds within a working day.',
  'Main contact for the quarterly supply agreement.',
  'Handles customs documentation for EU shipments.',
  'Escalation point for delivery disputes.',
  'Introduced at the trade fair; follow up on pricing.',
  'Signs off on orders above 10,000 units.',
  'Out of office most Fridays.',
  'Prefers scheduled calls rather than ad-hoc.',
  'Renewal due at the end of the financial year.',
  'Requires purchase orders in advance of shipment.',
]

const TAG_POOL = [
  'key-account','supplier','logistics','finance','decision-maker',
  'follow-up','eu','apac','renewal','technical','warm-lead','dormant',
]

const CATEGORIES = Object.values(CONTACT_CATEGORY)

const GROUP_DEFINITIONS = [
  { name: 'Key Accounts', description: 'Highest-value customer relationships.' },
  { name: 'Suppliers', description: 'Upstream goods and materials.' },
  { name: 'Logistics Partners', description: 'Freight, customs and warehousing.' },
  { name: 'Finance Contacts', description: 'Accounts payable and receivable.' },
  { name: 'Decision Makers', description: 'Authority to sign off on contracts.' },
  { name: 'EU Region', description: 'Contacts inside the European Union.' },
  { name: 'APAC Region', description: 'Asia-Pacific contacts.' },
  { name: 'Renewals Q3', description: 'Agreements up for renewal this quarter.' },
  { name: 'Trade Fair Leads', description: 'Collected at industry events.' },
  { name: 'Dormant', description: 'No interaction in over six months.' },
]

const COUNTRY_CODES = {
  'United Kingdom':'44', Netherlands:'31', Portugal:'351', Sweden:'46', Ireland:'353',
  'United States':'1', Japan:'81', Italy:'39', Germany:'49', Australia:'61',
  Canada:'1', Norway:'47', Belgium:'32', India:'91',
}

async function main() {
  const args = process.argv.slice(2)
  const shouldReset = args.includes('--reset')
  const countIndex = args.indexOf('--count')
  const total = countIndex === -1 ? 500 : Math.max(1, Number(args[countIndex + 1]) || 500)

  out()
  rule('═')
  out('  SEEDING CONTACTS')
  rule('═')
  out(`  database : ${config.database.uri}`)
  out(`  contacts : ${total} across ${COMPANIES.length} companies in ${GROUP_DEFINITIONS.length} groups`)
  out()

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 5000 })

  // Attach to a real signed-in user when one exists, so the data appears in the UI.
  let user = await User.findOne().sort({ lastLoginAt: -1 })

  if (!user) {
    user = await User.findOneAndUpdate(
      { microsoftId: 'seed-contacts-user', tenantId: 'seed-contacts-tenant' },
      {
        $set: { displayName: 'Demo User', email: 'demo.user@contoso.com', lastLoginAt: new Date() },
        $setOnInsert: { microsoftId: 'seed-contacts-user', tenantId: 'seed-contacts-tenant' },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )
    out('  Created a demo user (no signed-in user was found).')
  }

  out(`  owner    : ${user.email ?? user.displayName} (${user._id})`)
  out()

  if (shouldReset) {
    // Only seeded records are removed — anything synced from a provider is left
    // alone, since deleting a user's real address book would be unforgivable.
    const [contacts, groups] = await Promise.all([
      Contact.deleteMany({ owner: user._id, source: { $in: [CONTACT_SOURCE.CRM, CONTACT_SOURCE.IMPORT] } }),
      ContactGroup.deleteMany({ owner: user._id, provider: null }),
    ])
    out(`  --reset: removed ${contacts.deletedCount} contacts and ${groups.deletedCount} groups.`)
    out()
  }

  const random = seededRandom(0x5eed_c0de)

  // --- Contacts ------------------------------------------------------------
  out('  Creating contacts…')

  const created = []
  const now = Date.now()

  for (let index = 0; index < total; index += 1) {
    const firstName = FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length)]
    const lastName = LAST_NAMES[Math.floor(random() * LAST_NAMES.length)]
    const company = COMPANIES[Math.floor(random() * COMPANIES.length)]
    const code = COUNTRY_CODES[company.country] ?? '44'

    // A numeric suffix keeps addresses unique across repeated name pairs, so the
    // seed does not itself become a pile of duplicates.
    const local = `${firstName}.${lastName}${index}`.toLowerCase().replace(/[^a-z0-9.]/g, '')

    const tags = []
    const tagCount = Math.floor(random() * 4)
    for (let t = 0; t < tagCount; t += 1) {
      const tag = TAG_POOL[Math.floor(random() * TAG_POOL.length)]
      if (!tags.includes(tag)) tags.push(tag)
    }

    const phone = () =>
      `+${code} ${String(Math.floor(random() * 900 + 100))} ${String(Math.floor(random() * 9000 + 1000))}`

    // Spread creation dates over a year so "recently added" is meaningful.
    const createdAt = new Date(now - Math.floor(random() * 365) * 86_400_000)

    created.push({
      owner: user._id,
      createdBy: user._id,
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      company: company.name,
      jobTitle: JOB_TITLES[Math.floor(random() * JOB_TITLES.length)],
      primaryEmail: `${local}@${company.domain}`,
      secondaryEmail: random() > 0.85 ? `${local}@gmail.com` : null,
      mobile: random() > 0.35 ? phone() : null,
      businessPhone: phone(),
      website: random() > 0.7 ? `https://www.${company.domain}` : null,
      address: `${1 + Math.floor(random() * 200)} ${lastName} Street`,
      city: company.city,
      country: company.country,
      postalCode: String(10_000 + Math.floor(random() * 89_999)),
      notes: random() > 0.55 ? NOTES[Math.floor(random() * NOTES.length)] : null,
      tags,
      category: CATEGORIES[Math.floor(random() * CATEGORIES.length)],
      favorite: random() < 0.12,
      birthday: new Date(Date.UTC(1962 + Math.floor(random() * 40), Math.floor(random() * 12), 1 + Math.floor(random() * 28))),
      lastInteraction: random() > 0.4 ? new Date(now - Math.floor(random() * 120) * 86_400_000) : null,
      source: CONTACT_SOURCE.CRM,
      syncStatus: CONTACT_SYNC_STATUS.LOCAL,
      createdAt,
    })
  }

  /**
   * Saved individually rather than with `insertMany`.
   *
   * `insertMany` bypasses the pre-save hook, so `matchEmails`, `matchPhones` and
   * `matchName` would all be empty and duplicate detection would find nothing in
   * the seeded data — which is precisely what a demo needs to demonstrate.
   */
  const saved = []
  for (const data of created) {
    saved.push(await new Contact(data).save())
  }

  out(`    ${saved.length} contacts created`)

  // --- Groups --------------------------------------------------------------
  out('  Creating groups…')

  const groups = []

  for (const [index, definition] of GROUP_DEFINITIONS.entries()) {
    // Membership is a deterministic slice, so groups have plausible, varied sizes.
    const size = 15 + Math.floor(random() * 40)
    const members = []

    for (let m = 0; m < size; m += 1) {
      const candidate = saved[Math.floor(random() * saved.length)]
      if (!members.some((id) => id.equals(candidate._id))) members.push(candidate._id)
    }

    const group = await ContactGroup.findOneAndUpdate(
      { owner: user._id, name: definition.name },
      {
        $set: {
          description: definition.description,
          color: GROUP_COLORS[index % GROUP_COLORS.length],
          members,
          memberCount: members.length,
          updatedBy: user._id,
        },
        $setOnInsert: { owner: user._id, name: definition.name, createdBy: user._id },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )

    groups.push(group)
    out(`    ${definition.name.padEnd(22)} ${members.length} members`)
  }

  // --- Summary -------------------------------------------------------------
  const [contactCount, favouriteCount, companyCount, groupCount] = await Promise.all([
    Contact.countDocuments({ owner: user._id, isDeleted: false }),
    Contact.countDocuments({ owner: user._id, isDeleted: false, favorite: true }),
    Contact.distinct('company', { owner: user._id, isDeleted: false }),
    ContactGroup.countDocuments({ owner: user._id, isDeleted: false }),
  ])

  out()
  rule()
  out('  RESULT')
  rule()
  out(`  contacts  : ${contactCount}`)
  out(`  favorites : ${favouriteCount}`)
  out(`  companies : ${companyCount.filter(Boolean).length}`)
  out(`  groups    : ${groupCount}`)
  out()
  out('  Open the app and visit /contacts to see it.')
  out()

  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  out(`\n  SEED FAILED: ${error?.message}`)
  out(error?.stack?.split('\n').slice(1, 4).join('\n') ?? '')
} finally {
  out('═'.repeat(72))
  await mongoose.disconnect().catch(() => {})
}

process.exit(exitCode)
