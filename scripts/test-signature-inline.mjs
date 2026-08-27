/**
 * Verifies the Microsoft Graph payload `buildGraphMessage` produces.
 *
 * Pure-function checks — no database, no network, nothing sent. The shape this
 * asserts is the contract with Graph, which is the closest verification
 * possible without a real mailbox and a real recipient.
 *
 *     npm run test:signature-inline
 */

const B = new URL('../src', import.meta.url).href
const { buildGraphMessage } = await import(`${B}/services/mail.service.js`)
const { embedInlineImages } = await import(`${B}/utils/emailHtml.js`)
const { toGraphMessage } = await import(`${B}/modules/provider/providers/microsoft/messageMapper.js`)

/** `--show` prints the exact Graph payload, so a deployed build can be
 *  compared against this one. The assertions run either way. */
const SHOW = process.argv.includes('--show')

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// A one-pixel PNG, so the bytes are real base64 rather than a placeholder.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const base = { subject: 'Quote', to: [{ address: 'customer@example.com' }] }

console.log('\n=== 1. SIGNATURE WITH ONE IMAGE ===')
const one = buildGraphMessage({
  ...base,
  html: `<p>Regards,</p><p>Hardik Shah</p><img src="data:image/png;base64,${PNG}" alt="Signature">`,
})
check('body is HTML', one.body.contentType === 'HTML')
check('no data: URI left in the body', !one.body.content.includes('data:image'))
check('body references the image by Content-ID', one.body.content.includes('src="cid:signature-image-1"'))
check('alt text preserved', one.body.content.includes('alt="Signature"'))
check('exactly one attachment', one.attachments?.length === 1, String(one.attachments?.length))

const att = one.attachments[0]
check('is a Graph fileAttachment', att['@odata.type'] === '#microsoft.graph.fileAttachment')
check('isInline is true', att.isInline === true)
check('contentId matches the cid in the body', att.contentId === 'signature-image-1')
check('contentType is image/png', att.contentType === 'image/png')
check('contentBytes are the original base64', att.contentBytes === PNG)
check('has a sensible filename', att.name === 'signature-image-1.png', att.name)

console.log('\n=== 2. MULTIPLE IMAGES GET DISTINCT IDS ===')
const many = buildGraphMessage({
  ...base,
  html:
    `<p>Regards</p>` +
    `<img src="data:image/png;base64,${PNG}">` +
    `<img src='data:image/gif;base64,${GIF}'>` +
    `<img src="data:image/jpeg;base64,${PNG}">`,
})
const ids = many.attachments.map((a) => a.contentId)
check('three attachments', many.attachments.length === 3, String(many.attachments.length))
check('ids are unique', new Set(ids).size === 3, ids.join(', '))
check('each cid appears in the body', ids.every((id) => many.body.content.includes(`cid:${id}`)))
check('single-quoted src handled', many.body.content.includes("src='cid:signature-image-2'"))
check('per-image MIME types preserved',
  many.attachments.map((a) => a.contentType).join(',') === 'image/png,image/gif,image/jpeg',
  many.attachments.map((a) => a.contentType).join(','))
check('no data: URI survives', !many.body.content.includes('data:image'))

console.log('\n=== 3. NORMAL MAIL IS UNCHANGED ===')
const plain = buildGraphMessage({ ...base, html: '<p>Hello</p>' })
check('no attachments key when nothing to attach', plain.attachments === undefined)
check('body untouched', plain.body.content === '<p>Hello</p>')

const text = buildGraphMessage({ ...base, html: '', text: 'Hello <world>' })
check('plain text still wrapped and escaped', text.body.content === '<p>Hello &lt;world&gt;</p>')

const remote = buildGraphMessage({ ...base, html: '<img src="https://cdn.example.com/logo.png">' })
check('http(s) images left alone', remote.body.content.includes('https://cdn.example.com/logo.png') && remote.attachments === undefined)

const existingCid = buildGraphMessage({ ...base, html: '<img src="cid:already-there">' })
check('existing cid: left alone', existingCid.body.content.includes('cid:already-there') && existingCid.attachments === undefined)

console.log('\n=== 4. USER ATTACHMENTS STILL WORK ===')
const withFile = buildGraphMessage({
  ...base,
  html: '<p>See attached</p>',
  attachments: [{ name: 'quote.pdf', contentType: 'application/pdf', contentBytes: 'QUJD' }],
})
check('the file is sent', withFile.attachments.length === 1 && withFile.attachments[0].name === 'quote.pdf')
check('a normal file is NOT marked inline', withFile.attachments[0].isInline === undefined)

