/**
 * Campaign orchestration: building an audience, launching, and control.
 *
 * Sits between the controllers and the queue. Everything that changes a
 * campaign's shape or state happens here, so the rules — who can be a recipient,
 * when a campaign may launch, what pausing means — live in one place.
 */

import { Campaign } from '../../../models/campaign.model.js'
import { CampaignEvent } from '../../../models/campaignEvent.model.js'
import { CampaignRecipient } from '../../../models/campaignRecipient.model.js'
import { CampaignTemplate } from '../../../models/campaignTemplate.model.js'
import { Contact } from '../../../models/contact.model.js'
import { ContactGroup } from '../../../models/contactGroup.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import * as contactRepo from '../../contacts/repositories/contact.repository.js'
import {
  ACTIVE_STATUSES,
  CAMPAIGN_EVENT,
  CAMPAIGN_STATUS,
  RECIPIENT_STATUS,
} from '../constants/campaignConstants.js'
import { checkTemplate, renderMessage } from './personalisation.service.js'
import { clampThrottle } from './throttle.service.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('campaign')

/** Recipients inserted per batch when building a large audience. */
const AUDIENCE_CHUNK = 500

/**
 * Resolves an audience definition to contact ids.
 *
 * Every source contributes to one set, so a campaign can target "everyone in
 * the Suppliers group, plus anyone tagged vip, plus these three people" in one
 * definition. Deduplication is inherent to the Set — the same contact appearing
 * via two sources must not receive two copies.
 *
 * @param {object} params
 * @returns {Promise<{ contactIds: string[], excluded: number }>}
 */
export async function resolveAudience({ owner, audience }) {
  const ids = new Set()

  if (audience.contactIds?.length) {
    // Verified against the owner's contacts: an unchecked id list would let a
    // caller mail someone else's address book.
    const verified = await Contact.find({
      _id: { $in: audience.contactIds },
      owner,
      isDeleted: false,
    }).select('_id')

    for (const contact of verified) ids.add(contact._id.toString())
  }

  if (audience.groupIds?.length) {
    const groups = await ContactGroup.find({
      _id: { $in: audience.groupIds },
      owner,
      isDeleted: false,
    })

    for (const group of groups) {
      for (const member of group.members) ids.add(member.toString())
    }
  }

  if (audience.filter && Object.keys(audience.filter).length > 0) {
    // Reuses the contacts repository, so campaign targeting and the contacts
    // list can never disagree about what a filter means.
    const { items } = await contactRepo.list({
      owner,
      ...audience.filter,
      page: 1,
      limit: 50_000,
    })

    for (const contact of items) ids.add(contact.id)
  }

  if (audience.importJobId) {
    const imported = await Contact.find({
      owner,
      importJob: audience.importJobId,
      isDeleted: false,
    }).select('_id')

    for (const contact of imported) ids.add(contact._id.toString())
  }

  /**
   * Lead-register criteria.
   *
   * Delegated to the lead service, which applies the campaign-eligibility rule:
   * a booked, completed, cancelled or lost enquiry can never be targeted, and
   * enforcing that in one place means no caller can route around it.
   */
  if (audience.leadCriteria && Object.keys(audience.leadCriteria).length > 0) {
    const { resolveLeadAudience } = await import('../../leads/services/lead.service.js')
    const resolved = await resolveLeadAudience({ owner, criteria: audience.leadCriteria })

    for (const contactId of resolved.contactIds) ids.add(contactId.toString())
  }

  // Exclusions last, so removing someone by hand always wins.
  const excludedIds = new Set((audience.excludedContactIds ?? []).map(String))
  let excluded = 0

  for (const id of excludedIds) {
    if (ids.delete(id)) excluded += 1
  }

  return { contactIds: [...ids], excluded }
}

/**
 * Materialises the recipient list.
 *
 * Contacts with no email, or marked do-not-contact, are filtered out here rather
 * than skipped at send time — a campaign should report an honest recipient count
 * up front, not one that shrinks as it runs.
 *
 * @returns {Promise<{ created: number, skipped: object }>}
 */
