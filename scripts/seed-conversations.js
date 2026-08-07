#!/usr/bin/env node
/**
 * Seeds realistic customer conversations.
 *
 * Run with:  npm run seed:conversations [-- --reset] [-- --threads 60]
 *
 * Drives the **real ingestion path** rather than writing conversation rows
 * directly: fabricated messages are handed to `ingestMessage`, which matches
 * them, threads them, classifies them and moves the enquiry exactly as a live
 * sync would. A seed that inserted finished conversations would prove nothing
 * about the matcher and would drift from it the first time the rules changed.
 *
 * Requires leads to exist — run `npm run seed:leads` first.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import { Conversation } from '../src/models/conversation.model.js'
import { ConversationActivity } from '../src/models/conversationActivity.model.js'
import { ConversationAttachment } from '../src/models/conversationAttachment.model.js'
import { ConversationMessage } from '../src/models/conversationMessage.model.js'
import { Lead } from '../src/models/lead.model.js'
import { LeadTask } from '../src/models/leadTask.model.js'
import { User } from '../src/models/user.model.js'
import * as collaboration from '../src/modules/conversations/services/collaboration.service.js'
import { ingestMessage, recordOutgoing } from '../src/modules/conversations/services/conversationSync.service.js'

const out = (line = '') => process.stdout.write(`${line}\n`)
const rule = (char = '─') => out(char.repeat(72))

/** Mulberry32 — seedable, so the demo is reproducible. */
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

/** Replies a travel desk actually receives. */
const CUSTOMER_REPLIES = [
  {
    body: 'Thanks for the quote. Can you check availability for two more people on the same dates?',
    kind: 'reply',
  },
  {
    body: 'This looks good. Please hold the booking, I will confirm payment by Friday.',
    kind: 'reply',
  },
  {
    body: 'The price is a little above our budget. Is there a 3-star option for the same itinerary?',
    kind: 'reply',
  },
  {
    body: 'Could you send the visa checklist? Two of the travellers hold Indian passports.',
    kind: 'reply',
  },
  {
    body: 'Client has changed the dates to the following week. Revised quote please.',
    kind: 'reply',
  },
  {
    body: 'Please share the day-by-day itinerary and the hotel names before we confirm.',
    kind: 'reply',
  },
  {
    body: 'We are going ahead. Please send the invoice and the payment link.',
    kind: 'reply',
  },
  {
    body: 'I am out of the office until 14 March with limited access to email. For urgent matters contact operations@example.com.',
    kind: 'out_of_office',
    subjectPrefix: 'Automatic reply: ',
  },
  {
    body: 'Thank you for your email. This mailbox is not monitored.',
    kind: 'auto_reply',
    subjectPrefix: 'Auto-Reply: ',
  },
]

const OUR_REPLIES = [
  'Thanks for coming back to me. I have asked the hotel and will confirm within the day.',
  'Revised quotation attached. The new dates are available at the same rate.',
  'Visa checklist attached. Send the documents across and we will handle the submission.',
  'Booking held until Friday. I will send the invoice once you confirm.',
]

const ATTACHMENTS = [
  { name: 'Quotation.pdf', contentType: 'application/pdf', size: 184_320 },
  { name: 'Itinerary.pdf', contentType: 'application/pdf', size: 296_100 },
  { name: 'Visa-checklist.pdf', contentType: 'application/pdf', size: 92_400 },
  { name: 'Hotel-photos.jpg', contentType: 'image/jpeg', size: 1_204_800 },
]

const NOTES = [
  'Client is price sensitive — do not lead with the premium option.',
  'Repeat customer, third booking this year. Worth a small discount.',
  'Needs the itinerary before Thursday, they are presenting to their board.',
  'Passport for one traveller expires in four months — flag the visa risk.',
]

const TASK_SEEDS = [
  { type: 'prepare_quotation', title: 'Send the revised quotation' },
  { type: 'call_customer', title: 'Call to confirm the dates' },
  { type: 'visa_documents', title: 'Collect passport copies' },
  { type: 'payment_reminder', title: 'Chase the balance payment' },
  { type: 'send_itinerary', title: 'Send the day-by-day itinerary' },
]

