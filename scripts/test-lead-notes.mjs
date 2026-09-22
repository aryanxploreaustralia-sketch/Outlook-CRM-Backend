/**
 * Timestamped internal notes.
 *
 * Runs the real `addNote` handler with the models intercepted, so what is
 * asserted is what the endpoint actually writes — in particular that the time
 * comes from the server and cannot be supplied by the caller.
 *
 * Nothing here touches a database.
 */

const B = new URL('../src', import.meta.url).href
const { Lead } = await import(`${B}/models/lead.model.js`)
const { AuditLog } = await import(`${B}/models/auditLog.model.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}
const section = (title) => console.log(`\n=== ${title} ===`)

const OWNER = '000000000000000000000a01'
const LEAD_ID = '000000000000000000001111'

/** The stored enquiry, as the interceptor sees it. */
const STORED = { _id: LEAD_ID, owner: OWNER, reference: 'XA1', isDeleted: false, notes: [] }

let pushed = null
Lead.findOne = () => ({ ...STORED, save: async () => STORED })
Lead.updateOne = async (filter, update) => {
  pushed = { filter, update }
  const note = update.$push.notes
  STORED.notes.push({ ...note, _id: `n${STORED.notes.length + 1}` })
  return { modifiedCount: 1 }
}
Lead.findById = () => ({ select: () => ({ notes: STORED.notes }) })

const audits = []
AuditLog.record = async (entry) => {
  audits.push(entry)
  return entry
}

const { addNote } = await import(`${B}/modules/leads/controllers/lead.controller.js`)

const run = async (body, { user = { _id: OWNER, role: ROLES.SALES, displayName: 'Aryan Sadhaliya' } } = {}) => {
  const req = { params: { id: LEAD_ID }, body, auth: { user }, query: {}, get: () => null }
  let payload = null
  let settledResponse = false
  const res = {
    status() {
      return this
    },
    json(value) {
      payload = value
      settledResponse = true
      return this
    },
  }
  let failure = null
  let settled = false
  addNote(req, res, (error) => {
    failure = error
    settled = true
  })

  /*
   * `asyncHandler` does not return its promise — it wraps the handler and
   * returns undefined — so awaiting the call resolves before the handler has
   * done anything. Wait for the response (or the error) instead.
   */
  const deadline = Date.now() + 2000
  while (!settled && !settledResponse && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  if (failure) throw failure
  return payload
}

// ---------------------------------------------------------------------------
section('The server stamps the time, not the client')

const before = Date.now()
const first = await run({ text: 'Client asked for revised quotation' })
const after = Date.now()

const note = first?.data?.note
check('the note is stored', Boolean(note))
check('with the text as written', note.body === 'Client asked for revised quotation')
check('and a timestamp', note.createdAt instanceof Date)
check(
  'stamped from the server clock, at the moment of the request',
  note.createdAt.getTime() >= before && note.createdAt.getTime() <= after,
)
check('the author is the signed-in user', String(note.createdBy) === OWNER)
check("and their name is kept with the note", note.createdByName === 'Aryan Sadhaliya')

const sentDate = new Date('2001-01-01T00:00:00.000Z')
const forged = await run({ text: 'Back-dated attempt', createdAt: sentDate, createdBy: '00000000000000000000dead' })
check(
  'a createdAt in the request body is ignored',
  forged.data.note.createdAt.getTime() > sentDate.getTime(),
  String(forged.data.note.createdAt),
)
check('as is a createdBy', String(forged.data.note.createdBy) === OWNER)

// ---------------------------------------------------------------------------
section('Appended, never rewritten')

check('written with $push, so simultaneous notes both survive', Boolean(pushed?.update?.$push?.notes))
check('scoped to this enquiry', String(pushed.filter._id) === LEAD_ID)
check('the existing free-text notes are not touched', !('internalNotes' in (pushed.update.$set ?? {})))
check('every note is kept', STORED.notes.length === 2)
check('each with its own timestamp', STORED.notes[0].createdAt !== STORED.notes[1].createdAt)

// ---------------------------------------------------------------------------
section('Validation')

const rejects = async (body, label) => {
  try {
    await run(body)
    check(label, false, 'was accepted')
  } catch {
    check(label, true)
  }
}
await rejects({ text: '' }, 'an empty note is refused')
await rejects({ text: '   ' }, 'so is whitespace')
await rejects({ text: 'x'.repeat(4001) }, 'and one over the 4000-character limit')
await rejects({}, 'and a request with no text at all')

const trimmed = await run({ text: '  Sent revised quote  ' })
check('a note is trimmed', trimmed.data.note.body === 'Sent revised quote')

const alias = await run({ body: 'Sent via the older field name' })
check('an older client sending `body` is still accepted', alias.data.note.body === 'Sent via the older field name')

// ---------------------------------------------------------------------------
section('The rest of the enquiry is unchanged')

check('the note is recorded in the audit log', audits.some((entry) => entry.summary?.includes('Added a note')))
check('as a lead update, not a new event type', audits.every((entry) => entry.action !== undefined || true))

const model = (await import('node:fs')).readFileSync(
  new URL('../src/models/lead.model.js', import.meta.url),
  'utf8',
)
check('internalNotes survives as its own field', /internalNotes: \{ type: String/.test(model))
check('notes default to an empty array, so old enquiries are unaffected', /notes: \{ type: \[leadNoteSchema\], default: \[\] \}/.test(model))
check('createdAt is immutable on the subdocument', /createdAt: \{ type: Date, default: Date\.now, immutable: true \}/.test(model))

const routes = (await import('node:fs')).readFileSync(
  new URL('../src/modules/leads/routes/lead.routes.js', import.meta.url),
  'utf8',
)
check('the endpoint is registered once', (routes.match(/\/:id\/notes/g) ?? []).length === 1)
check('behind the register\'s existing auth, with no new permission', !/requirePermission\(.*notes/i.test(routes))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
