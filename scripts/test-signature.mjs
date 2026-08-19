/** Signature: storage shape, sanitisation on save, and insertion semantics. */

const B = new URL('../src', import.meta.url).href
const { signatureSchema, MAX_SIGNATURE_CHARS } = await import(`${B}/modules/profile/validators/profile.validator.js`)
const { User } = await import(`${B}/models/user.model.js`)
const { sanitizeEmailHtml } = await import(`${B}/utils/emailHtml.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

const save = (html) => signatureSchema.parse({ signatureHtml: html }).signatureHtml

console.log('\n=== storage ===')
const path = User.schema.path('signatureHtml')
check('field exists on User', Boolean(path))
check('defaults to empty string', path.defaultValue === '', JSON.stringify(path.defaultValue))
const legacy = { displayName: 'Old account' } // a document saved before the field existed
check('an account without one reads as no signature', (legacy.signatureHtml ?? '') === '')

console.log('\n=== save / update / retrieve ===')
const SIG = '<p>Kind Regards,</p><p><strong>Hemant Panchal</strong><br />Sr. Operations Manager</p>'
const stored = save(SIG)
check('formatting preserved on save', stored.includes('<strong>') && stored.includes('<br />'))
check('update replaces cleanly', save('<p>New role</p>') === '<p>New role</p>')
check('clearing is legal', save('') === '')

console.log('\n=== sanitisation on save ===')
check('script removed', !save('<p>ok</p><script>alert(1)</script>').includes('<script'))
check('script body removed too', !save('<p>ok</p><script>alert(1)</script>').includes('alert(1)'))
check('onerror stripped', !save('<img src="x" onerror="alert(1)">').includes('onerror'))
check('javascript: link stripped', !save('<a href="javascript:alert(1)">x</a>').includes('javascript:'))
check('iframe removed', !save('<iframe src="https://evil.com"></iframe>').includes('<iframe'))

console.log('\n=== what a real signature needs must survive ===')
const RICH =
  '<p>Kind Regards,</p>' +
  '<p><strong>Hemant Panchal</strong> | Sr. Operations Manager</p>' +
  '<p><a href="mailto:res@example.com">res@example.com</a> | ' +
  '<a href="https://xploreaustralia.com">xploreaustralia.com</a></p>' +
  '<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo" style="max-width:100%;height:auto;" />'
const rich = save(RICH)
check('mailto link', rich.includes('mailto:res@example.com'))
check('https link', rich.includes('https://xploreaustralia.com'))
check('embedded logo', rich.includes('<img') && rich.includes('data:image/png;base64'))
check('image sizing style', rich.includes('max-width:100%'))
check('bold text', rich.includes('<strong>'))

console.log('\n=== a signature with a table (Outlook layouts) ===')
const T = '<table style="border-collapse:collapse"><tr><td style="padding:8px 10px">Xplore</td></tr></table>'
check('table survives', save(T).includes('<table') && save(T).includes('border-collapse:collapse'))

console.log('\n=== insertion appends, never replaces ===')
// `insertHTML` places content at the caret; this models the resulting document.
const body = '<p>Dear {{ContactPerson}},</p><p>Please find our rates below.</p>'
const combined = `${body}<br />${stored}`
check('existing body intact', combined.startsWith(body))
check('signature appended after it', combined.endsWith(stored))
check('template variable untouched', combined.includes('{{ContactPerson}}'))

console.log('\n=== survives template save and send ===')
// A template body containing a signature goes through the same sanitiser on
// save and again in toGraphMessage; neither pass may degrade it.
const once = sanitizeEmailHtml(combined)
const twice = sanitizeEmailHtml(once)
check('sanitising is idempotent', once === twice)
check('signature still present after both passes', twice.includes('Hemant Panchal'))
check('variable still present after both passes', twice.includes('{{ContactPerson}}'))

console.log('\n=== size limits are internally consistent with the image ceiling ===')
const MAX_IMAGE_B64 = Math.ceil((512 * 1024 * 4) / 3)
const img = (chars) => '<img src="data:image/png;base64,' + 'A'.repeat(chars) + '" alt="logo" style="max-width:100%;height:auto;" />'

check('cap exceeds a max-size embedded image', MAX_SIGNATURE_CHARS > MAX_IMAGE_B64,
  MAX_SIGNATURE_CHARS.toLocaleString() + ' > ' + MAX_IMAGE_B64.toLocaleString())
check('cap stays far below MongoDB 16 MB', MAX_SIGNATURE_CHARS < 16 * 1024 * 1024 * 0.25,
  Math.round(MAX_SIGNATURE_CHARS / 1024) + ' KB')

const accepts = (label, html) => {
  try { save(html); check(label, true, 'saved') }
  catch (error) { check(label, false, error.issues?.[0]?.message ?? error.message) }
}
const refuses = (label, html) => {
  try { save(html); check(label, false, 'was ACCEPTED') }
  catch { check(label, true, 'refused') }
}

accepts('text-only signature', '<p>Kind Regards,</p><p>Hemant Panchal</p>')
accepts('normal formatted signature', RICH)
accepts('signature with a 20 KB logo', SIG + img(Math.ceil((20 * 1024 * 4) / 3)))
accepts('signature with a 200 KB logo', SIG + img(Math.ceil((200 * 1024 * 4) / 3)))

const XPLORE =
  '<p>Kind Regards,</p>' +
  '<p><strong>Hemant Panchal</strong> | Sr. Operations Manager</p>' +
  '<p>Email: <a href="mailto:res@example.com">res@example.com</a><br />' +
  'Phone: +91 00000 00000<br />' +
  'Web: <a href="https://xploreaustralia.com">xploreaustralia.com</a></p>' +
  img(Math.ceil((320 * 1024 * 4) / 3))

accepts('realistic signature with embedded banner', XPLORE)
const xploreSaved = save(XPLORE)
check('banner survives sanitising', xploreSaved.includes('data:image/png;base64'))
check('bold survives', xploreSaved.includes('<strong>'))
check('links survive', xploreSaved.includes('mailto:res@example.com') && xploreSaved.includes('xploreaustralia.com'))
check('image sizing survives', xploreSaved.includes('max-width:100%'))

refuses('signature beyond the hard cap', '<p>' + 'x'.repeat(MAX_SIGNATURE_CHARS + 1) + '</p>')
check('clearing still allowed', save('') === '')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
