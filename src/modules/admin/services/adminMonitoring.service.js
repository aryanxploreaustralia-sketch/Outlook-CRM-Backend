/**
 * Cross-user monitoring: campaigns and enquiries.
 *
 * ## Why these two exist when the brief listed seven endpoints
 *
 * Phase 14.1 shipped a Campaign monitor and a Lead monitor screen, and the
 * objective of this phase is to replace their placeholder data with real data.
 * The brief's endpoint list does not name them, and the honest options were to
 * delete two working screens, leave them permanently empty, or serve them.
 *
 * Serving them is the only one that meets the objective, and it costs nothing
 * the brief was protecting: both are `GET`, both are in this module, both read
 * collections the CRM already owns, and neither touches the campaign engine or
 * the lead engine — they read the same documents those engines write.
 *
 * They are flagged as an addition in the phase report so they can be dropped if
 * that was not wanted.
 *
 * ## Read-only, like everything here
 *
 * No campaign is paused, resumed or cancelled from this module. The console's
 * controls stay disabled until Phase 14.4, at which point they call the campaign
 * module's existing `control` service rather than a second implementation of it.
 */

import { Campaign } from '../../../models/campaign.model.js'
import { Lead } from '../../../models/lead.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { User } from '../../../models/user.model.js'
import { CAMPAIGN_STATUS_LABELS } from '../../campaigns/constants/campaignConstants.js'
import { LEAD_STAGE_LABELS, WON_STAGES } from '../../leads/constants/leadConstants.js'
import { STALE_LEAD_DAYS } from '../constants/adminConstants.js'

/** Escapes a caller-supplied search term before it reaches a regex. */
function safePattern(term) {
  return new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

/** Resolves a set of user ids to display names in one query. */
async function nameMap(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))]
  if (unique.length === 0) return new Map()

  const users = await User.find({ _id: { $in: unique } })
    .select('displayName email')
    .lean()

  return new Map(
    users.map((user) => [String(user._id), user.displayName ?? user.email ?? 'Unknown user']),
  )
}

/**
 * Every campaign in the deployment, with its owner and sending mailbox.
 *
 * The counters come from `Campaign.stats`, which the campaign engine maintains
 * as it sends. Recounting from `CampaignRecipient` would be one aggregation per
 * campaign and could disagree with the number the campaign's own detail page
 * shows — and there would be no way to say which was right.
 */
export async function listAdminCampaigns(query = {}) {
  const { status, search } = query

  const filter = {}
  if (status) filter.status = status
  if (search) filter.name = safePattern(search)

  const campaigns = await Campaign.find(filter)
    .select('name status owner senderMailboxes stats startedAt completedAt createdAt lastError')
    .sort({ startedAt: -1, createdAt: -1 })
    .limit(200)
    .lean()

  const [owners, mailboxes] = await Promise.all([
    nameMap(campaigns.map((campaign) => campaign.owner)),
    Mailbox.find({ _id: { $in: campaigns.flatMap((campaign) => campaign.senderMailboxes ?? []) } })
      .select('emailAddress')
      .lean(),
  ])

  const mailboxById = new Map(mailboxes.map((mailbox) => [String(mailbox._id), mailbox.emailAddress]))

  const items = campaigns.map((campaign) => {
    const stats = campaign.stats ?? {}

    return {
      id: String(campaign._id),
      name: campaign.name,
      status: campaign.status,
      statusLabel: CAMPAIGN_STATUS_LABELS[campaign.status] ?? campaign.status,
      owner: owners.get(String(campaign.owner)) ?? 'Unknown user',
      /**
       * The owner's id, alongside their name.
       *
       * Added in Phase 14.5.1 for the per-user dashboard, which needs to select
       * one person's campaigns. The row already carried the owner - as a display
       * name - and filtering on that would attribute one person's campaigns to
       * another whenever two names collide or a name is absent and falls back to
       * an address. On an administration screen that is a correctness problem,
       * not a cosmetic one.
       *
       * Purely additive: every existing consumer reads `owner` and is unaffected.
       */
      ownerId: String(campaign.owner),
      mailbox:
        (campaign.senderMailboxes ?? [])
          .map((id) => mailboxById.get(String(id)))
          .filter(Boolean)
          .join(', ') || null,
      recipients: stats.recipients ?? 0,
      sent: stats.sent ?? 0,
      replies: stats.replied ?? 0,
      failed: (stats.failed ?? 0) + (stats.bounced ?? 0),
      startedAt: campaign.startedAt ?? null,
      completedAt: campaign.completedAt ?? null,
      createdAt: campaign.createdAt,
      lastError: campaign.lastError?.message ?? null,
    }
  })

  return {
    items,
    summary: {
      total: items.length,
      running: items.filter((item) => item.status === 'running').length,
      scheduled: items.filter((item) => item.status === 'scheduled').length,
      recipients: items.reduce((total, item) => total + item.recipients, 0),
      failed: items.reduce((total, item) => total + item.failed, 0),
    },
  }
}

