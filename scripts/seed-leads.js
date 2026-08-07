#!/usr/bin/env node
/**
 * Seeds a realistic travel sales register.
 *
 * Run with:  npm run seed:leads [-- --reset] [-- --leads 600]
 *
 * Builds the hierarchy the real workbook demonstrates: a few dozen agencies,
 * several people at each, and many enquiries per person — including one very
 * busy account, because that is the shape that breaks naive designs and the
 * demo should show it.
 *
 * Deterministic: the same run produces the same register.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Company, companyMatchKey, organisationDomain } from '../src/models/company.model.js'
import { Contact } from '../src/models/contact.model.js'
import { Lead } from '../src/models/lead.model.js'
import { User } from '../src/models/user.model.js'
import {
  COMPANY_STATUS,
  LEAD_STAGE,
  MARKET,
} from '../src/modules/leads/constants/leadConstants.js'

const out = (line = '') => process.stdout.write(`${line}\n`)
const rule = (char = '─') => out(char.repeat(72))

/** Mulberry32 — seedable, so the register is reproducible. */
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

const DAY_MS = 86_400_000

/** Agencies, in the shape the workbook shows: a domain, a city, a size. */
const AGENCIES = [
  { name: 'Flamingo Travels', domain: 'flamingotravels.co.in', city: 'Ahmedabad', people: 5, weight: 24 },
  { name: 'Gem Travels', domain: 'gemtravels.com', city: 'Mumbai', people: 3, weight: 18 },
  { name: 'Heena Tours', domain: 'heenatours.in', city: 'Surat', people: 4, weight: 12 },
  { name: 'Akbar Holidays', domain: 'akbarholidays.com', city: 'Mumbai', people: 6, weight: 10 },
  { name: 'EZ Holidays', domain: 'ezholidays.in', city: 'Ahmedabad', people: 2, weight: 8 },
  { name: 'Kesari Tours', domain: 'kesari.in', city: 'Pune', people: 4, weight: 7 },
  { name: 'Hallmark Elite', domain: 'hallmarkelite.com', city: 'Chennai', people: 3, weight: 6 },
  { name: 'Frontier Holidays', domain: 'frontierholidays.com', city: 'New Delhi', people: 3, weight: 6 },
  { name: 'Tirupati Holidays', domain: 'tirupatiholidays.net', city: 'Jaipur', people: 2, weight: 5 },
  { name: 'Parikh Holidays', domain: 'parikhholidays.com', city: 'Ahmedabad', people: 2, weight: 5 },
  { name: 'Believe Tours & Travels', domain: 'believetoursandtravels.com', city: 'Ahmedabad', people: 2, weight: 4 },
  { name: 'Destination Hub', domain: 'destinationhub.uk', city: 'Mumbai', people: 1, weight: 4 },
  { name: 'Freedom Tourism', domain: 'freedomtourism.com', city: 'Surat', people: 3, weight: 4 },
  { name: 'Vishwacation', domain: 'vishwacation.com', city: 'Nagpur', people: 2, weight: 3 },
  { name: 'Splendid Holidays', domain: null, city: 'Rajkot', people: 1, weight: 3 },
  { name: 'Jineshwar Tours', domain: null, city: 'Ahmedabad', people: 1, weight: 2 },
  { name: 'Amigo Travels', domain: 'amigotravels.com', city: 'Hyderabad', people: 2, weight: 3 },
  { name: 'Happening Holidays', domain: 'happeningholidays.com', city: 'Mumbai', people: 2, weight: 3 },
  { name: 'White Holidays', domain: 'whiteholidays.net', city: 'Kolkata', people: 1, weight: 2 },
  { name: 'My Value Trip', domain: 'myvaluetrip.com', city: 'Bengaluru', people: 2, weight: 3 },
]

const FIRST_NAMES = [
  'Pooja', 'Dhruvin', 'Alpa', 'Avni', 'Vishal', 'Krina', 'Mukesh', 'Shreya', 'Neel',
  'Nidhi', 'Neha', 'Vipul', 'Kalpraj', 'Kishan', 'Bijal', 'Rizwan', 'Priya', 'Aditi',
  'Vyoma', 'Ramesh', 'Venkatesh', 'Anju', 'Rajiv', 'Anjali', 'Gaurav', 'Kaushik',
]

const LAST_NAMES = [
  'Shah', 'Patel', 'Rawlani', 'Thakor', 'Nishar', 'Lainingwala', 'Barot', 'Desai',
  'Khandelwal', 'Maurya', 'Trivedi', 'Mehta', 'Vithlani', 'Sojatwala', 'Mahulkar',
  'Peliwal', 'Kurian', 'Punjabi', 'Pandya', 'Kumar', 'Agarwal', 'Raman',
]

