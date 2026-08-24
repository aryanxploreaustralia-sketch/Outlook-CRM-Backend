/**
 * The new-user sign-in failure, and the unlink that resolves it.
 *
 * ## What this reproduces
 *
 * A person is removed and re-created. The removed account keeps its Google
 * `sub`, and the unique index on `googleId` has a partial filter of
 * `{ googleId: { $type: 'string' } }` — which covers deleted documents. So the
 * replacement account cannot be stamped with that `sub` and its owner can never
 * sign in.
 *
 * ## It uses the real database
 *
 * Because the failure *is* an index, and an index cannot be reproduced against
 * a stub. Everything it writes it creates itself under a reserved throwaway
 * address and removes again in a `finally` — it never reads, writes or deletes
 * a real account.
 */

const B = new URL('../src', import.meta.url).href
const { connectDatabase, disconnectDatabase } = await import(`${B}/config/database.js`)
const { User } = await import(`${B}/models/user.model.js`)
const { resolveGoogleUser } = await import(`${B}/modules/auth-google/services/googleIdentity.service.js`)
const { unlinkGoogleIdentity } = await import(`${B}/modules/admin/services/adminUserAdmin.service.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)
const { USER_STATUS } = await import(`${B}/constants/userStatus.js`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (ok) pass += 1
  else fail += 1
}

/** Reserved for this test. Nothing real may use it. */
const EMAIL = 'zz-relink-probe@example.invalid'
const SUB = '999999999999999999901'
const created = []

/** The claims Google returns for a verified consumer account. */
const claims = { sub: SUB, email: EMAIL, email_verified: true, name: 'Relink Probe' }

async function makeUser({ deleted, role, googleId = null }) {
  const user = await User.create({
    email: EMAIL,
    displayName: 'Relink Probe',
    role,
    status: deleted ? 'disabled' : USER_STATUS.ACTIVE,
    isDeleted: deleted,
    provider: 'google',
    googleId,
  })
  created.push(user._id)
  return user
}

await connectDatabase()

try {
  // Refuse to run if the address is not actually free.
  const strays = await User.countDocuments({ email: EMAIL })
  if (strays > 0) throw new Error(`${EMAIL} already exists — refusing to touch it`)

  console.log('\n1. The failure, reproduced against the real index')
  const removed = await makeUser({ deleted: true, role: ROLES.VIEWER, googleId: SUB })
  const replacement = await makeUser({ deleted: false, role: ROLES.SALES })
  check('a removed account holds the Google sub', String(removed.googleId) === SUB)
  check('the replacement account holds none', replacement.googleId === undefined || replacement.googleId === null)

  let refusal = null
  try {
    await resolveGoogleUser({ claims })
  } catch (error) {
    refusal = error
  }
  check('sign-in is refused', Boolean(refusal), refusal ? '' : 'IT SUCCEEDED')
  check('with a 409, not a crash', refusal?.statusCode === 409, String(refusal?.statusCode))
  check('and a safe, actionable message',
    /removed CRM account/i.test(refusal?.message ?? ''), refusal?.message)
  check('no provider internals leaked to the user',
    !/E11000|index|mongo|sub|googleId/i.test(refusal?.message ?? ''), refusal?.message)

  console.log('\n2. The remediation the message names')
  const actor = { _id: '000000000000000000c11c11', role: ROLES.OWNER }
  const result = await unlinkGoogleIdentity({ id: String(removed._id), actor })
  check('unlink succeeds on the removed account', result.event === 'identity.unlinked')
  check('it returns what was released', String(result.previous) === SUB, String(result.previous))
  const after = await User.findById(removed._id).lean()
  check('the removed account no longer holds it', after.googleId === null, String(after.googleId))
  check('and is still removed — no account was restored', after.isDeleted === true)

  console.log('\n3. The same sign-in now succeeds')
  const out = await resolveGoogleUser({ claims })
  check('a user is resolved', Boolean(out?.user))
  check('it is the replacement, not the removed one',
    String(out.user._id) === String(replacement._id), String(out.user._id))
  check('the sub is now stamped on it', String(out.user.googleId) === SUB, String(out.user.googleId))
  check('the role assigned by the admin is preserved', out.user.role === ROLES.SALES, out.user.role)
  check('the account is active', out.user.status === USER_STATUS.ACTIVE, out.user.status)

  console.log('\n4. Signing in again is stable')
  const again = await resolveGoogleUser({ claims })
  check('resolves the same account', String(again.user._id) === String(replacement._id))
  check('now matched by googleId rather than email', again.linkedExisting === false)

  console.log('\n5. The guard still protects a live account')
  let guarded = null
  try {
    await unlinkGoogleIdentity({ id: String(replacement._id), actor })
  } catch (error) {
    guarded = error
  }
  check('unlinking a live account with no other identity is refused', Boolean(guarded),
    guarded ? '' : 'IT WAS ALLOWED')
  check('refused as a conflict, naming the reason', guarded?.statusCode === 409,
    `${guarded?.statusCode}: ${guarded?.message}`)
  const stillThere = await User.findById(replacement._id).lean()
  check('the live account kept its identity', String(stillThere.googleId) === SUB)

  console.log('\n6. Unlinking an account that has none is refused')
  let none = null
  try {
    await unlinkGoogleIdentity({ id: String(removed._id), actor })
  } catch (error) {
    none = error
  }
  check('refused', Boolean(none) && none.statusCode === 409, String(none?.statusCode))
} finally {
  // Everything this test made, removed — including on failure.
  if (created.length > 0) {
    await User.deleteMany({ _id: { $in: created }, email: EMAIL })
    const left = await User.countDocuments({ email: EMAIL })
    console.log(`\n  cleanup: ${created.length} probe account(s) removed, ${left} left behind`)
  }
  await disconnectDatabase()
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
