/** Sanitiser policy tests: what must survive, and what must not. */

const B = new URL('../src', import.meta.url).href
const { sanitizeEmailHtml } = await import(`${B}/utils/emailHtml.js`)
const { toGraphMessage } = await import(`${B}/modules/provider/providers/microsoft/messageMapper.js`)

let pass = 0
let fail = 0

const keeps = (name, input, ...needles) => {
  const out = sanitizeEmailHtml(input)
  const ok = needles.every((n) => out.includes(n))
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`        got: ${out}`)
  if (ok) pass += 1
  else fail += 1
}

const drops = (name, input, ...needles) => {
  const out = sanitizeEmailHtml(input)
  const ok = needles.every((n) => !out.toLowerCase().includes(n.toLowerCase()))
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`        got: ${out}`)
  if (ok) pass += 1
  else fail += 1
}

console.log('\n=== SAFE — must survive ===')
keeps('bold / italic / underline', '<p><strong>a</strong><em>b</em><u>c</u></p>', '<strong>', '<em>', '<u>')
keeps('strikethrough', '<p><s>gone</s></p>', '<s>')
keeps('lists', '<ul><li>a</li></ul><ol><li>b</li></ol>', '<ul>', '<ol>', '<li>')
keeps('https link + rel added', '<a href="https://x.com">x</a>', 'href="https://x.com"', 'noopener')
keeps('mailto link', '<a href="mailto:a@b.com">mail</a>', 'mailto:a@b.com')
keeps('text colour', '<span style="color:#ff0000">r</span>', 'color:#ff0000')
keeps('highlight', '<span style="background-color:#fef08a">h</span>', 'background-color:#fef08a')
keeps('font-size', '<span style="font-size:14px">s</span>', 'font-size:14px')
keeps('alignment', '<p style="text-align:center">c</p>', 'text-align:center')

console.log('\n=== the editor\u2019s own table must survive intact ===')
const cell = 'border:1px solid #cbd5e1;padding:8px 10px;font-size:14px;vertical-align:top;'
const head = `${cell}background-color:#f1f5f9;font-weight:bold;text-align:left;`
const table =
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
  `style="border-collapse:collapse;width:100%;margin:12px 0;font-family:Arial,Helvetica,sans-serif;">` +
  `<thead><tr><th style="${head}">Reference</th></tr></thead>` +
  `<tbody><tr><td style="${cell}">XNHP200</td></tr></tbody></table>`

keeps('table structure', table, '<table', '<thead>', '<tbody>', '<tr>', '<th', '<td')
keeps('table inline styles', table, 'border-collapse:collapse', 'border:1px solid #cbd5e1', 'padding:8px 10px')
keeps('table attributes', table, 'cellpadding="0"', 'cellspacing="0"', 'role="presentation"')
keeps('header background + bold', table, 'background-color:#f1f5f9', 'font-weight:bold')

console.log('\n=== template variables must be untouched ===')
keeps('variables', '<p>Hi {{firstName}} at {{companyName}} re {{reference}}</p>',
  '{{firstName}}', '{{companyName}}', '{{reference}}')
keeps('variable inside a table cell', `<table><tr><td>{{reference}}</td></tr></table>`, '{{reference}}')
keeps('&nbsp; stays an entity', '<td>&nbsp;</td>', '&nbsp;')

console.log('\n=== BLOCKED — must not survive ===')
drops('script tag and its contents', '<p>ok</p><script>alert(1)</script>', '<script', 'alert(1)')
drops('img onerror', '<img src="x" onerror="alert(1)">', 'onerror', 'alert(1)')
drops('onclick', '<p onclick="steal()">x</p>', 'onclick', 'steal()')
drops('onload', '<body onload="x()">t</body>', 'onload')
drops('javascript: href', '<a href="javascript:alert(1)">x</a>', 'javascript:')
drops('vbscript: href', '<a href="vbscript:msgbox">x</a>', 'vbscript:')
drops('iframe', '<iframe src="https://evil.com"></iframe>', '<iframe')
drops('object / embed', '<object data="x"></object><embed src="y">', '<object', '<embed')
drops('form', '<form action="https://evil.com"><input name="p"></form>', '<form', '<input')
drops('style block', '<style>body{display:none}</style><p>t</p>', '<style')
drops('data: URL on a link', '<a href="data:text/html,<script>alert(1)</script>">x</a>', 'data:text/html')
drops('expression in a style value', '<p style="width:expression(alert(1))">t</p>', 'expression')
drops('entity-encoded javascript:', '<a href="&#106;avascript:alert(1)">x</a>', 'javascript:')

console.log('\n=== the send path itself sanitises ===')
const graph = toGraphMessage({
  subject: 'Booking',
  to: [{ address: 'a@b.com' }],
  bodyHtml: '<p><strong>Rates</strong></p><script>alert(1)</script><img src=x onerror="alert(2)">',
})
const content = graph.body.content
const sendOk =
  content.includes('<strong>') && !content.includes('<script') && !content.includes('onerror')
console.log(`  ${sendOk ? 'PASS' : 'FAIL'}  toGraphMessage strips active content, keeps formatting`)
console.log(`        contentType: ${graph.body.contentType}`)
if (sendOk) pass += 1
else fail += 1

console.log('\n=== plain-text / empty bodies still work ===')
const empty = toGraphMessage({ subject: 's', to: [], bodyHtml: null })
const emptyOk = empty.body.content === ''
console.log(`  ${emptyOk ? 'PASS' : 'FAIL'}  null body -> '' (plain-text sends unaffected)`)
if (emptyOk) pass += 1
else fail += 1

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
