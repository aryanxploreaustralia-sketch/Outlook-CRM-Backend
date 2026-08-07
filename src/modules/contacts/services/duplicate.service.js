/**
 * Duplicate detection and merging.
 *
 * ## Confidence, not booleans
 *
 * "Is this a duplicate?" has no yes/no answer. Two records sharing a provider id
 * are certainly the same contact; two sharing a display name almost certainly
 * are not — "John Smith" is not evidence. Treating both as "duplicate" would
 * either merge strangers or bury real matches under noise.
 *
 * Every match therefore carries a strategy and a confidence, and only matches at
 * or above `AUTO_MERGE_THRESHOLD` are acted on automatically. Weaker ones are
 * reported for a human to decide, which is the honest outcome.
 *
 * ## Detection is a query, not a scan
 *
 * All four strategies resolve to indexed lookups on the normalised `match*`
 * fields. Comparing in application code would mean loading a user's entire
 * address book to import one row.
 */

import { Contact, normaliseEmail, normaliseName, normalisePhone } from '../../../models/contact.model.js'
import {
  AUTO_MERGE_THRESHOLD,
  MATCH_CONFIDENCE,
  MATCH_STRATEGY,
  MERGE_STRATEGY,
} from '../constants/contactConstants.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('contact-duplicates')

/**
 * Fields a merge may copy from one contact onto another.
 *
 * Deliberately excludes `owner`, `source`, `provider`, `providerContactId` and
 * every timestamp: those describe *where a record came from*, and copying them
 * would make a merged contact claim an origin that is not its own.
 */
const MERGEABLE_FIELDS = Object.freeze([
  'firstName',
  'lastName',
  'displayName',
  'company',
  'jobTitle',
  'primaryEmail',
  'secondaryEmail',
  'phone',
  'mobile',
  'businessPhone',
  'website',
  'address',
  'city',
  'state',
  'country',
  'postalCode',
  'notes',
  'birthday',
])

/**
 * Finds existing contacts that may be the same person.
 *
 * Strategies run strongest-first and results are de-duplicated by contact id,
 * keeping the highest-confidence explanation for each.
 *
 * @param {object} params
 * @param {object} params.candidate A contact-shaped object (not necessarily saved).
 * @param {import('mongoose').Types.ObjectId} params.owner
 * @param {?import('mongoose').Types.ObjectId} [params.excludeId] Ignore this contact — used when re-checking an existing record.
 * @returns {Promise<Array<{ contact: object, strategy: string, confidence: number, matchedOn: string }>>}
 */
export async function findDuplicates({ candidate, owner, excludeId = null }) {
  /** @type {Map<string, { contact: object, strategy: string, confidence: number, matchedOn: string }>} */
  const found = new Map()

  const baseFilter = { owner, isDeleted: false }
  if (excludeId) baseFilter._id = { $ne: excludeId }

  const record = (contact, strategy, matchedOn) => {
    const id = contact._id.toString()
    const confidence = MATCH_CONFIDENCE[strategy]
    const existing = found.get(id)

    // Keep the strongest explanation when a contact matches several ways.
    if (!existing || confidence > existing.confidence) {
      found.set(id, { contact, strategy, confidence, matchedOn })
    }
  }

  // --- 1. Provider id — an exact identity claim ----------------------------
  if (candidate.providerContactId && candidate.provider) {
    const matches = await Contact.find({
      ...baseFilter,
      provider: candidate.provider,
      providerContactId: candidate.providerContactId,
    })

    for (const match of matches) {
      record(match, MATCH_STRATEGY.PROVIDER_ID, candidate.providerContactId)
    }
  }

  // --- 2. Email — very nearly an identity claim ----------------------------
  const emails = [candidate.primaryEmail, candidate.secondaryEmail]
    .map(normaliseEmail)
    .filter(Boolean)

  if (emails.length > 0) {
    const matches = await Contact.find({ ...baseFilter, matchEmails: { $in: emails } })

    for (const match of matches) {
      const shared = match.matchEmails.find((email) => emails.includes(email))
      record(match, MATCH_STRATEGY.EMAIL, shared ?? emails[0])
    }
  }

  // --- 3. Phone — weaker; households and switchboards are shared -----------
  const phones = [candidate.mobile, candidate.businessPhone, candidate.phone]
    .map(normalisePhone)
    .filter(Boolean)

  if (phones.length > 0) {
    const matches = await Contact.find({ ...baseFilter, matchPhones: { $in: phones } })

    for (const match of matches) {
      const shared = match.matchPhones.find((phone) => phones.includes(phone))
      record(match, MATCH_STRATEGY.PHONE, shared ?? phones[0])
    }
  }

  // --- 4. Display name — the weakest signal, never auto-merged -------------
  const name = normaliseName(candidate.displayName)

  if (name) {
    const matches = await Contact.find({ ...baseFilter, matchName: name })

    for (const match of matches) {
      record(match, MATCH_STRATEGY.DISPLAY_NAME, name)
    }
  }

  return [...found.values()].sort((a, b) => b.confidence - a.confidence)
}

/**
 * The single best match, if one is confident enough to act on.
 *
 * @returns {Promise<?object>} `{ contact, strategy, confidence, matchedOn }`
 */
export async function findAutoMergeTarget({ candidate, owner, excludeId = null }) {
  const duplicates = await findDuplicates({ candidate, owner, excludeId })
  const best = duplicates[0]

  if (!best || best.confidence < AUTO_MERGE_THRESHOLD) return null

  return best
}

