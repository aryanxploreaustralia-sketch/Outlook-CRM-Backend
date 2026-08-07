/**
 * Deterministic fixture data for the mock provider.
 *
 * ## Deterministic, not random
 *
 * Generated from a seeded PRNG rather than `Math.random()`, so the same mailbox
 * produces the same messages on every run. Random fixtures make demos look
 * different each reload and make failures unreproducible — "it showed a
 * duplicate once" is not a bug report anyone can act on.
 *
 * The data is realistic on purpose: threaded conversations, mixed read state,
 * attachments, and a proportion of unread mail that resembles a real mailbox.
 * A mock that returns three identical messages hides exactly the bugs — thread
 * grouping, unread counts, pagination — that a mock exists to exercise.
 */

import { FOLDERS } from '../../constants/folderTypes.js'

/**
 * Mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over `Math.random()` for seedability alone; the statistical quality is
 * far beyond what fixture generation needs.
 */
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

/** Turns a mailbox id into a stable numeric seed. */
function seedFrom(value) {
  const text = String(value ?? 'mock')
  let hash = 2_166_136_261

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }

  return hash >>> 0
}

const CONTACTS = [
  { name: 'Priya Raman', address: 'priya.raman@northwind-trading.com' },
  { name: 'Daniel Okafor', address: 'd.okafor@meridian-logistics.com' },
  { name: 'Sofia Almeida', address: 'sofia.almeida@lumenparts.io' },
  { name: 'Marcus Lindqvist', address: 'marcus@brightpath.se' },
  { name: 'Aisha Haddad', address: 'a.haddad@cedarbrook.co' },
  { name: 'Tom Whitfield', address: 'tom.whitfield@harborview.net' },
  { name: 'Yuki Tanaka', address: 'y.tanaka@sakuraworks.jp' },
  { name: 'Elena Rossi', address: 'elena.rossi@viacorda.it' },
]

/**
 * Inbox subjects, containing deliberate reply pairs.
 *
 * `"X"` and `"Re: X"` both appear so that stripping the `Re:` prefix groups them
 * into one conversation. Without a real pair the fixtures would produce a
 * distinct thread per message, and conversation grouping — one of the things a
 * mock exists to exercise — would silently never be tested.
 */
const INBOX_SUBJECTS = [
  'Q3 supplier agreement — revised terms',
  'Re: Q3 supplier agreement — revised terms',
  'Invoice INV-20418 attached',
  'Re: Invoice INV-20418 attached',
  'Shipment SO-88231 delayed at customs',
  'Re: Shipment SO-88231 delayed at customs',
  'Meeting notes: procurement sync',
  'Updated pricing sheet for review',
  'Contract renewal — action needed by Friday',
  'Warehouse capacity for November',
  'Re: Warehouse capacity for November',
  'Compliance certificate renewal',
]

const SENT_SUBJECTS = [
  'Proposal: extended distribution terms',
  'Re: Invoice INV-20418 attached',
  'Following up on the procurement sync',
  'Revised quote — 2,400 units',
  'Re: Shipment SO-88231 delayed at customs',
  'Availability for the QBR',
]

const DRAFT_SUBJECTS = [
  'Draft: response to pricing query',
  'Draft: November capacity plan',
]

const BODY_TEMPLATES = [
  'Thanks for the quick turnaround on this. I have reviewed the figures and they look consistent with what we discussed on the call.\n\nOne open point: the delivery window on line item 4 still shows the old date. Could you confirm whether that has been updated on your side?',
  'Following up on the below. We are aiming to close this out before the end of the month, so any update you can share would be helpful.\n\nHappy to jump on a short call if that is easier than going back and forth over email.',
  'Please find the requested documentation attached. The summary is on page 2 and the detailed breakdown follows from page 5 onwards.\n\nLet me know if anything needs clarification.',
  'Noting that the volumes here are higher than our original forecast, which is good news, but it does mean we should revisit the logistics capacity before committing.\n\nI have asked the warehouse team for an updated view and will share once I have it.',
  'Confirming receipt. Everything checks out on our end and I have passed this to accounts for processing.\n\nYou should see the payment clear within five working days.',
]

