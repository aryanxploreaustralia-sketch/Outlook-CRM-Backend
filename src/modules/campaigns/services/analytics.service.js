/**
 * Campaign analytics.
 *
 * ## Rates are computed from the right denominator
 *
 * The denominator is what makes a rate honest, and getting it wrong is the
 * commonest way outreach dashboards flatter themselves:
 *
 *   - **Delivery rate** is over *attempted* sends, not total recipients. A
 *     campaign still queuing 4,000 people has not failed to deliver to them yet.
 *   - **Open and reply rates** are over *delivered*, not sent. A bounced message
 *     was never read by anyone, and counting it drags the rate down for a reason
 *     that has nothing to do with the message.
 *
 * ## Every rate is null until it means something
 *
 * A campaign with no delivered messages has no open rate — not 0%. Reporting
 * zero invites the reader to conclude the message failed, when nothing has been
 * measured yet.
 */

import { Campaign } from '../../../models/campaign.model.js'
import { CampaignEvent } from '../../../models/campaignEvent.model.js'
import { CampaignRecipient } from '../../../models/campaignRecipient.model.js'
import { CampaignTemplate } from '../../../models/campaignTemplate.model.js'
import { Mailbox } from '../../../models/mailbox.model.js'
import { CAMPAIGN_EVENT, RECIPIENT_STATUS } from '../constants/campaignConstants.js'
import { mailboxHealthSnapshot } from './throttle.service.js'

/** Percentage to one decimal, or null when the denominator is zero. */
const rate = (numerator, denominator) =>
  denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10

/**
 * Full analytics for one campaign.
 *
 * @returns {Promise<object>}
 */