export async function buildRecipients({ campaign, owner }) {
  const { contactIds } = await resolveAudience({ owner, audience: campaign.audience })

  const skipped = { noEmail: 0, doNotContact: 0, alreadyPresent: 0 }
  let created = 0

  /**
   * Contacts already on this campaign are excluded up front.
   *
   * The unique index on `(campaign, contact)` is the ultimate guarantee, but it
   * cannot be the only one: Mongoose builds indexes in the background, so on a
   * freshly-created collection an insert can land before the index exists. That
   * is exactly the window a rebuild hits, and the symptom is duplicate
   * recipients — which means someone receives the campaign twice.
   */
  const existing = await CampaignRecipient.find({ campaign: campaign._id }).select('contact')
  const alreadyOn = new Set(existing.map((recipient) => recipient.contact.toString()))

  for (let start = 0; start < contactIds.length; start += AUDIENCE_CHUNK) {
    const slice = contactIds.slice(start, start + AUDIENCE_CHUNK)

    const contacts = await Contact.find({ _id: { $in: slice }, owner, isDeleted: false }).select(
      '_id primaryEmail leadStatus displayName',
    )

    const documents = []

    for (const contact of contacts) {
      if (alreadyOn.has(contact._id.toString())) { skipped.alreadyPresent += 1; continue }
      if (!contact.primaryEmail) { skipped.noEmail += 1; continue }
      if (contact.leadStatus === 'do_not_contact') { skipped.doNotContact += 1; continue }

      alreadyOn.add(contact._id.toString())

      documents.push({
        campaign: campaign._id,
        owner,
        contact: contact._id,
        email: contact.primaryEmail,
        status: RECIPIENT_STATUS.QUEUED,
      })
    }

    if (documents.length === 0) continue

    try {
      /**
       * `ordered: false` so a contact already on the campaign — caught by the
       * unique index — does not abandon the rest of the batch. Re-adding an
       * audience is a normal thing to do while building.
       */
      const inserted = await CampaignRecipient.insertMany(documents, { ordered: false })
      created += inserted.length
    } catch (error) {
      const insertedCount = error?.insertedDocs?.length ?? 0
      created += insertedCount
      skipped.alreadyPresent += documents.length - insertedCount
    }
  }

  await campaign.recomputeStats()

  log.info('Campaign audience built', {
    campaignId: campaign._id.toString(),
    resolved: contactIds.length,
    created,
    ...skipped,
  })

  return { created, skipped }
}

/**
 * Creates a campaign in draft.
 *
 * The template's subject and body are copied rather than referenced — see the
 * note in `campaign.model.js` about why a running campaign must not change when
 * a template is edited.
 */
export async function createCampaign({ owner, data, createdBy }) {
  let subject = data.subject ?? ''
  let bodyHtml = data.bodyHtml ?? ''

  if (data.template) {
    const template = await CampaignTemplate.findOne({
      _id: data.template,
      owner,
      isDeleted: false,
    })

    if (!template) throw ApiError.notFound('No template with that id exists.')

    subject = data.subject ?? template.subject
    bodyHtml = data.bodyHtml ?? template.bodyHtml
  }

  const campaign = await Campaign.create({
    owner,
    createdBy,
    updatedBy: createdBy,
    name: data.name,
    description: data.description ?? null,
    template: data.template ?? null,
    subject,
    bodyHtml,
    senderMailboxes: data.senderMailboxes ?? [],
    audience: data.audience ?? {},
    throttle: clampThrottle(data.throttle ?? {}),
    variables: data.variables ? new Map(Object.entries(data.variables)) : undefined,
    priority: data.priority ?? 5,
    sequence: data.sequence ?? null,
    scheduledFor: data.scheduledFor ?? null,
  })

  if (data.audience) await buildRecipients({ campaign, owner })

  return campaign
}

/**
 * Renders the message as the first few recipients will actually receive it.
 *
 * Real contacts rather than sample data, because the mistakes personalisation
 * makes — a missing first name, a company field containing a stray quote — only
 * appear against real rows.
 */
export async function previewCampaign({ campaign, limit = 3 }) {
  const recipients = await CampaignRecipient.find({ campaign: campaign._id })
    .limit(limit)
    .populate('contact')

  const campaignValues = campaign.variables ? Object.fromEntries(campaign.variables) : {}

  const check = checkTemplate({
    subject: campaign.subject,
    bodyHtml: campaign.bodyHtml,
    campaignValues,
  })

  const previews = recipients.map((recipient) => {
    const rendered = renderMessage({
      subject: campaign.subject,
      bodyHtml: campaign.bodyHtml,
      contact: recipient.contact ?? {},
      // The preview must render what the queue will render, or it is not a
      // preview — it would show a fallback where the send shows a real value.
      campaignValues: {
        ...campaignValues,
        ...(recipient.variables ? Object.fromEntries(recipient.variables) : {}),
      },
    })

    return {
      email: recipient.email,
      contactName: recipient.contact?.displayName ?? null,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      unresolved: rendered.unresolved,
    }
  })

  return {
    previews,
    variablesUsed: check.used,
    campaignRequired: check.campaignRequired,
    unresolvable: check.unresolvable,
  }
}

/**
 * Moves a campaign from draft to sending.
 *
 * The preconditions are checked here rather than at send time: discovering
 * mid-run that no mailbox was configured would leave a half-sent campaign.
 */