const CITIES = [
  'Ahmedabad', 'Mumbai', 'Surat', 'Chennai', 'New Delhi', 'Pune', 'Jaipur', 'Hyderabad',
  'Bengaluru', 'Kolkata', 'Nagpur', 'Rajkot', 'Vadodara', 'Indore', 'Kochi',
]

const PAX_SHAPES = ['2A', '4A', '2A + 2 C', '6 Pax', '15-35 Pax', '2 Pax', '10 A 1 C', '100 Pax', '3 Adults']

/** Prose travel dates, as the real sheet carries them. */
const TRAVEL_TEXTS = ['August', 'June End', 'Low Season', 'Oct ’25 - Mar ’26', 'April-May']

const HANDLERS = ['MP', 'HK', 'RS', 'AT']

const REMARKS = [
  'still waiting for customers reply',
  'client changed destination to Singapore',
  'quotation sent, awaiting confirmation',
  'visa documents pending from client',
  'budget too high, revised quote sent',
  null, null, null,
]

/**
 * Stage distribution.
 *
 * Weighted like a real quarter: most enquiries sit early, a handful convert,
 * a few die. A register where everything is `booked` teaches nothing.
 */
const STAGE_WEIGHTS = [
  [LEAD_STAGE.NEW, 34],
  [LEAD_STAGE.QUOTED, 20],
  [LEAD_STAGE.FOLLOW_UP, 14],
  [LEAD_STAGE.INTERESTED, 8],
  [LEAD_STAGE.NEGOTIATION, 6],
  [LEAD_STAGE.VISA_PROCESS, 4],
  [LEAD_STAGE.BOOKED, 5],
  [LEAD_STAGE.COMPLETED, 4],
  [LEAD_STAGE.CANCELLED, 2],
  [LEAD_STAGE.LOST, 3],
]

function pickWeighted(entries, random) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = random() * total
  for (const [value, weight] of entries) {
    roll -= weight
    if (roll <= 0) return value
  }
  return entries.at(-1)[0]
}

