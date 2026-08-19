/** Verifies the existing attachment pipeline: schema -> Graph payload. */

const B = new URL('../src', import.meta.url).href
const { sendMailSchema } = await import(`${B}/validators/mail.validator.js`)
const { toGraphMessage } = await import(`${B}/modules/provider/providers/microsoft/messageMapper.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

// Real magic bytes, so "binary survives" means what it says.
const FILES = [
  ['Itinerary.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\nbinary', 'binary')],
  ['Logo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])],
  ['Photo.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])],
  ['Rates.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])],
  ['Brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a])],
  ['Bundle.zip', 'application/zip', Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00])],
]

const attach = ([name, contentType, buf]) => ({ name, contentType, contentBytes: buf.toString('base64') })

console.log('\n=== each file type survives schema -> Graph, byte for byte ===')
for (const file of FILES) {
  const [name, contentType, buf] = file
  const parsed = sendMailSchema.parse({
    to: [{ address: 'a@b.com' }], subject: 's', html: '<p>x</p>', attachments: [attach(file)],
  })
  const graph = toGraphMessage({ ...parsed, bodyHtml: parsed.html })
  const out = graph.attachments[0]
  const round = Buffer.from(out.contentBytes, 'base64')

  check(
    name,
    out['@odata.type'] === '#microsoft.graph.fileAttachment' &&
      out.name === name && out.contentType === contentType && round.equals(buf),
    `${round.length}B identical`,
  )
}

console.log('\n=== multiple attachments in one message ===')
const many = sendMailSchema.parse({
  to: [{ address: 'a@b.com' }], subject: 's', html: '<p>x</p>',
  attachments: FILES.slice(0, 5).map(attach),
})
const manyGraph = toGraphMessage({ ...many, bodyHtml: many.html })
check('5 attachments preserved', manyGraph.attachments.length === 5)
check('names in order', manyGraph.attachments.map((a) => a.name).join() === FILES.slice(0, 5).map((f) => f[0]).join())
check('every one is a fileAttachment', manyGraph.attachments.every((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment'))

console.log('\n=== data: URI prefix from FileReader is stripped ===')
const pref = sendMailSchema.parse({
  to: [{ address: 'a@b.com' }], subject: 's', html: '<p>x</p>',
  attachments: [{ name: 'a.pdf', contentType: 'application/pdf', contentBytes: 'data:application/pdf;base64,' + FILES[0][2].toString('base64') }],
})
check('prefix stripped, bytes intact', Buffer.from(pref.attachments[0].contentBytes, 'base64').equals(FILES[0][2]))

console.log('\n=== path components in a filename are stripped ===')
const trav = sendMailSchema.parse({
  to: [{ address: 'a@b.com' }], subject: 's', html: '<p>x</p>',
  attachments: [{ name: '../../etc/passwd', contentType: 'text/plain', contentBytes: 'eA==' }],
})
check('traversal stripped', trav.attachments[0].name === 'passwd', trav.attachments[0].name)

console.log('\n=== rejections ===')
const rejects = (name, body) => {
  try { sendMailSchema.parse(body); check(name, false, 'was ACCEPTED') }
  catch { check(name, true, 'rejected') }
}
rejects('non-base64 content', { to: [{ address: 'a@b.com' }], subject: 's', html: '<p>x</p>', attachments: [{ name: 'a.pdf', contentBytes: '!!!not base64!!!' }] })
rejects('empty content', { to: [{ address: 'a@b.com' }], subject: 's', html: '<p>x</p>', attachments: [{ name: 'a.pdf', contentBytes: '' }] })
rejects('too many attachments', { to: [{ address: 'a@b.com' }], subject: 's', html: '<p>x</p>', attachments: Array.from({ length: 50 }, () => attach(FILES[0])) })
rejects('combined size over cap', { to: [{ address: 'a@b.com' }], subject: 's', html: '<p>x</p>', attachments: [{ name: 'big.bin', contentType: 'application/octet-stream', contentBytes: Buffer.alloc(4 * 1024 * 1024).toString('base64') }] })

console.log('\n=== no attachments: the existing path is unchanged ===')
const plain = sendMailSchema.parse({ to: [{ address: 'a@b.com' }], subject: 's', html: '<p><strong>hi</strong></p>' })
const plainGraph = toGraphMessage({ ...plain, bodyHtml: plain.html })
check('no attachments key added', plainGraph.attachments === undefined)
check('body still HTML', plainGraph.body.contentType === 'HTML' && plainGraph.body.content.includes('<strong>'))

console.log('\n=== Pass 1 sanitisation still applies alongside attachments ===')
const both = sendMailSchema.parse({
  to: [{ address: 'a@b.com' }], subject: 's',
  html: '<table><tr><td style="border:1px solid #cbd5e1">{{reference}}</td></tr></table><script>alert(1)</script>',
  attachments: [attach(FILES[0])],
})
const bothGraph = toGraphMessage({ ...both, bodyHtml: both.html })
check('table survives', bothGraph.body.content.includes('<table') && bothGraph.body.content.includes('border:1px solid #cbd5e1'))
check('variable survives', bothGraph.body.content.includes('{{reference}}'))
check('script stripped', !bothGraph.body.content.includes('<script'))
check('attachment still present', bothGraph.attachments.length === 1)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