export async function launchCampaign({ campaign, owner, scheduledFor = null }) {
  if (campaign.status !== CAMPAIGN_STATUS.DRAFT) {
    throw ApiError.badRequest(`This campaign is ${campaign.status} and cannot be launched again.`)
  }

  if (!campaign.subject?.trim()) throw ApiError.badRequest('The campaign has no subject line.')
  if (!campaign.bodyHtml?.trim()) throw ApiError.badRequest('The campaign has no message body.')

  if (campaign.senderMailboxes.length === 0) {
    throw ApiError.badRequest('Choose at least one mailbox to send from.')
  }

  const recipientCount = await CampaignRecipient.countDocuments({ campaign: campaign._id })

  if (recipientCount === 0) {
    throw ApiError.badRequest('The campaign has no recipients.')
  }

  // A variable with no possible value would render as a literal `{{Agent}}` in
  // every message. Caught before launch, not after.
  const check = checkTemplate({
    subject: campaign.subject,
    bodyHtml: campaign.bodyHtml,
    campaignValues: campaign.variables ? Object.fromEntries(campaign.variables) : {},
  })

  if (check.campaignRequired.length > 0) {
    throw ApiError.badRequest(
      `These variables have no value and would appear literally in every message: ${check.campaignRequired.join(', ')}.`,
    )
  }

  campaign.status = scheduledFor ? CAMPAIGN_STATUS.SCHEDULED : CAMPAIGN_STATUS.RUNNING
  campaign.scheduledFor = scheduledFor
  campaign.startedAt = scheduledFor ? null : new Date()
  await campaign.save()

  await CampaignEvent.create({
    campaign: campaign._id,
    owner,
    type: CAMPAIGN_EVENT.QUEUED,
    detail: { recipients: recipientCount, scheduledFor },
  })

  log.info('Campaign launched', {
    campaignId: campaign._id.toString(),
    recipients: recipientCount,
    status: campaign.status,
    scheduledFor,
  })

  return campaign
}

/**
 * Pause, resume or cancel.
 *
 * Pausing leaves queued recipients queued — the campaign resumes exactly where
 * it stopped. Cancelling marks the outstanding ones skipped, because a cancelled
 * campaign that could silently resume is a hazard.
 */
export async function controlCampaign({ campaign, action }) {
  switch (action) {
    case 'pause':
      if (campaign.status !== CAMPAIGN_STATUS.RUNNING) {
        throw ApiError.badRequest('Only a running campaign can be paused.')
      }
      campaign.status = CAMPAIGN_STATUS.PAUSED
      campaign.pausedAt = new Date()
      break

    case 'resume':
      if (campaign.status !== CAMPAIGN_STATUS.PAUSED) {
        throw ApiError.badRequest('Only a paused campaign can be resumed.')
      }
      campaign.status = CAMPAIGN_STATUS.RUNNING
      campaign.pausedAt = null
      break

    case 'cancel': {
      if (!ACTIVE_STATUSES.includes(campaign.status)) {
        throw ApiError.badRequest(`A ${campaign.status} campaign cannot be cancelled.`)
      }

      const { modifiedCount } = await CampaignRecipient.updateMany(
        { campaign: campaign._id, status: RECIPIENT_STATUS.QUEUED },
        { $set: { status: RECIPIENT_STATUS.SKIPPED, skipReason: 'Campaign cancelled.' } },
      )

      campaign.status = CAMPAIGN_STATUS.CANCELLED
      campaign.cancelledAt = new Date()

      log.info('Campaign cancelled', {
        campaignId: campaign._id.toString(),
        recipientsSkipped: modifiedCount,
      })
      break
    }

    case 'archive':
      if (ACTIVE_STATUSES.includes(campaign.status)) {
        throw ApiError.badRequest('Stop the campaign before archiving it.')
      }
      campaign.status = CAMPAIGN_STATUS.ARCHIVED
      campaign.archivedAt = new Date()
      break

    default:
      throw ApiError.badRequest(`Unknown action "${action}".`)
  }

  campaign.lockedAt = null
  await campaign.save()
  await campaign.recomputeStats()

  return campaign
}

/**
 * Copies a campaign back to draft.
 *
 * Statistics and recipients are deliberately NOT copied: a clone is a new send
 * to a freshly-resolved audience, and inheriting the original's sent counts
 * would make its analytics a fiction. The audience *definition* is copied, so
 * "the same filter, run again next month" works.
 */
export async function cloneCampaign({ campaign, owner, createdBy, name = null }) {
  const clone = await Campaign.create({
    owner,
    createdBy,
    updatedBy: createdBy,
    name: name ?? `${campaign.name} (copy)`,
    description: campaign.description,
    template: campaign.template,
    subject: campaign.subject,
    bodyHtml: campaign.bodyHtml,
    senderMailboxes: campaign.senderMailboxes,
    audience: campaign.audience,
    throttle: campaign.throttle,
    // Carried across: a clone that rendered `{{Destination}}` as its fallback
    // while the original said "Dubai" is not a copy of anything.
    variables: campaign.variables,
    priority: campaign.priority,
    sequence: campaign.sequence,
    status: CAMPAIGN_STATUS.DRAFT,
  })

  const built = await buildRecipients({ campaign: clone, owner })

  log.info('Campaign cloned', {
    from: campaign._id.toString(),
    to: clone._id.toString(),
    recipients: built.created,
  })

  return { campaign: clone, recipients: built.created }
}

export default {
  resolveAudience,
  buildRecipients,
  createCampaign,
  previewCampaign,
  launchCampaign,
  controlCampaign,
  cloneCampaign,
}
