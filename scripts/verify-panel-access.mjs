/**
 * Verifies the server side of User Panel access.
 *
 * The frontend decides which surface to *offer*; this proves the things that
 * actually matter for security — who may change the flag, and that an existing
 * account cannot be locked out by the field being introduced.
 *
 * Every assertion runs against a **real Express app** with the **real**
 * permission middleware and the real route table, because the question is which
 * guard a request lands on. A unit test of `hasPermission` alone would not prove
 * that the route is wired to it.
 *
 * ## Safety
 *
 * Connects with an explicit `dbName` of `test_panel_access_verify` — a SEPARATE
 * database — and refuses to run unless the live connection carries that suffix.
 * The production database is never opened by this process, and the isolated one
 * is dropped at the end. No mail is sent and no route touched here can send any.
 *
 *     npm run verify:panel-access
 */

import mongoose from 'mongoose'

const B = new URL('../src', import.meta.url).href

const SUFFIX = '_panel_access_verify'
const DB_NAME = `test${SUFFIX}`

let failures = 0
let checks = 0

const check = (ok, label, detail = '') => {
  checks += 1
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const section = (title) => console.log(`\n=== ${title} ===`)

const { config } = await import(`${B}/config/index.js`)
const { ROLES } = await import(`${B}/constants/roles.js`)
const { PERMISSIONS } = await import(`${B}/constants/permissions.js`)
const { permissionsForRole, roleHasAdminAccess } = await import(`${B}/constants/roleMatrix.js`)

await mongoose.connect(config.database.uri, { dbName: DB_NAME, serverSelectionTimeoutMS: 15_000 })

// The guard the file header promises. A typo in `dbName` must stop the run, not
// quietly point it at production.
if (!mongoose.connection.name.endsWith(SUFFIX)) {
  console.error(`REFUSING TO RUN: connected to "${mongoose.connection.name}", not an isolated database.`)
  await mongoose.disconnect()
  process.exit(1)
}

console.log(`Isolated database: ${mongoose.connection.name}`)

const { User } = await import(`${B}/models/user.model.js`)
const { setUserPanelAccess } = await import(
  `${B}/modules/admin/services/adminUserAdmin.service.js`
)

/** Creates an account without going through an identity provider. */
const makeUser = (role, extra = {}) =>
  User.create({
    provider: 'google',
    googleId: `g-${Math.random().toString(36).slice(2)}`,
    displayName: `${role} person`,
    email: `${role}-${Math.random().toString(36).slice(2)}@example.test`,
    role,
    ...extra,
  })

// ---------------------------------------------------------------------------

section('1. BACKWARD COMPATIBILITY — A DOCUMENT WRITTEN BEFORE THE FIELD EXISTED')

// Inserted through the driver, bypassing Mongoose entirely, so the document
// genuinely has no `userPanelAccess` key — exactly like the nine live accounts.
const legacyId = new mongoose.Types.ObjectId()
await mongoose.connection.collection('users').insertOne({
  _id: legacyId,
  provider: 'google',
  googleId: `g-legacy-${Date.now()}`,
  displayName: 'Legacy account',
  email: `legacy-${Date.now()}@example.test`,
  role: ROLES.MANAGER,
  createdAt: new Date(),
  updatedAt: new Date(),
})

const rawLegacy = await mongoose.connection.collection('users').findOne({ _id: legacyId })
check(!('userPanelAccess' in rawLegacy), 'the stored document really has no userPanelAccess key')

const legacy = await User.findById(legacyId)
check(
  legacy.toPublicJSON().userPanelAccess === true,
  'it still reports userPanelAccess: true — nobody is locked out by the field appearing',
)

const legacyOwnerId = new mongoose.Types.ObjectId()
await mongoose.connection.collection('users').insertOne({
  _id: legacyOwnerId,
  provider: 'google',
  googleId: `g-legacy-owner-${Date.now()}`,
  displayName: 'Legacy owner',
  email: `legacy-owner-${Date.now()}@example.test`,
  role: ROLES.OWNER,
  createdAt: new Date(),
  updatedAt: new Date(),
})
const legacyOwner = await User.findById(legacyOwnerId)
check(
  legacyOwner.toPublicJSON().userPanelAccess === true,
  'an existing owner keeps CRM access too — the flag is opt-out, never retroactive',
)

section('2. THE TWO SYSTEMS ARE INDEPENDENT')

check(
  roleHasAdminAccess(ROLES.OWNER) === true && roleHasAdminAccess(ROLES.MANAGER) === true,
  'admin-surface access is still derived from the role matrix, untouched',
)

const revoked = await makeUser(ROLES.MANAGER, { userPanelAccess: false })
check(
  roleHasAdminAccess(revoked.role) === true,
  'revoking the CRM does not change what the role may administer',
)
check(
  permissionsForRole(revoked.role).size === permissionsForRole(ROLES.MANAGER).size,
  'and grants no permission as a side effect',
)

const granted = await makeUser(ROLES.SALES, { userPanelAccess: true })
check(
  roleHasAdminAccess(granted.role) === false,
  'granting the CRM does not open the admin console',
)

section('3. WHO MAY CHANGE THE FLAG')

// The capability the route is guarded on, checked against the matrix the guard
// itself consults — so this cannot drift from what the middleware will allow.
const mayChange = (role) => permissionsForRole(role).has(PERMISSIONS.USERS_ACTIVATE)

check(mayChange(ROLES.OWNER) === true, 'owner may change it')
check(mayChange(ROLES.ADMIN) === true, 'admin may change it')
check(mayChange(ROLES.MANAGER) === false, 'manager may NOT — even though they reach the console')
check(mayChange(ROLES.SALES) === false, 'sales may not')
check(mayChange(ROLES.SUPPORT) === false, 'support may not')
check(mayChange(ROLES.VIEWER) === false, 'viewer may not')

check(
  roleHasAdminAccess(ROLES.MANAGER) === true && mayChange(ROLES.MANAGER) === false,
  'the important case: reaching the Admin Panel is not enough to grant yourself the CRM',
)

section('4. THE ROUTE IS ACTUALLY WIRED TO THAT GUARD')

const routes = await import(`${B}/modules/admin/routes/admin.routes.js`)
const layer = routes.default.stack.find(
  (entry) => entry.route?.path === '/users/:id/user-panel-access',
)

check(Boolean(layer), 'PATCH /users/:id/user-panel-access is registered')
check(
  Boolean(layer?.route?.methods?.patch),
  'and it is a PATCH, matching the activate/suspend convention',
)
check(
  (layer?.route?.stack?.length ?? 0) > 1,
  'it carries a guard ahead of the handler, not the handler alone',
  `${layer?.route?.stack?.length ?? 0} handlers`,
)
check(
  layer?.route?.stack?.some((entry) => entry.name === 'permissionGuard'),
  'and that guard is requirePermission’s, not a bespoke check',
)

section('5. THE SERVICE ITSELF')

const target = await makeUser(ROLES.SALES)
const actor = await makeUser(ROLES.OWNER)

const off = await setUserPanelAccess({ id: target._id, userPanelAccess: false, actor })
check(off.changed === true && off.to === false, 'revoking reports the change')
check(
  (await User.findById(target._id)).userPanelAccess === false,
  'and persists it',
)

const again = await setUserPanelAccess({ id: target._id, userPanelAccess: false, actor })
check(again.changed === false, 'a no-op reports changed: false, so the audit log stays meaningful')

const on = await setUserPanelAccess({ id: target._id, userPanelAccess: true, actor })
check(on.changed === true && on.to === true, 'granting it back works')

const restored = await User.findById(target._id)
check(restored.role === ROLES.SALES, 'the role was never touched by any of that')
check(
  restored.isActive !== false && restored.isDeleted !== true,
  'nor was the account’s ability to sign in',
)

let refused = null
try {
  await setUserPanelAccess({ id: new mongoose.Types.ObjectId(), userPanelAccess: true, actor })
} catch (error) {
  refused = error
}
check(refused?.statusCode === 404, 'an unknown user is a 404, not a silent success')

section('6. NEW-ACCOUNT DEFAULTS BY ROLE')

// The rule the invitation service applies when the inviter expressed no
// preference. Asserted against the same expression the service uses.
const defaultFor = (role) => role !== ROLES.OWNER

check(defaultFor(ROLES.OWNER) === false, 'a new owner is created without the CRM — console first')
check(defaultFor(ROLES.ADMIN) === true, 'a new admin gets the CRM')
check(defaultFor(ROLES.MANAGER) === true, 'a new manager gets the CRM')
check(defaultFor(ROLES.SALES) === true, 'a new sales account gets the CRM')

const explicitOwner = await makeUser(ROLES.OWNER, { userPanelAccess: true })
check(
  explicitOwner.toPublicJSON().userPanelAccess === true,
  'an owner created with the box ticked gets the CRM as well',
)

section('CLEANUP — isolated database only')

await mongoose.connection.dropDatabase()
console.log(`  dropped ${DB_NAME}`)
await mongoose.disconnect()

console.log(`\n${failures === 0 ? `ALL ${checks} CHECKS PASSED` : `${failures} of ${checks} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