const both = buildGraphMessage({
  ...base,
  html: `<p>See attached</p><img src="data:image/png;base64,${PNG}">`,
  attachments: [{ name: 'quote.pdf', contentType: 'application/pdf', contentBytes: 'QUJD' }],
})
check('file + signature image both present', both.attachments.length === 2, String(both.attachments.length))
check('user file keeps its position first', both.attachments[0].name === 'quote.pdf')
check('inline image appended, not substituted', both.attachments[1].isInline === true)
check('only the image is inline', both.attachments.filter((a) => a.isInline).length === 1)

console.log('\n=== 5. EDGE CASES ===')
check('empty html does not throw', buildGraphMessage({ ...base, html: '', text: 'x' }).body.contentType === 'HTML')
check('wrapped base64 is unwrapped', embedInlineImages(`<img src="data:image/png;base64,${PNG.slice(0, 20)}\n   ${PNG.slice(20)}">`).attachments[0].contentBytes === PNG)
check('image/jpg normalised to image/jpeg', embedInlineImages(`<img src="data:image/jpg;base64,${PNG}">`).attachments[0].contentType === 'image/jpeg')
check('empty base64 is skipped', embedInlineImages('<img src="data:image/png;base64,">').attachments.length === 0)
check('non-image data URI ignored', embedInlineImages('<img src="data:text/html;base64,PHNjcmlwdD4=">').attachments.length === 0)
check('data: outside an <img> is ignored', embedInlineImages('<a href="data:image/png;base64,AAA">x</a>').attachments.length === 0)
check('no images means no work', embedInlineImages('<p>plain</p>').html === '<p>plain</p>')

console.log('\n=== 6. THE OTHER SEND PATH (reply / forward / campaigns) ===')
const mapped = toGraphMessage({
  subject: 'Re: Quote',
  to: [{ address: 'customer@example.com' }],
  bodyHtml: '<p>Regards</p><img src="data:image/png;base64,' + PNG + '">',
})
check('body is HTML', mapped.body.contentType === 'HTML')
check('no data: URI in the body', !mapped.body.content.includes('data:image'))
check('references the image by Content-ID', mapped.body.content.includes('cid:signature-image-1'))
check('inline attachment produced', mapped.attachments?.[0]?.isInline === true)
check('sanitisation still applied first', !toGraphMessage({
  subject: 'x', to: [{ address: 'a@b.c' }], bodyHtml: '<script>alert(1)</script><p>ok</p>',
}).body.content.includes('<script'))
const mappedPlain = toGraphMessage({ subject: 'x', to: [{ address: 'a@b.c' }], bodyHtml: '<p>Hello</p>' })
check('normal body unchanged, no attachments key',
  mappedPlain.body.content === '<p>Hello</p>' && mappedPlain.attachments === undefined)

if (SHOW) {
  const { sanitizeEmailHtml } = await import(`${B}/utils/emailHtml.js`)
  const signature =
    '<div>Regards,</div><div>Hardik Shah</div>' +
    '<div><img alt="Signature" width="220" height="70" src="data:image/png;base64,' + PNG + '"></div>'

  const payload = buildGraphMessage({
    subject: 'Booking confirmed',
    to: [{ address: 'customer@example.com' }],
    html: '<p>Hello Ms Sonika,</p><p>Your booking has been confirmed.</p>' + sanitizeEmailHtml(signature),
    attachments: [{ name: 'voucher.pdf', contentType: 'application/pdf', contentBytes: 'QUJD' }],
  })

  const shown = JSON.parse(JSON.stringify(payload))
  for (const a of shown.attachments ?? []) {
    a.contentBytes = a.contentBytes.slice(0, 16) + '... (' + a.contentBytes.length + ' chars)'
  }

  console.log('')
  console.log('=== THE MESSAGE THIS BUILD SENDS TO GRAPH ===')
  console.log(JSON.stringify(shown, null, 2))
  console.log('')
  console.log('  body references   :', (payload.body.content.match(/cid:[^"']+/g) || []).join(', '))
  console.log('  inline attachments:', (payload.attachments || []).filter(a => a.isInline).map(a => a.contentId).join(', '))
  console.log('  normal attachments:', (payload.attachments || []).filter(a => !a.isInline).map(a => a.name).join(', '))
  console.log('')
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
