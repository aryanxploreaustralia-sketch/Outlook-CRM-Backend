#!/usr/bin/env node
/**
 * Seeds a realistic campaign history.
 *
 * Run with:  npm run seed:campaigns [-- --reset]
 *
 * Produces 6 templates, a 3-step follow-up sequence, 20 campaigns spread across
 * every lifecycle state, 500 recipients and the events behind them — enough for
 * the campaign list, the live dashboard and the analytics page to all show
 * something meaningful without anyone having to send a real email.
 *
 * Deterministic: the same run produces the same data, so a demo looks identical
 * on every reload and a bug found here is reproducible.
 *
 * ## Why the recipients are written directly rather than through the queue
 *
 * The queue's job is to talk to a provider. Driving it here would either send
 * real mail or require a mock provider, and in both cases the seeded history
 * would be limited to what a single run could produce — every campaign would
 * have completed seconds ago. Writing terminal states directly lets the seed
 * place campaigns days apart, which is what makes the analytics page readable.
 *
 * The events are written to match, because analytics reads events rather than
 * the denormalised counters for anything time-windowed. Seeding one without the
 * other produces a dashboard that contradicts itself.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Campaign } from '../src/models/campaign.model.js'
import { CampaignEvent } from '../src/models/campaignEvent.model.js'
import { CampaignRecipient } from '../src/models/campaignRecipient.model.js'
import { CampaignSequence } from '../src/models/campaignSequence.model.js'
import { CampaignTemplate } from '../src/models/campaignTemplate.model.js'
import { Contact } from '../src/models/contact.model.js'
import { Mailbox } from '../src/models/mailbox.model.js'
import { User } from '../src/models/user.model.js'
import {
  CAMPAIGN_EVENT,
  CAMPAIGN_PRIORITY,
  CAMPAIGN_STATUS,
  RECIPIENT_STATUS,
  REPLY_KIND,
  TEMPLATE_CATEGORY,
} from '../src/modules/campaigns/constants/campaignConstants.js'
import { CONNECTION_STATUS, PROVIDER_TYPES } from '../src/modules/provider/constants/providerTypes.js'

const out = (line = '') => process.stdout.write(`${line}\n`)
const rule = (char = '─') => out(char.repeat(72))

/** Mulberry32 — seedable, so the campaign history is reproducible. */
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

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Template library
// ---------------------------------------------------------------------------

/**
 * One template per category the builder offers.
 *
 * Every body uses the personalisation variables a real campaign would, so
 * `checkTemplate()` has something to validate and the preview step shows a
 * substitution rather than the raw `{{FirstName}}`.
 */