async function main() {
  const args = process.argv.slice(2)
  const shouldReset = args.includes('--reset')
  const leadsIndex = args.indexOf('--leads')
  const targetLeads = leadsIndex === -1 ? 600 : Math.max(10, Number(args[leadsIndex + 1]) || 600)

  out()
  rule('═')
  out('  SEEDING THE TRAVEL SALES REGISTER')
  rule('═')
  out(`  database : ${config.database.uri}`)
  out(`  target   : ${targetLeads} enquiries across ${AGENCIES.length} agencies`)
  out()

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 5000 })

  let user = await User.findOne().sort({ lastLoginAt: -1 })

  if (!user) {
    user = await User.findOneAndUpdate(
      { microsoftId: 'seed-leads-user', tenantId: 'seed-leads-tenant' },
      {
        $set: { displayName: 'Demo User', email: 'demo.user@contoso.com', lastLoginAt: new Date() },
        $setOnInsert: { microsoftId: 'seed-leads-user', tenantId: 'seed-leads-tenant' },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    )
    out('  Created a demo user (no signed-in user was found).')
  }

  const owner = user._id
  out(`  owner    : ${user.email ?? user.displayName} (${owner})`)
  out()

  if (shouldReset) {
    const [leads, companies, contacts] = await Promise.all([
      Lead.deleteMany({ owner }),
      Company.deleteMany({ owner }),
      Contact.deleteMany({ owner, source: 'import', leadCount: { $gt: 0 } }),
    ])
    out(
      `  --reset: removed ${leads.deletedCount} leads, ${companies.deletedCount} companies ` +
        `and ${contacts.deletedCount} seeded contacts.`,
    )
    out()
  }

  const random = seededRandom(0x7ea_d5ee)
  const now = Date.now()

  // --- Companies and their people -----------------------------------------
  out('  Creating agencies and their people…')

  const roster = []

  for (const agency of AGENCIES) {
    const sampleEmail = agency.domain ? `info@${agency.domain}` : null
    const matchKey = companyMatchKey({ email: sampleEmail, name: agency.name })

    const company = await Company.findOneAndUpdate(
      { owner, matchKey },
      {
        $setOnInsert: {
          owner,
          createdBy: owner,
          matchKey,
          companyName: agency.name,
          emailDomain: organisationDomain(sampleEmail),
          city: agency.city,
          country: 'India',
          status: COMPANY_STATUS.ACTIVE,
          isDeleted: false,
        },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    )

    const people = []

    for (let index = 0; index < agency.people; index += 1) {
      const firstName = FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length)]
      const lastName = LAST_NAMES[Math.floor(random() * LAST_NAMES.length)]
      const handle = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${index || ''}`
      const email = agency.domain
        ? `${handle}@${agency.domain}`
        : `${handle}.${agency.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8)}@gmail.com`

      const contact = await Contact.findOneAndUpdate(
        { owner, primaryEmail: email },
        {
          $setOnInsert: {
            owner,
            primaryEmail: email,
            firstName,
            lastName,
            displayName: `${firstName} ${lastName}`,
            company: agency.name,
            companyId: company._id,
            phone: `9${Math.floor(random() * 900_000_000 + 100_000_000)}`,
            city: agency.city,
            source: 'import',
            leadSource: agency.name,
            isDeleted: false,
          },
        },
        { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
      )

      people.push(contact)
    }

    roster.push({ agency, company, people })
  }

  out(`    ${roster.length} agencies, ${roster.reduce((n, r) => n + r.people.length, 0)} people`)

  // --- Enquiries ------------------------------------------------------------
  out('  Creating enquiries…')

  const weightedRoster = roster.flatMap((entry) => Array.from({ length: entry.agency.weight }, () => entry))

  const documents = []
  let auCounter = 0
  let nzCounter = 0

  for (let index = 0; index < targetLeads; index += 1) {
    const entry = weightedRoster[Math.floor(random() * weightedRoster.length)]
    const person = entry.people[Math.floor(random() * entry.people.length)]

    const isNz = random() < 0.12
    const market = isNz ? MARKET.NZ : MARKET.AU
    const reference = isNz ? `XNMP${(nzCounter += 1)}` : `XAMP${(auCounter += 1)}`

    const ageDays = Math.floor(random() * 540)
    const quoteDate = new Date(now - ageDays * DAY_MS)

    // A fifth of travel dates are prose, as in the real sheet.
    const proseDate = random() < 0.2
    const travelDate = proseDate ? null : new Date(quoteDate.getTime() + (30 + Math.floor(random() * 300)) * DAY_MS)
    const travelDateText = proseDate ? TRAVEL_TEXTS[Math.floor(random() * TRAVEL_TEXTS.length)] : null

    const paxText = PAX_SHAPES[Math.floor(random() * PAX_SHAPES.length)]
    const adultMatch = /(\d+)\s*a(?![a-z])/i.exec(paxText) ?? /^(\d+)/.exec(paxText)
    const childMatch = /(\d+)\s*c(?![a-z])/i.exec(paxText)

    const stage = pickWeighted(STAGE_WEIGHTS, random)

    documents.push({
      owner,
      createdBy: owner,
      reference,
      market,
      company: entry.company._id,
      contact: person._id,
      contactPerson: person.displayName,
      companyName: entry.agency.name,
      email: person.primaryEmail,
      phones: person.phone ? [person.phone] : [],
      quoteDate,
      travelDate,
      travelDateText,
      city: random() < 0.75 ? entry.agency.city : CITIES[Math.floor(random() * CITIES.length)],
      paxText,
      adultCount: adultMatch ? Number(adultMatch[1]) : null,
      childCount: childMatch ? Number(childMatch[1]) : null,
      stage,
      stageHistory: [{ to: stage, at: quoteDate, by: owner, reason: 'Seeded' }],
      handledBy: random() < 0.35 ? HANDLERS[Math.floor(random() * HANDLERS.length)] : null,
      internalNotes: REMARKS[Math.floor(random() * REMARKS.length)],
      sourceSheet: isNz ? 'Primary Sheet NZ' : 'Primary Sheet AU',
      sourceRow: index + 2,
      createdAt: quoteDate,
    })
  }

  // `insertMany` is safe here: `Lead` has no document middleware that derives
  // fields, unlike `Contact`, whose pre-save hook builds the match keys.
  const inserted = await Lead.insertMany(documents, { ordered: false })
  out(`    ${inserted.length} enquiries`)

  // --- Roll-ups -------------------------------------------------------------
  out('  Recomputing roll-ups…')

  for (const entry of roster) {
    await entry.company.recount()
    for (const person of entry.people) {
      person.leadCount = await Lead.countDocuments({ contact: person._id, isDeleted: false })
      await person.save()
    }
  }

  // --- Report ---------------------------------------------------------------
  const byStage = await Lead.aggregate([
    { $match: { owner, isDeleted: false } },
    { $group: { _id: '$stage', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ])

  const busiest = await Company.findOne({ owner, isDeleted: false }).sort({ leadCount: -1 })

  out()
  rule()
  out('  RESULT')
  rule()
  out(`  companies : ${await Company.countDocuments({ owner, isDeleted: false })}`)
  out(`  contacts  : ${await Contact.countDocuments({ owner, isDeleted: false, companyId: { $ne: null } })}`)
  out(`  leads     : ${await Lead.countDocuments({ owner, isDeleted: false })}`)
  out()
  for (const row of byStage) out(`      ${String(row._id).padEnd(14)} ${row.count}`)
  out()
  if (busiest) {
    out(`  busiest   : ${busiest.companyName} — ${busiest.contactCount} people, ${busiest.leadCount} enquiries`)
  }
  out()
  out('  Open the app and visit /leads to see it.')
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