export async function campaignAnalytics({ campaign, owner }) {
  const [statusGroups, failureGroups, mailboxGroups, replyGroups, timeline] = await Promise.all([
    CampaignRecipient.aggregate([
      { $match: { campaign: campaign._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),

    // Why sends failed, which is what tells an operator whether the problem is
    // their list or their mailbox.
    CampaignRecipient.aggregate([
      { $match: { campaign: campaign._id, 'lastError.kind': { $ne: null } } },
      { $group: { _id: '$lastError.kind', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    CampaignRecipient.aggregate([
      { $match: { campaign: campaign._id, sentFromMailbox: { $ne: null } } },
      {
        $group: {
          _id: '$sentFromMailbox',
          sent: { $sum: 1 },
          replied: { $sum: { $cond: [{ $eq: ['$status', RECIPIENT_STATUS.REPLIED] }, 1, 0] } },
          bounced: { $sum: { $cond: [{ $eq: ['$status', RECIPIENT_STATUS.BOUNCED] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', RECIPIENT_STATUS.FAILED] }, 1, 0] } },
        },
      },
    ]),

    CampaignRecipient.aggregate([
      { $match: { campaign: campaign._id, replyKind: { $ne: null } } },
      { $group: { _id: '$replyKind', count: { $sum: 1 } } },
    ]),

    // Sends per hour, for the throughput chart.
    CampaignEvent.aggregate([
      { $match: { campaign: campaign._id, type: CAMPAIGN_EVENT.SENT } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%dT%H:00', date: '$occurredAt' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 168 },
    ]),
  ])

  const counts = Object.fromEntries(statusGroups.map(({ _id, count }) => [_id, count]))
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)

  // Recipients progress forward through the statuses, so anything at or beyond
  // `sent` counts as sent. Counting only the literal `sent` bucket would make
  // the figure fall as engagement rose.
  const sent =
    (counts.sent ?? 0) + (counts.delivered ?? 0) + (counts.opened ?? 0) + (counts.clicked ?? 0) + (counts.replied ?? 0)
  const delivered =
    (counts.delivered ?? 0) + (counts.opened ?? 0) + (counts.clicked ?? 0) + (counts.replied ?? 0)
  const opened = (counts.opened ?? 0) + (counts.clicked ?? 0) + (counts.replied ?? 0)
  const replied = counts.replied ?? 0
  const bounced = counts.bounced ?? 0
  const failed = counts.failed ?? 0
  const attempted = sent + failed + bounced

  const mailboxIds = mailboxGroups.map((group) => group._id)

  // `Mailbox` keys its owner as `user`, not `owner`. Scoping by the wrong name
  // matched nothing, so every row came back unlabelled — the per-mailbox
  // numbers were right but there was no way to tell which mailbox they were.
  const mailboxes = await Mailbox.find({ _id: { $in: mailboxIds }, user: owner }).select(
    '_id emailAddress displayName',
  )
  const mailboxById = new Map(mailboxes.map((mailbox) => [mailbox._id.toString(), mailbox]))

  return {
    campaign: campaign.toSummaryJSON(),

    funnel: {
      recipients: total,
      queued: counts.queued ?? 0,
      sent,
      delivered,
      opened,
      clicked: counts.clicked ?? 0,
      replied,
      bounced,
      failed,
      skipped: counts.skipped ?? 0,
    },

    rates: {
      delivery: rate(delivered, attempted),
      open: rate(opened, delivered),
      click: rate(counts.clicked ?? 0, delivered),
      reply: rate(replied, delivered),
      bounce: rate(bounced, attempted),
      failure: rate(failed, attempted),
      /** Progress through the list, not a performance measure. */
      completion: rate(attempted + (counts.skipped ?? 0), total),
    },

    failures: failureGroups.map((group) => ({ kind: group._id, count: group.count })),

    replyBreakdown: replyGroups.map((group) => ({ kind: group._id, count: group.count })),

    mailboxPerformance: mailboxGroups
      .map((group) => {
        const mailbox = mailboxById.get(group._id.toString())
        return {
          mailbox: group._id.toString(),
          emailAddress: mailbox?.emailAddress ?? null,
          sent: group.sent,
          replied: group.replied,
          bounced: group.bounced,
          failed: group.failed,
          replyRate: rate(group.replied, group.sent),
          bounceRate: rate(group.bounced, group.sent),
        }
      })
      .sort((a, b) => b.sent - a.sent),

    health: mailboxHealthSnapshot(campaign.senderMailboxes),

    throughput: timeline.map((bucket) => ({ hour: bucket._id, sent: bucket.count })),
  }
}

/**
 * Cross-campaign summary for the dashboard.
 */
export async function overallAnalytics({ owner }) {
  const [statusGroups, totals, topTemplates] = await Promise.all([
    Campaign.aggregate([
      { $match: { owner } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),

    Campaign.aggregate([
      { $match: { owner } },
      {
        $group: {
          _id: null,
          campaigns: { $sum: 1 },
          recipients: { $sum: '$stats.recipients' },
          sent: { $sum: '$stats.sent' },
          delivered: { $sum: '$stats.delivered' },
          replied: { $sum: '$stats.replied' },
          bounced: { $sum: '$stats.bounced' },
          failed: { $sum: '$stats.failed' },
        },
      },
    ]),

    /**
     * Templates ranked by reply rate, not by volume.
     *
     * A template used once with a 50% reply rate is a better signal than one
     * used fifty times at 2%, so the minimum-use floor is deliberately low —
     * but non-zero, because a single reply out of one send is noise.
     */
    CampaignTemplate.find({ owner, isDeleted: false, 'performance.sent': { $gte: 10 } })
      .sort({ 'performance.replied': -1 })
      .limit(5),
  ])

  const t = totals[0] ?? {}
  const attempted = (t.sent ?? 0) + (t.failed ?? 0) + (t.bounced ?? 0)

  const recent = await Campaign.find({ owner, status: { $ne: 'archived' } })
    .sort({ createdAt: -1 })
    .limit(5)

  return {
    byStatus: Object.fromEntries(statusGroups.map(({ _id, count }) => [_id, count])),

    totals: {
      campaigns: t.campaigns ?? 0,
      recipients: t.recipients ?? 0,
      sent: t.sent ?? 0,
      delivered: t.delivered ?? 0,
      replied: t.replied ?? 0,
      bounced: t.bounced ?? 0,
      failed: t.failed ?? 0,
    },

    rates: {
      delivery: rate(t.delivered ?? 0, attempted),
      reply: rate(t.replied ?? 0, t.delivered ?? 0),
      bounce: rate(t.bounced ?? 0, attempted),
    },

    topTemplates: topTemplates.map((template) => ({
      id: template._id.toString(),
      name: template.name,
      category: template.category,
      sent: template.performance.sent,
      replied: template.performance.replied,
      replyRate: template.replyRate(),
    })),

    recent: recent.map((campaign) => campaign.toSummaryJSON()),
  }
}

/**
 * Rolls a finished campaign's results into its template's performance record.
 *
 * Called on completion so the "top performing template" ranking reflects
 * outcomes rather than opinion.
 */
export async function recordTemplatePerformance({ campaign }) {
  if (!campaign.template) return null

  const template = await CampaignTemplate.findById(campaign.template)
  if (!template) return null

  template.performance.campaigns += 1
  template.performance.sent += campaign.stats.sent
  template.performance.replied += campaign.stats.replied
  template.useCount += 1
  template.lastUsedAt = new Date()

  await template.save()

  return template
}

export default { campaignAnalytics, overallAnalytics, recordTemplatePerformance }