const TEMPLATES = [
  {
    name: 'Summer Travel Offer',
    category: TEMPLATE_CATEGORY.TRAVEL_OFFER,
    description: 'Seasonal package announcement with a destination placeholder.',
    subject: '{{FirstName}}, our {{Destination}} packages are open for booking',
    bodyHtml: [
      '<p>Hi {{FirstName}},</p>',
      '<p>Our {{Destination}} packages for the coming season are now open, and the ',
      'early-booking rate holds until the end of the month.</p>',
      '<p>Happy to put a quote together for {{Company}} if you let me know your dates ',
      'and traveller count.</p>',
      '<p>Best regards,<br>{{Agent}}</p>',
    ].join(''),
  },
  {
    name: 'Follow-up — No Response',
    category: TEMPLATE_CATEGORY.FOLLOW_UP,
    description: 'Short nudge for recipients who have not replied.',
    subject: 'Following up — {{Destination}}',
    bodyHtml: [
      '<p>Hi {{FirstName}},</p>',
      '<p>Just checking whether my note about {{Destination}} reached you. If the ',
      'timing is wrong, tell me when to come back and I will.</p>',
      '<p>Best regards,<br>{{Agent}}</p>',
    ].join(''),
  },
  {
    name: 'Visa Documentation Checklist',
    category: TEMPLATE_CATEGORY.VISA,
    description: 'Sent once a booking is confirmed and paperwork is needed.',
    subject: 'Visa checklist for your {{Destination}} trip',
    bodyHtml: [
      '<p>Dear {{FirstName}},</p>',
      '<p>Here is the documentation required for {{Destination}}. Send them across ',
      'and we will handle the submission on behalf of {{Company}}.</p>',
      '<ul><li>Passport valid six months beyond return</li>',
      '<li>Two recent photographs</li>',
      '<li>Confirmed itinerary</li>',
      '<li>Proof of accommodation</li></ul>',
      '<p>Kind regards,<br>{{Agent}}</p>',
    ].join(''),
  },
  {
    name: 'Quotation',
    category: TEMPLATE_CATEGORY.QUOTATION,
    description: 'Formal quote covering letter.',
    subject: 'Your quotation for {{Destination}}',
    bodyHtml: [
      '<p>Dear {{FirstName}},</p>',
      '<p>Please find our quotation for {{Destination}} attached. It is valid for ',
      'fourteen days and includes all taxes.</p>',
      '<p>I am glad to walk {{Company}} through the detail on a call.</p>',
      '<p>Kind regards,<br>{{Agent}}</p>',
    ].join(''),
  },
  {
    name: 'Payment Reminder',
    category: TEMPLATE_CATEGORY.REMINDER,
    description: 'Balance due before departure.',
    subject: 'Reminder: balance due for {{Destination}}',
    bodyHtml: [
      '<p>Hi {{FirstName}},</p>',
      '<p>A gentle reminder that the balance for the {{Destination}} booking falls ',
      'due shortly. Ignore this if it has already gone out.</p>',
      '<p>Thanks,<br>{{Agent}}</p>',
    ].join(''),
  },
  {
    name: 'Re-engagement',
    category: TEMPLATE_CATEGORY.CUSTOM,
    description: 'For leads that went quiet more than a quarter ago.',
    subject: '{{FirstName}} — anything on the horizon for {{Company}}?',
    bodyHtml: [
      '<p>Hi {{FirstName}},</p>',
      '<p>We have not spoken in a while. If {{Company}} has travel coming up this ',
      'quarter I would be glad to help plan it.</p>',
      '<p>Best,<br>{{Agent}}</p>',
    ].join(''),
  },
]

const DESTINATIONS = [
  'Dubai', 'Singapore', 'Bali', 'Istanbul', 'Lisbon', 'Cape Town',
  'Tokyo', 'Reykjavík', 'Queenstown', 'Marrakech',
]

const AGENTS = ['Priya Raman', 'Daniel Whitfield', 'Sofia Almeida', 'Marcus Lindqvist']

/** Campaign names, chosen so the list reads like a real quarter of work. */
const CAMPAIGN_NAMES = [
  'Summer Escapes — Corporate', 'Q3 Visa Renewals', 'Dubai Expo Follow-up',
  'Lapsed Leads Re-engagement', 'Singapore Roadshow Invite', 'Bali Retreat Offer',
  'Istanbul City Break', 'Lisbon Conference Travel', 'Cape Town Incentive Trip',
  'Tokyo Trade Mission', 'Reykjavík Winter Special', 'Queenstown Adventure Group',
  'Marrakech Long Weekend', 'Outstanding Balance Sweep', 'Australia Leads — First Touch',
  'Corporate Leads — Quotation', 'Mukesh Sheet Outreach', 'Sales Sheet Follow-up',
  'Year-End Thank You', 'New Year Planning',
]