async function main() {
  const args = process.argv.slice(2)
  const shouldReset = args.includes('--reset')
  const threadIndex = args.indexOf('--threads')
  const targetThreads = threadIndex === -1 ? 60 : Math.max(1, Number(args[threadIndex + 1]) || 60)

  out()
  rule('═')
  out('  SEEDING CUSTOMER CONVERSATIONS')
  rule('═')
  out(`  database : ${config.database.uri}`)
  out(`  threads  : ${targetThreads}`)
  out()

  await mongoose.connect(config.database.uri, { serverSelectionTimeoutMS: 5000 })

  const user = await User.findOne().sort({ lastLoginAt: -1 })

  if (!user) {
    out('  No user found. Run `npm run seed:leads` first.')
    return 1
  }

  const owner = user._id
  out(`  owner    : ${user.email ?? user.displayName} (${owner})`)

  const leads = await Lead.find({
    owner,
    isDeleted: false,
    email: { $nin: [null, ''] },
  })
    .sort({ quoteDate: -1 })
    .limit(targetThreads * 2)

  if (leads.length === 0) {
    out()
    out('  No enquiries with an email address were found.')
    out('  Run `npm run seed:leads` first — a conversation belongs to an enquiry,')
    out('  and seeding threads with no lead would only produce triage noise.')
    out()
    return 1
  }

  out(`  leads    : ${leads.length} available`)
  out()

  if (shouldReset) {
    const [conversations, messages, files, activity, tasks] = await Promise.all([
      Conversation.deleteMany({ owner }),
      ConversationMessage.deleteMany({ owner }),
      ConversationAttachment.deleteMany({ owner }),
      ConversationActivity.deleteMany({ owner }),
      LeadTask.deleteMany({ owner }),
    ])
    out(
      `  --reset: removed ${conversations.deletedCount} conversations, ${messages.deletedCount} messages, ` +
        `${files.deletedCount} attachments, ${activity.deletedCount} activity entries and ${tasks.deletedCount} tasks.`,
    )
    out()
  }

  const random = seededRandom(0xc0_1a7e)
  const now = Date.now()

  out('  Building threads through the real ingestion path…')

  const summary = { threads: 0, inbound: 0, outbound: 0, attachments: 0, notes: 0, tasks: 0, unmatched: 0 }

  const chosen = leads.slice(0, targetThreads)

  for (const [index, lead] of chosen.entries()) {
    const ageDays = 2 + Math.floor(random() * 45)
    const openedAt = new Date(now - ageDays * DAY_MS)
    const threadKey = `seed-thread-${index}`
    const ourMessageId = `<seed-out-${index}@agency.local>`

    // 1. Our opening message — the quotation that started the exchange.
    const conversation = await Conversation.findOneAndUpdate(
      { owner, providerConversationId: threadKey },
      {
        $setOnInsert: {
          owner,
          lead: lead._id,
          company: lead.company,
          contact: lead.contact,
          provider: 'microsoft-graph',
          providerConversationId: threadKey,
          providerThreadId: threadKey,
          subject: `Quotation ${lead.reference} — ${lead.city ?? 'your trip'}`,
          counterpartyEmail: lead.email,
          counterpartyName: lead.contactPerson,
          matchStrategy: 'in_reply_to',
          matchConfidence: 1,
          messageIds: [ourMessageId],
        },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    )

    await recordOutgoing({
      owner,
      conversation,
      provider: 'microsoft-graph',
      actor: owner,
      message: {
        from: { address: user.email ?? 'sales@agency.com', name: 'Sales' },
        to: [{ address: lead.email, name: lead.contactPerson }],
        subject: conversation.subject,
        bodyHtml: `<p>Dear ${lead.contactPerson},</p><p>Please find our quotation for ${lead.city ?? 'your trip'}.</p>`,
        bodyText: `Dear ${lead.contactPerson},\n\nPlease find our quotation for ${lead.city ?? 'your trip'}.`,
        internetMessageId: ourMessageId,
        providerMessageId: `seed-pm-out-${index}`,
        sentAt: openedAt,
        attachments: [ATTACHMENTS[0]],
      },
    })
    summary.outbound += 1

    // 2. The customer answers — through the matcher, as a live sync would.
    const exchanges = 1 + Math.floor(random() * 3)
    let lastCustomerId = null

    for (let turn = 0; turn < exchanges; turn += 1) {
      const template = CUSTOMER_REPLIES[Math.floor(random() * CUSTOMER_REPLIES.length)]
      const repliedAt = new Date(openedAt.getTime() + (turn + 1) * (4 + random() * 40) * 3_600_000)

      if (repliedAt.getTime() > now) break

      const withFiles = random() < 0.25
      const files = withFiles
        ? [ATTACHMENTS[1 + Math.floor(random() * (ATTACHMENTS.length - 1))]]
        : []

      const messageId = `<seed-in-${index}-${turn}@customer.local>`

      const { conversation: threaded } = await ingestMessage({
        owner,
        provider: 'microsoft-graph',
        message: {
          providerMessageId: `seed-pm-in-${index}-${turn}`,
          conversationId: threadKey,
          internetMessageId: messageId,
          inReplyTo: lastCustomerId ?? ourMessageId,
          references: [ourMessageId, ...(lastCustomerId ? [lastCustomerId] : [])],
          subject: `${template.subjectPrefix ?? 'Re: '}${conversation.subject}`,
          bodyHtml: `<p>${template.body}</p>`,
          bodyText: template.body,
          from: { address: lead.email, name: lead.contactPerson },
          to: [{ address: user.email ?? 'sales@agency.com', name: 'Sales' }],
          cc: [],
          receivedAt: repliedAt,
          isRead: random() > 0.35,
          hasAttachments: files.length > 0,
          attachments: files.map((file, fileIndex) => ({
            id: `seed-att-${index}-${turn}-${fileIndex}`,
            ...file,
          })),
          // The out-of-office header the classifier looks for.
          headers: template.kind === 'out_of_office' ? { 'auto-submitted': 'auto-replied' } : {},
        },
      })

      lastCustomerId = messageId
      summary.inbound += 1
      summary.attachments += files.length
      if (!threaded?.lead) summary.unmatched += 1

      // 3. We answer back, some of the time.
      if (random() < 0.6) {
        const replyAt = new Date(repliedAt.getTime() + (1 + random() * 20) * 3_600_000)
        if (replyAt.getTime() < now) {
          const body = OUR_REPLIES[Math.floor(random() * OUR_REPLIES.length)]

          await recordOutgoing({
            owner,
            conversation: threaded ?? conversation,
            provider: 'microsoft-graph',
            actor: owner,
            message: {
              from: { address: user.email ?? 'sales@agency.com', name: 'Sales' },
              to: [{ address: lead.email, name: lead.contactPerson }],
              subject: `Re: ${conversation.subject}`,
              bodyHtml: `<p>${body}</p>`,
              bodyText: body,
              internetMessageId: `<seed-out-${index}-${turn}@agency.local>`,
              inReplyTo: messageId,
              references: [ourMessageId, messageId],
              providerMessageId: `seed-pm-out-${index}-${turn}`,
              sentAt: replyAt,
            },
          })
          summary.outbound += 1
        }
      }
    }

    summary.threads += 1

    // 4. Notes and tasks, on some threads.
    if (random() < 0.4) {
      await collaboration.addNote({
        owner,
        actor: owner,
        leadId: lead._id,
        conversationId: conversation._id,
        body: `<p>${NOTES[Math.floor(random() * NOTES.length)]}</p>`,
        isPinned: random() < 0.3,
      })
      summary.notes += 1
    }

    if (random() < 0.45) {
      const seed = TASK_SEEDS[Math.floor(random() * TASK_SEEDS.length)]
      const overdue = random() < 0.3

      await collaboration.createTask({
        owner,
        actor: owner,
        leadId: lead._id,
        conversationId: conversation._id,
        type: seed.type,
        title: seed.title,
        dueAt: new Date(now + (overdue ? -1 : 1) * (1 + Math.floor(random() * 6)) * DAY_MS),
        priority: random() < 0.2 ? 'high' : 'normal',
        assignedTo: owner,
        isFollowUp: random() < 0.4,
      })
      summary.tasks += 1
    }

    if ((index + 1) % 20 === 0) out(`    ${index + 1}/${chosen.length} threads`)
  }

  // --- Report ---------------------------------------------------------------
  const [total, needing, unread, openTasks] = await Promise.all([
    Conversation.countDocuments({ owner, isDeleted: false }),
    Conversation.countDocuments({ owner, isDeleted: false, status: 'awaiting_us' }),
    Conversation.countDocuments({ owner, isDeleted: false, unreadCount: { $gt: 0 } }),
    LeadTask.countDocuments({ owner, isDeleted: false, status: { $in: ['open', 'in_progress'] } }),
  ])

  out()
  rule()
  out('  RESULT')
  rule()
  out(`  conversations   : ${total}`)
  out(`  inbound msgs    : ${summary.inbound}`)
  out(`  outbound msgs   : ${summary.outbound}`)
  out(`  attachments     : ${summary.attachments}`)
  out(`  notes           : ${summary.notes}`)
  out(`  tasks           : ${summary.tasks} (${openTasks} open)`)
  out()
  out(`  needing a reply : ${needing}`)
  out(`  unread          : ${unread}`)
  out(`  unmatched       : ${summary.unmatched}`)
  out()
  out('  Open the app and visit /conversations to see it.')
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