const ATTACHMENT_FIXTURES = [
  { name: 'invoice-20418.pdf', contentType: 'application/pdf', size: 184_320 },
  { name: 'pricing-sheet-q3.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 42_118 },
  { name: 'shipment-manifest.csv', contentType: 'text/csv', size: 8_842 },
  { name: 'compliance-cert.pdf', contentType: 'application/pdf', size: 312_640 },
]

/** Folder fixtures, shaped like Graph's `mailFolders` response. */
export function buildMockFolders() {
  return [
    { providerFolderId: 'mock-inbox', displayName: 'Inbox', wellKnownName: 'inbox', canonical: FOLDERS.INBOX, parentFolderId: null, totalItemCount: 12, unreadItemCount: 4 },
    { providerFolderId: 'mock-sent', displayName: 'Sent Items', wellKnownName: 'sentitems', canonical: FOLDERS.SENT, parentFolderId: null, totalItemCount: 6, unreadItemCount: 0 },
    { providerFolderId: 'mock-drafts', displayName: 'Drafts', wellKnownName: 'drafts', canonical: FOLDERS.DRAFTS, parentFolderId: null, totalItemCount: 2, unreadItemCount: 0 },
    { providerFolderId: 'mock-deleted', displayName: 'Deleted Items', wellKnownName: 'deleteditems', canonical: FOLDERS.TRASH, parentFolderId: null, totalItemCount: 3, unreadItemCount: 0 },
    { providerFolderId: 'mock-archive', displayName: 'Archive', wellKnownName: 'archive', canonical: FOLDERS.ARCHIVE, parentFolderId: null, totalItemCount: 5, unreadItemCount: 0 },
    { providerFolderId: 'mock-junk', displayName: 'Junk Email', wellKnownName: 'junkemail', canonical: FOLDERS.SPAM, parentFolderId: null, totalItemCount: 1, unreadItemCount: 1 },
    // A custom folder, so folder mapping is exercised rather than only the
    // well-known path.
    { providerFolderId: 'mock-custom-suppliers', displayName: 'Suppliers', wellKnownName: null, canonical: FOLDERS.CUSTOM, parentFolderId: 'mock-inbox', totalItemCount: 4, unreadItemCount: 0 },
  ]
}

const SUBJECTS_BY_FOLDER = {
  [FOLDERS.INBOX]: INBOX_SUBJECTS,
  [FOLDERS.SENT]: SENT_SUBJECTS,
  [FOLDERS.DRAFTS]: DRAFT_SUBJECTS,
  [FOLDERS.ARCHIVE]: INBOX_SUBJECTS,
  [FOLDERS.TRASH]: INBOX_SUBJECTS,
  [FOLDERS.SPAM]: ['You have won a prize'],
  [FOLDERS.CUSTOM]: INBOX_SUBJECTS,
  [FOLDERS.OUTBOX]: SENT_SUBJECTS,
}

const COUNT_BY_FOLDER = {
  [FOLDERS.INBOX]: 12,
  [FOLDERS.SENT]: 6,
  [FOLDERS.DRAFTS]: 2,
  [FOLDERS.ARCHIVE]: 5,
  [FOLDERS.TRASH]: 3,
  [FOLDERS.SPAM]: 1,
  [FOLDERS.CUSTOM]: 4,
  [FOLDERS.OUTBOX]: 0,
}

/**
 * Builds messages for one folder.
 *
 * @param {object} params
 * @param {string} params.folder    Canonical folder.
 * @param {string} params.mailboxId Seeds the PRNG, so output is stable per mailbox.
 * @param {string} params.ownerAddress The mailbox owner, used as sender or recipient.
 * @param {number} [params.count]
 * @returns {import('../../interfaces/EmailProvider.js').ProviderMessage[]}
 */
export function buildMockMessages({ folder, mailboxId, ownerAddress, count }) {
  const random = seededRandom(seedFrom(`${mailboxId}:${folder}`))
  const subjects = SUBJECTS_BY_FOLDER[folder] ?? INBOX_SUBJECTS
  const total = count ?? COUNT_BY_FOLDER[folder] ?? 5

  const isOutbound = folder === FOLDERS.SENT || folder === FOLDERS.DRAFTS
  const messages = []

  for (let index = 0; index < total; index += 1) {
    const contact = CONTACTS[Math.floor(random() * CONTACTS.length)]
    const subject = subjects[index % subjects.length]
    const body = BODY_TEMPLATES[Math.floor(random() * BODY_TEMPLATES.length)]

    // Spread over the last 30 days, newest first.
    const ageMs = Math.floor(random() * 30 * 24 * 60 * 60 * 1000)
    const timestamp = new Date(Date.now() - ageMs)

    // Threads: a subject starting "Re:" belongs to the conversation of its base
    // subject, so grouping logic has something real to group.
    const threadSubject = subject.replace(/^Re:\s*/i, '')
    const conversationId = `mock-conv-${seedFrom(threadSubject).toString(16)}`

    const hasAttachments = random() < 0.25
    const attachments = hasAttachments
      ? [
          {
            ...ATTACHMENT_FIXTURES[Math.floor(random() * ATTACHMENT_FIXTURES.length)],
            id: `mock-att-${index}-${folder}`,
            isInline: false,
          },
        ]
      : []

    messages.push({
      providerMessageId: `mock-msg-${folder}-${index}-${seedFrom(`${mailboxId}${subject}${index}`).toString(16)}`,
      conversationId,
      threadId: conversationId,
      folder,
      subject,
      bodyHtml: `<p>${body.split('\n\n').join('</p><p>')}</p>`,
      bodyText: body,
      from: isOutbound ? { address: ownerAddress, name: 'You' } : contact,
      to: isOutbound ? [contact] : [{ address: ownerAddress, name: 'You' }],
      cc: [],
      bcc: [],
      // Sent and draft mail is necessarily read; inbox mail mostly is.
      isRead: isOutbound ? true : random() > 0.35,
      isStarred: random() < 0.15,
      hasAttachments,
      attachments,
      sentAt: isOutbound ? timestamp : null,
      receivedAt: isOutbound ? null : timestamp,
      changeKey: `mock-ck-${seedFrom(`${subject}${index}`).toString(16)}`,
    })
  }

  // Newest first, matching what every provider returns.
  return messages.sort((a, b) => {
    const left = (a.receivedAt ?? a.sentAt)?.getTime() ?? 0
    const right = (b.receivedAt ?? b.sentAt)?.getTime() ?? 0
    return right - left
  })
}

export default { buildMockFolders, buildMockMessages }
