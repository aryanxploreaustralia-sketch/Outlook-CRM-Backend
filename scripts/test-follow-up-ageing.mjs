/**
 * Follow-up ageing: the clock runs from the enquiry's quote date.
 *
 * These call the real `daysSinceQuote`, `followUpStatusOf` and
 * `eligibilityFilter` out of the service — not a reimplementation of them — so
 * a change to the rule breaks these rather than quietly passing.
 *
 * The dates are fixed rather than relative to the wall clock: a test that says
 * "three days ago" is a test that behaves differently at 00:01 than at 23:59,
 * and this is precisely the arithmetic that must not do that.
 */

const B = new URL('../src', import.meta.url).href
const { daysSinceQuote, followUpStatusOf, eligibilityFilter } = await import(
  `${B}/modules/leads/services/followUp.service.js`
)
const { FOLLOW_UP_STATUS, FOLLOW_UP_WAIT_DAYS } = await import(
  `${B}/modules/leads/constants/followUpConstants.js`
)
const { AUTO_MAIL_STATUS } = await import(`${B}/modules/leads/constants/syncConstants.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

/** The importer stores every quote date at midnight UTC; so does this. */
const quotedOn = (iso) => new Date(`${iso}T00:00:00.000Z`)
const at = (iso, time = '12:00:00.000') => new Date(`${iso}T${time}Z`)

/** A lead that is eligible in every respect except its age. */
const lead = (overrides = {}) => ({
  quoteDate: quotedOn('2026-08-20'),
  email: 'customer@example.com',
  stage: 'active',
  replyReceived: false,
  doNotContact: false,
  followUp: { count: 0 },
  autoMail: { status: AUTO_MAIL_STATUS.SENT, sentAt: at('2026-08-20') },
  ...overrides,
})

console.log('\nDay counting from the quote date')
// The brief's own worked example: 20 Aug quoted, then 21/22/23 Aug.
for (const [day, expected] of [
  ['2026-08-20', 0],
  ['2026-08-21', 1],
  ['2026-08-22', 2],
  ['2026-08-23', 3],
  ['2026-08-25', 5],
  ['2026-08-27', 7],
  ['2026-08-30', 10],
]) {
  const actual = daysSinceQuote(lead(), at(day))
  check(`quoted 20 Aug, read on ${day.slice(8)} Aug -> ${expected}d`, actual === expected, `got ${actual}`)
}

console.log('\nTime of day must not move the count (the off-by-one guard)')
for (const time of ['00:00:00.000', '00:00:00.001', '06:30:00.000', '12:00:00.000', '23:59:59.999']) {
  const actual = daysSinceQuote(lead(), at('2026-08-23', time))
  check(`23 Aug at ${time} -> 3d`, actual === 3, `got ${actual}`)
}

console.log('\nThe day boundary itself')
check(
  'one millisecond before the 3rd day -> 2d',
  daysSinceQuote(lead(), new Date(quotedOn('2026-08-23').getTime() - 1)) === 2,
)
check(
  'exactly the 3rd day -> 3d',
  daysSinceQuote(lead(), quotedOn('2026-08-23')) === 3,
)

console.log(`\nEligibility (threshold is ${FOLLOW_UP_WAIT_DAYS} days)`)
const statusOn = (day, overrides) => followUpStatusOf(lead(overrides), at(day))
check('0 days  -> waiting', statusOn('2026-08-20') === FOLLOW_UP_STATUS.WAITING)
check('1 day   -> waiting', statusOn('2026-08-21') === FOLLOW_UP_STATUS.WAITING)
check('2 days  -> waiting', statusOn('2026-08-22') === FOLLOW_UP_STATUS.WAITING)
check('3 days  -> ELIGIBLE', statusOn('2026-08-23') === FOLLOW_UP_STATUS.ELIGIBLE)
check('5 days  -> ELIGIBLE', statusOn('2026-08-25') === FOLLOW_UP_STATUS.ELIGIBLE)
check('7 days  -> ELIGIBLE', statusOn('2026-08-27') === FOLLOW_UP_STATUS.ELIGIBLE)
check('14 days -> ELIGIBLE', statusOn('2026-09-03') === FOLLOW_UP_STATUS.ELIGIBLE)

console.log('\nMissing quote date — never invented, never eligible')
check('daysSinceQuote is null', daysSinceQuote(lead({ quoteDate: null })) === null)
check('undefined is null too', daysSinceQuote(lead({ quoteDate: undefined })) === null)
check('no lead at all is null', daysSinceQuote(null) === null)
check(
  'status is not_eligible however old the introduction',
  statusOn('2026-12-31', { quoteDate: null }) === FOLLOW_UP_STATUS.NOT_ELIGIBLE,
)

console.log('\nReply handling is unchanged and still authoritative')
check(
  'replied lead is not eligible even at 10 days',
  statusOn('2026-08-30', { replyReceived: true }) === FOLLOW_UP_STATUS.NOT_ELIGIBLE,
)
check(
  'unreplied lead at the same age is eligible',
  statusOn('2026-08-30', { replyReceived: false }) === FOLLOW_UP_STATUS.ELIGIBLE,
)
check(
  'age alone does not override do-not-contact',
  statusOn('2026-08-30', { doNotContact: true }) === FOLLOW_UP_STATUS.NOT_ELIGIBLE,
)
check(
  'already followed up -> sent, not eligible again',
  statusOn('2026-08-30', { followUp: { count: 1 } }) === FOLLOW_UP_STATUS.SENT,
)
check(
  'no introduction sent -> not eligible (nothing to follow up)',
  statusOn('2026-08-30', { autoMail: { status: AUTO_MAIL_STATUS.PENDING, sentAt: null } }) ===
    FOLLOW_UP_STATUS.NOT_ELIGIBLE,
)

console.log('\nThe query narrows on quoteDate, not on the introduction date')
const filter = eligibilityFilter({ owner: 'u1', now: at('2026-08-23') })
check('filter carries a quoteDate bound', Boolean(filter.quoteDate?.$lte))
check('filter no longer bounds autoMail.sentAt', filter['autoMail.sentAt'] === undefined)
check(
  'the bound is exactly the threshold',
  filter.quoteDate.$lte.getTime() === at('2026-08-23').getTime() - FOLLOW_UP_WAIT_DAYS * 86_400_000,
)
check('an introduction is still required', filter['autoMail.status'] === AUTO_MAIL_STATUS.SENT)
check('replies still exclude', filter.replyReceived?.$ne === true)
check('the sequence ceiling still applies', filter['followUp.count']?.$lt !== undefined)

console.log('\nA lead quoted exactly at the threshold is caught by the query')
{
  const now = at('2026-08-23')
  const bound = eligibilityFilter({ owner: 'u1', now }).quoteDate.$lte
  check('quoted 20 Aug is on or before the bound', quotedOn('2026-08-20') <= bound)
  check('quoted 21 Aug is after the bound', quotedOn('2026-08-21') > bound)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