const MAILBOX_ADDRESSES = ['enquiry', 'sales', 'support', 'operations']

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const shouldReset = args.includes('--reset')

  out()
  rule('═')
  out('  SEEDING CAMPAIGNS')
  rule('═')
  out(`  database  : ${config.database.uri}`)
  out(`  campaigns : ${CAMPAIGN_NAMES.length}, 500 recipients, ${TEMPLATES.length} templates`)
  out()

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 5000 })

  // Attach to a real signed-in user when one exists, so the data appears in the UI.
  let user = await User.findOne().sort({ lastLoginAt: -1 })

  if (!user) {
    user = await User.findOneAndUpdate(
      { microsoftId: 'seed-campaigns-user', tenantId: 'seed-campaigns-tenant' },
      {
        $set: { displayName: 'Demo User', email: 'demo.user@contoso.com', lastLoginAt: new Date() },
        $setOnInsert: { microsoftId: 'seed-campaigns-user', tenantId: 'seed-campaigns-tenant' },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    )
    out('  Created a demo user (no signed-in user was found).')
  }

  out(`  owner     : ${user.email ?? user.displayName} (${user._id})`)

  const contacts = await Contact.find({ owner: user._id, isDeleted: false }).limit(600).lean()

  if (contacts.length < 25) {
    out()
    out('  Not enough contacts to build campaigns from.')
    out('  Run `npm run seed:contacts` first — campaigns target the address book,')
    out('  and seeding fabricated recipients would make duplicate detection and')
    out('  reply matching disagree with what is actually in the database.')
    out()
    return 1
  }

  out(`  contacts  : ${contacts.length} available to target`)
  out()

  if (shouldReset) {
    const [campaigns, recipients, events, templates, sequences] = await Promise.all([
      Campaign.deleteMany({ owner: user._id }),
      CampaignRecipient.deleteMany({ owner: user._id }),
      CampaignEvent.deleteMany({ owner: user._id }),
      CampaignTemplate.deleteMany({ owner: user._id }),
      CampaignSequence.deleteMany({ owner: user._id }),
    ])
    out(
      `  --reset: removed ${campaigns.deletedCount} campaigns, ` +
        `${recipients.deletedCount} recipients, ${events.deletedCount} events, ` +
        `${templates.deletedCount} templates, ${sequences.deletedCount} sequences.`,
    )
    out()
  }

  const random = seededRandom(0xca3_9a16)
  const now = Date.now()

  // --- Mailboxes -----------------------------------------------------------
  //
  // Rotation is only observable with more than one mailbox, so the seed makes
  // sure the four departmental addresses exist. Upserted rather than created:
  // a real connected mailbox must not be duplicated or overwritten.
  out('  Ensuring sender mailboxes…')

  const domain = (user.email ?? 'demo.user@contoso.com').split('@')[1] ?? 'contoso.com'
  const mailboxes = []

  for (const local of MAILBOX_ADDRESSES) {
    const emailAddress = `${local}@${domain}`
    const mailbox = await Mailbox.findOneAndUpdate(
      { user: user._id, emailAddress },
      {
        $set: { displayName: `${local[0].toUpperCase()}${local.slice(1)} Team`, status: CONNECTION_STATUS.CONNECTED },
        $setOnInsert: {
          user: user._id,
          emailAddress,
          provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
          providerAccountId: `seed-${local}`,
        },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    )
    mailboxes.push(mailbox)
  }

  out(`    ${mailboxes.map((m) => m.emailAddress).join(', ')}`)

  // --- Templates -----------------------------------------------------------
  out('  Creating templates…')

  const templates = []

  for (const definition of TEMPLATES) {
    const template = await CampaignTemplate.findOneAndUpdate(
      { owner: user._id, name: definition.name },
      {
        $set: {
          ...definition,
          owner: user._id,
          createdBy: user._id,
          isDeleted: false,
        },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    )
    templates.push(template)
  }

  out(`    ${templates.length} templates across ${new Set(TEMPLATES.map((t) => t.category)).size} categories`)

  // --- Follow-up sequence --------------------------------------------------
  //
  // Day 0 / 3 / 7 — the cadence the brief calls for. Steps stop on reply, which
  // is the whole point: a recipient who answered on day 1 must never receive
  // the day-3 nudge asking whether they saw the first message.
  out('  Creating the follow-up sequence…')

  const sequence = await CampaignSequence.findOneAndUpdate(
    { owner: user._id, name: 'Standard 3-Touch Follow-up' },
    {
      $set: {
        owner: user._id,
        createdBy: user._id,
        description: 'Initial offer, a nudge on day 3, a final touch on day 7.',
        stopOnReply: true,
        stopOnUnsubscribe: true,
        isDeleted: false,
        steps: [
          { delayDays: 0, template: templates[0]._id, name: 'Initial offer' },
          { delayDays: 3, template: templates[1]._id, name: 'First nudge' },
          {
            delayDays: 7,
            template: templates[5]._id,
            name: 'Final touch',
            subjectOverride: 'Last note about {{Destination}}, {{FirstName}}',
          },
        ],
      },
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
  )

  out(`    ${sequence.steps.length} steps over ${sequence.totalDays()} days`)

  // --- Campaigns -----------------------------------------------------------
  out('  Creating campaigns and recipients…')

  /**
   * How the 20 campaigns are distributed.
   *
   * Weighted towards completed, because that is what a real account looks like
   * after a quarter, and because the analytics page has nothing to show if
   * every campaign is still a draft.
   */
  const PLAN = [
    { status: CAMPAIGN_STATUS.COMPLETED, count: 9 },
    { status: CAMPAIGN_STATUS.RUNNING, count: 3 },
    { status: CAMPAIGN_STATUS.PAUSED, count: 2 },
    { status: CAMPAIGN_STATUS.SCHEDULED, count: 2 },
    { status: CAMPAIGN_STATUS.DRAFT, count: 2 },
    { status: CAMPAIGN_STATUS.CANCELLED, count: 1 },
    { status: CAMPAIGN_STATUS.ARCHIVED, count: 1 },
  ]

  const statuses = PLAN.flatMap(({ status, count }) => Array.from({ length: count }, () => status))

  /** 500 recipients over the campaigns that actually have an audience. */
  const TOTAL_RECIPIENTS = 500
  const sendingCampaigns = statuses.filter((s) => s !== CAMPAIGN_STATUS.DRAFT).length
  const perCampaign = Math.floor(TOTAL_RECIPIENTS / sendingCampaigns)

  let contactCursor = 0
  let recipientTotal = 0
  let eventTotal = 0
  const summary = []

  for (const [index, status] of statuses.entries()) {
    const template = templates[index % templates.length]
    const destination = DESTINATIONS[index % DESTINATIONS.length]
    const agent = AGENTS[index % AGENTS.length]

    // Older campaigns first, so the list is chronologically believable.
    const ageDays = (statuses.length - index) * 3 + Math.floor(random() * 3)
    const createdAt = new Date(now - ageDays * DAY_MS)

    const isDraft = status === CAMPAIGN_STATUS.DRAFT
    const size = isDraft ? 0 : perCampaign + (index < TOTAL_RECIPIENTS % sendingCampaigns ? 1 : 0)

    // Contacts are taken in a rolling window: campaigns overlap, as real ones
    // do, but no single campaign targets the same contact twice — which the
    // unique index on (campaign, contact) would reject anyway.
    const audience = []
    for (let i = 0; i < size; i += 1) {
      audience.push(contacts[(contactCursor + i) % contacts.length])
    }
    contactCursor = (contactCursor + Math.max(1, Math.floor(size * 0.7))) % contacts.length

    const campaign = await Campaign.create({
      owner: user._id,
      createdBy: user._id,
      name: CAMPAIGN_NAMES[index],
      description: `${template.description} Targeting ${destination}.`,
      status,
      priority: index % 7 === 0 ? CAMPAIGN_PRIORITY.HIGH : CAMPAIGN_PRIORITY.NORMAL,
      template: template._id,
      subject: template.subject,
      bodyHtml: template.bodyHtml,
      senderMailboxes: [mailboxes[index % mailboxes.length]._id, mailboxes[(index + 1) % mailboxes.length]._id],
      audience: { source: 'manual', contactIds: audience.map((c) => c._id) },
      throttle: { perMinute: 20, perHour: 500, perDay: 5000, batchSize: 25 },
      sequence: index % 4 === 0 ? sequence._id : null,
      scheduledFor: status === CAMPAIGN_STATUS.SCHEDULED ? new Date(now + (index % 5 + 1) * DAY_MS) : null,
      startedAt: [CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SCHEDULED].includes(status) ? null : createdAt,
      completedAt: status === CAMPAIGN_STATUS.COMPLETED ? new Date(createdAt.getTime() + 2 * 60 * 60 * 1000) : null,
      pausedAt: status === CAMPAIGN_STATUS.PAUSED ? new Date(createdAt.getTime() + 30 * 60 * 1000) : null,
      cancelledAt: status === CAMPAIGN_STATUS.CANCELLED ? new Date(createdAt.getTime() + 45 * 60 * 1000) : null,
      archivedAt: status === CAMPAIGN_STATUS.ARCHIVED ? new Date(createdAt.getTime() + 5 * DAY_MS) : null,
    })

    // Backdated separately: `timestamps: true` stamps `createdAt` at insert, so
    // passing it to `create()` would be silently discarded and every campaign
    // would appear to have been made in the same second.
    await Campaign.updateOne({ _id: campaign._id }, { $set: { createdAt } }, { timestamps: false })
    campaign.createdAt = createdAt

    const recipients = []
    const events = []

    for (const [position, contact] of audience.entries()) {
      const email = contact.primaryEmail ?? contact.secondaryEmail
      if (!email) continue

      const mailbox = mailboxes[(index + position) % mailboxes.length]
      const sentAt = new Date(createdAt.getTime() + position * 3000)

      // Outcome distribution, roughly matching a healthy B2B send: most land,
      // a fifth get opened, a twentieth reply, a few bounce.
      const roll = random()
      let recipientStatus = RECIPIENT_STATUS.QUEUED

      if (status === CAMPAIGN_STATUS.RUNNING) {
        // A running campaign is half-sent by definition — that is what makes the
        // live dashboard's progress bar and ETA show anything.
        recipientStatus = position < size / 2 ? RECIPIENT_STATUS.DELIVERED : RECIPIENT_STATUS.QUEUED
      } else if (status === CAMPAIGN_STATUS.PAUSED) {
        recipientStatus = position < size / 3 ? RECIPIENT_STATUS.DELIVERED : RECIPIENT_STATUS.QUEUED
      } else if (status === CAMPAIGN_STATUS.SCHEDULED) {
        recipientStatus = RECIPIENT_STATUS.QUEUED
      } else if (status === CAMPAIGN_STATUS.CANCELLED) {
        recipientStatus = position < size / 4 ? RECIPIENT_STATUS.SENT : RECIPIENT_STATUS.SKIPPED
      } else if (roll < 0.05) {
        recipientStatus = RECIPIENT_STATUS.REPLIED
      } else if (roll < 0.25) {
        recipientStatus = RECIPIENT_STATUS.OPENED
      } else if (roll < 0.9) {
        recipientStatus = RECIPIENT_STATUS.DELIVERED
      } else if (roll < 0.95) {
        recipientStatus = RECIPIENT_STATUS.BOUNCED
      } else {
        recipientStatus = RECIPIENT_STATUS.FAILED
      }

      const wasSent = ![RECIPIENT_STATUS.QUEUED, RECIPIENT_STATUS.SKIPPED].includes(recipientStatus)
      const wasDelivered = [
        RECIPIENT_STATUS.DELIVERED, RECIPIENT_STATUS.OPENED,
        RECIPIENT_STATUS.CLICKED, RECIPIENT_STATUS.REPLIED,
      ].includes(recipientStatus)

      recipients.push({
        campaign: campaign._id,
        owner: user._id,
        contact: contact._id,
        email,
        status: recipientStatus,
        variables: new Map([['Destination', destination], ['Agent', agent]]),
        sentFromMailbox: wasSent ? mailbox._id : null,
        attempts: wasSent ? 1 : 0,
        queuedAt: createdAt,
        sentAt: wasSent ? sentAt : null,
        deliveredAt: wasDelivered ? new Date(sentAt.getTime() + 4000) : null,
        openedAt: [RECIPIENT_STATUS.OPENED, RECIPIENT_STATUS.CLICKED, RECIPIENT_STATUS.REPLIED].includes(recipientStatus)
          ? new Date(sentAt.getTime() + 20 * 60 * 1000)
          : null,
        repliedAt: recipientStatus === RECIPIENT_STATUS.REPLIED ? new Date(sentAt.getTime() + 3 * 60 * 60 * 1000) : null,
        replyKind: recipientStatus === RECIPIENT_STATUS.REPLIED ? REPLY_KIND.REPLY : null,
        skipReason: recipientStatus === RECIPIENT_STATUS.SKIPPED ? 'Campaign cancelled before send' : null,
        failure:
          recipientStatus === RECIPIENT_STATUS.BOUNCED
            ? { kind: 'invalid_email', message: 'Recipient address rejected', occurredAt: sentAt }
            : recipientStatus === RECIPIENT_STATUS.FAILED
              ? { kind: 'temporary', message: 'Mailbox unavailable after 4 attempts', occurredAt: sentAt }
              : { kind: null, message: null, occurredAt: null },
      })

      // Events mirror the recipient state — analytics reads these for anything
      // windowed, and a mismatch shows up as a dashboard contradicting itself.
      const base = { campaign: campaign._id, owner: user._id, email, mailbox: mailbox._id }

      events.push({ ...base, type: CAMPAIGN_EVENT.QUEUED, occurredAt: createdAt })

      if (wasSent) events.push({ ...base, type: CAMPAIGN_EVENT.SENT, occurredAt: sentAt })
      if (wasDelivered) events.push({ ...base, type: CAMPAIGN_EVENT.DELIVERED, occurredAt: new Date(sentAt.getTime() + 4000) })
      if ([RECIPIENT_STATUS.OPENED, RECIPIENT_STATUS.REPLIED].includes(recipientStatus)) {
        events.push({ ...base, type: CAMPAIGN_EVENT.OPENED, occurredAt: new Date(sentAt.getTime() + 20 * 60 * 1000) })
      }
      if (recipientStatus === RECIPIENT_STATUS.REPLIED) {
        events.push({
          ...base,
          type: CAMPAIGN_EVENT.REPLIED,
          detail: { replyKind: REPLY_KIND.REPLY },
          occurredAt: new Date(sentAt.getTime() + 3 * 60 * 60 * 1000),
        })
      }
      if (recipientStatus === RECIPIENT_STATUS.BOUNCED) {
        events.push({ ...base, type: CAMPAIGN_EVENT.BOUNCED, detail: { kind: 'invalid_email' }, occurredAt: sentAt })
      }
      if (recipientStatus === RECIPIENT_STATUS.FAILED) {
        events.push({ ...base, type: CAMPAIGN_EVENT.FAILED, detail: { kind: 'temporary' }, occurredAt: sentAt })
      }
      if (recipientStatus === RECIPIENT_STATUS.SKIPPED) {
        events.push({ ...base, type: CAMPAIGN_EVENT.SKIPPED, occurredAt: sentAt })
      }
    }

    if (recipients.length > 0) {
      const inserted = await CampaignRecipient.insertMany(recipients, { ordered: false })

      // The recipient id is only known after the insert, so events are linked
      // here rather than above — a per-recipient timeline is useless without it.
      // Keyed by address, which is unique within a campaign.
      const idByEmail = new Map(inserted.map((recipient) => [recipient.email, recipient._id]))
      for (const event of events) event.recipient = idByEmail.get(event.email) ?? null

      await CampaignEvent.insertMany(events, { ordered: false })

      recipientTotal += recipients.length
      eventTotal += events.length
    }

    // Counters come from the recipients just written, so the seeded numbers are
    // consistent with the documents rather than guessed at.
    await campaign.recomputeStats()

    summary.push({ name: campaign.name, status, recipients: recipients.length })
  }

  // Template usage is derived the same way the running engine derives it.
  for (const template of templates) {
    const used = await Campaign.find({ owner: user._id, template: template._id }).select('stats').lean()
    template.useCount = used.length
    template.performance = {
      campaigns: used.length,
      sent: used.reduce((sum, c) => sum + (c.stats?.sent ?? 0), 0),
      replied: used.reduce((sum, c) => sum + (c.stats?.replied ?? 0), 0),
    }
    template.lastUsedAt = used.length > 0 ? new Date(now - DAY_MS) : null
    await template.save()
  }

  sequence.useCount = await Campaign.countDocuments({ owner: user._id, sequence: sequence._id })
  await sequence.save()

  // --- Report --------------------------------------------------------------
  const byStatus = {}
  for (const row of summary) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1

  out()
  rule()
  out('  RESULT')
  rule()
  out(`  campaigns  : ${summary.length}`)
  for (const [status, count] of Object.entries(byStatus)) {
    out(`      ${status.padEnd(10)} ${count}`)
  }
  out(`  recipients : ${recipientTotal}`)
  out(`  events     : ${eventTotal}`)
  out(`  templates  : ${templates.length}`)
  out(`  sequences  : 1 (${sequence.steps.length} steps)`)
  out(`  mailboxes  : ${mailboxes.length}`)
  out()
  out('  Open the app and visit /campaigns to see it.')
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
