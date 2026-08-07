#!/usr/bin/env node
/**
 * Backfills the Company entity for data created before Phase 8.
 *
 * Run with:  npm run backfill:companies [-- --dry-run]
 *
 * Contacts imported in Phase 6 and 7 carry the employer as a **string** in
 * `company` and have no `companyId`. This groups them by the same key the
 * importer uses — email domain first, normalised trading name as the fallback —
 * creates the missing Company records and links them.
 *
 * ## What it deliberately does not do
 *
 * It creates no leads. A Phase 6 contact has no enquiry behind it: there is no
 * reference, no quotation date, no party size. Fabricating a lead from a bare
 * contact would put a made-up enquiry into the pipeline and the conversion
 * figures, which is worse than leaving the history thin.
 *
 * Idempotent: running it twice links nothing new and creates no duplicates.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Company, companyMatchKey, organisationDomain } from '../src/models/company.model.js'
import { Contact } from '../src/models/contact.model.js'
import { Lead } from '../src/models/lead.model.js'
import { User } from '../src/models/user.model.js'
import { COMPANY_STATUS } from '../src/modules/leads/constants/leadConstants.js'

const out = (line = '') => process.stdout.write(`${line}\n`)
const rule = (char = '─') => out(char.repeat(72))

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  out()
  rule('═')
  out(`  BACKFILL COMPANIES${dryRun ? '  (dry run — nothing will be written)' : ''}`)
  rule('═')
  out(`  database : ${config.database.uri}`)
  out()

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 5000 })

  const users = await User.find().select('_id email displayName')
  out(`  users: ${users.length}`)

  let totalCompanies = 0
  let totalLinked = 0
  let totalUnresolvable = 0

  for (const user of users) {
    const owner = user._id

    const contacts = await Contact.find({
      owner,
      isDeleted: false,
      companyId: null,
    }).select('_id primaryEmail company displayName city')

    if (contacts.length === 0) continue

    out()
    out(`  ${user.email ?? user.displayName ?? owner}`)
    out(`    contacts without a company link: ${contacts.length}`)

    /** matchKey -> { name, domain, city, contacts[] } */
    const groups = new Map()
    let unresolvable = 0

    for (const contact of contacts) {
      const matchKey = companyMatchKey({ email: contact.primaryEmail, name: contact.company })

      if (!matchKey) {
        // No organisational domain and no company name: nothing identifies an
        // employer, and inventing one would create a junk record.
        unresolvable += 1
        continue
      }

      if (!groups.has(matchKey)) {
        groups.set(matchKey, {
          name: contact.company || organisationDomain(contact.primaryEmail) || 'Unknown company',
          domain: organisationDomain(contact.primaryEmail),
          city: contact.city ?? null,
          contacts: [],
        })
      }

      groups.get(matchKey).contacts.push(contact._id)
    }

    out(`    distinct companies: ${groups.size}`)
    out(`    unresolvable (no domain, no name): ${unresolvable}`)
    totalUnresolvable += unresolvable

    if (dryRun) {
      const sample = [...groups.entries()].slice(0, 5)
      for (const [key, group] of sample) {
        out(`      ${key.padEnd(42)} ${group.contacts.length} contact(s)  "${group.name}"`)
      }
      if (groups.size > 5) out(`      … and ${groups.size - 5} more`)
      continue
    }

    for (const [matchKey, group] of groups) {
      const company = await Company.findOneAndUpdate(
        { owner, matchKey },
        {
          $setOnInsert: {
            owner,
            createdBy: owner,
            matchKey,
            companyName: group.name,
            emailDomain: group.domain,
            city: group.city,
            status: COMPANY_STATUS.ACTIVE,
            isDeleted: false,
          },
        },
        { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
      )

      const wasCreated = company.createdAt.getTime() === company.updatedAt.getTime()
      if (wasCreated) totalCompanies += 1

      const linked = await Contact.updateMany(
        { _id: { $in: group.contacts } },
        { $set: { companyId: company._id } },
      )
      totalLinked += linked.modifiedCount

      // Any leads already pointing at these contacts gain the company too.
      await Lead.updateMany(
        { owner, contact: { $in: group.contacts }, company: null },
        { $set: { company: company._id } },
      )

      await company.recount()
    }

    out(`    linked.`)
  }

  // Contact lead counts, for anything the importer has not already set.
  if (!dryRun) {
    out()
    out('  Recounting contact enquiry totals…')

    const stale = await Contact.find({ isDeleted: false, leadCount: 0 }).select('_id')
    let updated = 0

    for (const contact of stale) {
      const count = await Lead.countDocuments({ contact: contact._id, isDeleted: false })
      if (count > 0) {
        await Contact.updateOne({ _id: contact._id }, { $set: { leadCount: count } })
        updated += 1
      }
    }

    out(`    updated ${updated} contact(s).`)
  }

  out()
  rule()
  out('  RESULT')
  rule()
  out(`  companies created : ${totalCompanies}`)
  out(`  contacts linked   : ${totalLinked}`)
  out(`  unresolvable      : ${totalUnresolvable}  (left unlinked on purpose)`)
  if (dryRun) out('\n  Dry run — nothing was written. Re-run without --dry-run to apply.')
  out()

  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  out(`\n  BACKFILL FAILED: ${error?.message}`)
  out(error?.stack?.split('\n').slice(1, 4).join('\n') ?? '')
} finally {
  out('═'.repeat(72))
  await mongoose.disconnect().catch(() => {})
}

process.exit(exitCode)