/**
 * Combines two contacts field by field.
 *
 * Returns a plain object of changes rather than mutating, so a caller can show
 * a preview before committing — merging is destructive and a user should be able
 * to see what it would do.
 *
 * @param {object} params
 * @param {object} params.existing The record being kept.
 * @param {object} params.incoming The record being folded in.
 * @param {string} [params.strategy] One of MERGE_STRATEGY.
 * @returns {{ changes: object, conflicts: Array<{ field: string, existing: *, incoming: * }> }}
 */
export function mergeContacts({ existing, incoming, strategy = MERGE_STRATEGY.FIELD_UNION }) {
  const changes = {}
  const conflicts = []

  for (const field of MERGEABLE_FIELDS) {
    const currentValue = existing[field] ?? null
    const incomingValue = incoming[field] ?? null

    if (incomingValue === null || incomingValue === '') continue
    if (currentValue === incomingValue) continue

    if (currentValue === null || currentValue === '') {
      // Filling a blank is never a conflict — it is the whole point of merging.
      changes[field] = incomingValue
      continue
    }

    // Both sides hold a different, non-empty value. That is a real conflict.
    conflicts.push({ field, existing: currentValue, incoming: incomingValue })

    if (strategy === MERGE_STRATEGY.REMOTE_WINS) {
      changes[field] = incomingValue
    }
    // LOCAL_WINS and FIELD_UNION both keep the existing value; MANUAL records
    // the conflict without resolving it.
  }

  // --- Set-valued fields are unioned, never replaced ------------------------
  //
  // Tags and group membership are additive by nature: a merge that dropped tags
  // the user had applied would lose information the provider never had.
  if (Array.isArray(incoming.tags) && incoming.tags.length > 0) {
    const union = [...new Set([...(existing.tags ?? []), ...incoming.tags])]
    if (union.length !== (existing.tags ?? []).length) changes.tags = union
  }

  // Favourite is sticky: if either record was starred, the merged one is.
  if (incoming.favorite && !existing.favorite) changes.favorite = true

  // The more recent interaction wins, since both describe the same person.
  if (incoming.lastInteraction) {
    const currentInteraction = existing.lastInteraction?.getTime?.() ?? 0
    if (new Date(incoming.lastInteraction).getTime() > currentInteraction) {
      changes.lastInteraction = incoming.lastInteraction
    }
  }

  return { changes, conflicts }
}

/**
 * Applies a merge and soft-deletes the record that was folded in.
 *
 * The absorbed contact is **soft**-deleted, not removed: a merge is a judgement
 * call, and an incorrect one must be recoverable. `mergedInto` records where its
 * data went.
 *
 * @returns {Promise<{ contact: object, conflicts: Array, absorbedId: string }>}
 */
export async function applyMerge({ keepId, absorbId, owner, strategy, updatedBy = null }) {
  const [keep, absorb] = await Promise.all([
    Contact.findOne({ _id: keepId, owner }),
    Contact.findOne({ _id: absorbId, owner }),
  ])

  if (!keep || !absorb) {
    throw new Error('Both contacts must exist and belong to the same owner.')
  }

  const { changes, conflicts } = mergeContacts({
    existing: keep,
    incoming: absorb,
    strategy,
  })

  Object.assign(keep, changes)
  keep.updatedBy = updatedBy
  await keep.save()

  absorb.isDeleted = true
  absorb.deletedAt = new Date()
  absorb.notes = [absorb.notes, `Merged into contact ${keep._id}.`].filter(Boolean).join('\n')
  await absorb.save()

  log.info('Contacts merged', {
    keptId: keep._id.toString(),
    absorbedId: absorb._id.toString(),
    fieldsChanged: Object.keys(changes).length,
    conflicts: conflicts.length,
    strategy,
  })

  return { contact: keep, conflicts, absorbedId: absorb._id.toString() }
}

/**
 * Groups a user's whole address book into duplicate clusters.
 *
 * Powers the "review duplicates" screen. Runs a single pass over the normalised
 * match keys rather than comparing every pair, which would be O(n²) and
 * unusable at a few thousand contacts.
 *
 * @returns {Promise<Array<{ strategy: string, confidence: number, key: string, contacts: object[] }>>}
 */
export async function findDuplicateClusters({ owner, limit = 100 }) {
  const clusters = []

  /** One aggregation per strategy, strongest first. */
  const passes = [
    { field: '$matchEmails', strategy: MATCH_STRATEGY.EMAIL, unwind: true },
    { field: '$matchPhones', strategy: MATCH_STRATEGY.PHONE, unwind: true },
    { field: '$matchName', strategy: MATCH_STRATEGY.DISPLAY_NAME, unwind: false },
  ]

  const seen = new Set()

  for (const pass of passes) {
    const pipeline = [{ $match: { owner, isDeleted: false } }]

    if (pass.unwind) pipeline.push({ $unwind: pass.field })

    pipeline.push(
      { $group: { _id: pass.field, ids: { $addToSet: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 }, _id: { $ne: null } } },
      { $limit: limit },
    )

    const groups = await Contact.aggregate(pipeline)

    for (const group of groups) {
      // A cluster already reported by a stronger strategy is not repeated.
      const signature = group.ids.map((id) => id.toString()).sort().join(':')
      if (seen.has(signature)) continue
      seen.add(signature)

      const contacts = await Contact.find({ _id: { $in: group.ids } })

      clusters.push({
        strategy: pass.strategy,
        confidence: MATCH_CONFIDENCE[pass.strategy],
        key: group._id,
        contacts: contacts.map((contact) => contact.toSummaryJSON()),
      })
    }
  }

  return clusters.sort((a, b) => b.confidence - a.confidence)
}

export default {
  findDuplicates,
  findAutoMergeTarget,
  mergeContacts,
  applyMerge,
  findDuplicateClusters,
}
