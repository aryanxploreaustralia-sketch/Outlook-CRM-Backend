/**
 * Settles the signature-image question against a real mailbox.
 *
 * Every layer inside this codebase can be verified locally, and all of it
 * checks out — the payload carries `isInline: true` with a Content-ID the body
 * references. What cannot be verified locally is what **Exchange** does with
 * that payload once it has it. This sends one real message and then reads it
 * back out of Sent Items, so the attachment can be inspected as Exchange
 * actually stored it.
 *
 *     npm run diagnose:signature -- someone@example.com
 *
 * It sends ONE email, to an address you name, from the first connected
 * mailbox it finds. It writes nothing to the database and changes no records.
 */

const B = new URL('../src', import.meta.url).href

const recipient = process.argv.slice(2).find((arg) => arg.includes('@'))

if (!recipient) {
  console.error('\nUsage: npm run diagnose:signature -- you@example.com\n')
  console.error('Name the address to send the test to. Use your own inbox.\n')
  process.exit(1)
}

const { connectDatabase, disconnectDatabase } = await import(`${B}/config/database.js`)
const { buildGraphMessage } = await import(`${B}/services/mail.service.js`)
const { sanitizeEmailHtml } = await import(`${B}/utils/emailHtml.js`)
const { createGraphClient, sendMailMessage } = await import(`${B}/services/graph.service.js`)
const { Mailbox } = await import(`${B}/models/mailbox.model.js`)

/** A visible 8x8 red square, so the result is obvious in the email. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVQoz2P8z8Dwn4GKgIlhFIxaMGrBqAUjxQIAaMIDAV/9nFwAAAAASUVORK5CYII='

await connectDatabase()

const mailbox = await Mailbox.findOne({ status: 'connected' }).lean()
if (!mailbox) {
  console.error('\nNo connected mailbox found. Connect one from Account first.\n')
  await disconnectDatabase()
  process.exit(1)
}

console.log(`\nSending from : ${mailbox.address ?? mailbox.emailAddress ?? mailbox._id}`)
console.log(`Sending to   : ${recipient}`)

const signature = sanitizeEmailHtml(
  '<div>Regards,</div><div>Hardik Shah</div>' +
    `<div><img alt="Signature" width="120" height="120" src="data:image/png;base64,${PNG}"></div>`,
)

const message = buildGraphMessage({
  to: [{ address: recipient }],
  subject: `Signature inline test — ${new Date().toISOString().slice(11, 19)}`,
  html: `<p>This is a signature rendering test.</p>${signature}`,
})

console.log('\n=== 1. WHAT WE SEND ===')
console.log('  body references   :', (message.body.content.match(/cid:[^"']+/g) ?? []).join(', ') || 'NONE')
for (const a of message.attachments ?? []) {
  console.log(`  attachment        : ${a.name}  isInline=${a.isInline}  contentId=${a.contentId}  ${a.contentType}`)
}

const clientRequestId = `sigtest-${Date.now()}`
await sendMailMessage(String(mailbox.accountId ?? mailbox.outlookAccountId ?? mailbox._id), message, clientRequestId)
console.log('\n  sent — Graph accepted the message.')

// Exchange needs a moment to file it into Sent Items.
console.log('  waiting 6s for Sent Items to catch up…')
await new Promise((resolve) => setTimeout(resolve, 6000))

console.log('\n=== 2. WHAT EXCHANGE STORED ===')
const client = createGraphClient(String(mailbox.accountId ?? mailbox.outlookAccountId ?? mailbox._id))

const sent = await client
  .api('/me/mailFolders/sentitems/messages')
  .top(1)
  .select('id,subject,hasAttachments,body')
  .orderby('sentDateTime desc')
  .get()

const stored = sent?.value?.[0]
if (!stored) {
  console.log('  Could not read Sent Items. Check the mailbox permissions.')
} else {
  console.log(`  subject           : ${stored.subject}`)
  console.log(`  hasAttachments    : ${stored.hasAttachments}`)
  console.log(`  body references   : ${(stored.body?.content?.match(/cid:[^"']+/g) ?? []).join(', ') || 'NONE'}`)

  const attachments = await client
    .api(`/me/messages/${stored.id}/attachments`)
    .select('id,name,contentType,size,isInline,contentId')
    .get()

  console.log('\n  attachments as Exchange stored them:')
  for (const a of attachments?.value ?? []) {
    console.log(`    ${a.name}`)
    console.log(`      isInline  : ${a.isInline}   <-- must be true for the signature`)
    console.log(`      contentId : ${a.contentId}`)
    console.log(`      type/size : ${a.contentType} / ${a.size} bytes`)
  }

  const inline = (attachments?.value ?? []).filter((a) => a.isInline)
  const cids = stored.body?.content?.match(/cid:([^"']+)/g)?.map((m) => m.slice(4)) ?? []

  console.log('\n=== 3. VERDICT ===')
  if (inline.length === 0) {
    console.log('  Exchange did NOT keep isInline. The payload was correct, so the')
    console.log('  cause is server-side — try the draft-then-send route instead.')
  } else if (!cids.every((cid) => inline.some((a) => a.contentId === cid))) {
    console.log('  isInline survived but a cid: in the body has no matching')
    console.log('  contentId. That mismatch is what makes a client show a card.')
  } else {
    console.log('  Exchange stored the image as inline with a matching Content-ID.')
    console.log('  The message is correct on the wire. If a client still shows a')
    console.log('  card, that is that client displaying inline images in its')
    console.log('  attachment well — check the received mail in Outlook and Gmail.')
  }
}

console.log('\nOpen the message in your inbox now and confirm what you actually see.\n')

await disconnectDatabase()