/**
 * Every enquiry in the deployment, with the two attention flags.
 *
 * ## `assignedTo` is reported as the owner, and that is not a fudge
 *
 * `Lead` has `owner` and `createdBy` but no `assignedTo` — the Phase 14.0
 * design adds it, and adding a field is a schema change this phase must not
 * make. So the column shows who the enquiry belongs to, which is the truthful
 * answer to "whose is this" under the current model. When `assignedTo` exists
 * the column reads it and nothing else here changes.
 *
 * ## Staleness is measured from `updatedAt`
 *
 * `Lead` records no last-activity timestamp of its own. `updatedAt` moves on
 * every stage change, edit and auto-mail attempt, which is close enough to
 * "somebody has touched this" to be useful, and it is stated in the response so
 * nobody mistakes it for a conversation timestamp.
 */
export async function listAdminLeads(query = {}) {
  const { stage, search, attention } = query

  const filter = { isDeleted: false }
  if (stage) filter.stage = stage

  if (attention === 'unassigned') filter.owner = null
  if (attention === 'stale') {
    filter.updatedAt = { $lt: new Date(Date.now() - STALE_LEAD_DAYS * 86_400_000) }
  }

  if (search) {
    const pattern = safePattern(search)
    filter.$or = [
      { reference: pattern },
      { contactPerson: pattern },
      { companyName: pattern },
      { email: pattern },
    ]
  }

  const leads = await Lead.find(filter)
    .select('reference contactPerson companyName email stage market owner createdAt updatedAt autoMail.status')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean()

  const owners = await nameMap(leads.map((lead) => lead.owner))
  const staleCutoff = Date.now() - STALE_LEAD_DAYS * 86_400_000

  const items = leads.map((lead) => {
    const lastActivityAt = lead.updatedAt ?? lead.createdAt

    return {
      id: String(lead._id),
      reference: lead.reference,
      customer: lead.contactPerson,
      company: lead.companyName ?? null,
      email: lead.email ?? null,
      stage: lead.stage,
      stageLabel: LEAD_STAGE_LABELS[lead.stage] ?? lead.stage,
      market: lead.market ?? null,
      assignedTo: owners.get(String(lead.owner)) ?? null,
      /** The owner's id. Same reasoning as `ownerId` on the campaign row above. */
      assignedToId: lead.owner ? String(lead.owner) : null,
      autoMailStatus: lead.autoMail?.status ?? null,
      lastActivityAt,
      lastActivityDays: Math.floor((Date.now() - new Date(lastActivityAt).getTime()) / 86_400_000),
      isStale: new Date(lastActivityAt).getTime() < staleCutoff,
      createdAt: lead.createdAt,
    }
  })

  return {
    items,
    summary: {
      total: items.length,
      unassigned: items.filter((item) => item.assignedTo === null).length,
      stale: items.filter((item) => item.isStale).length,
      // Shared constant, not hardcoded stages — see WON_STAGES.
      won: items.filter((item) => WON_STAGES.includes(item.stage)).length,
    },
    meta: {
      staleAfterDays: STALE_LEAD_DAYS,
      activitySource: 'updatedAt',
      note: 'Last activity is the record\'s last modification, not a conversation timestamp.',
    },
  }
}

export default { listAdminCampaigns, listAdminLeads }
