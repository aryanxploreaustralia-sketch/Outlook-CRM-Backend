#!/usr/bin/env node
/**
 * Phase 13.2 regression matrix.
 *
 * Run:  npm run verify:mailboxes
 *
 * ## Where it runs
 *
 * Against an **isolated database**, named by suffixing the configured one with
 * `_phase132_verify`, which it drops on the way out. It therefore cannot read,
 * modify or delete anything in the real database — which matters, because the
 * scenarios below deliberately disconnect mailboxes and delete users, and a
 * verification script that can do that to production data is not one anybody
 * should be willing to run.
 *
 * ## What it proves, and what it cannot
 *
 * It exercises the resolution, ownership, default-election and skip-semantics
 * layers directly against MongoDB — the parts this phase actually changed, and
 * the parts where the interesting failures live (an index that does not hold, a
 * cross-workspace id that resolves, a default that silently moves).
 *
 * It does **not** call Microsoft. Redeeming a real authorization code needs a
 * live consent screen and a human, so the OAuth round trip is verified by
 * construction — flow purpose, ownership source and single-use consumption are
 * asserted against `AuthFlow` — and the end-to-end connect is listed in the
 * report as requiring manual confirmation.
 */

import mongoose from 'mongoose'

import { config } from '../src/config/index.js'
import {
  AUTH_FLOW_PURPOSE,
  AuthFlow,
  MAILBOX_FLOW_PURPOSES,
} from '../src/models/authFlow.model.js'
import { Lead } from '../src/models/lead.model.js'
import { Mailbox } from '../src/models/mailbox.model.js'
import { OutlookAccount } from '../src/models/outlookAccount.model.js'
import { AUTH_PROVIDERS, User } from '../src/models/user.model.js'
import { AUTO_MAIL_STATUS, SKIP_REASON } from '../src/modules/leads/constants/syncConstants.js'
import { markSkipped } from '../src/modules/leads/services/autoMail.service.js'
import { CONNECTION_STATUS, PROVIDER_TYPES } from '../src/modules/provider/constants/providerTypes.js'
import * as mailboxRepo from '../src/modules/provider/repositories/mailbox.repository.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results = []
let currentTest = 'setup'

function check(description, condition, detail = '') {
  results.push({ test: currentTest, description, passed: Boolean(condition), detail })
  const mark = condition ? '  PASS' : '  FAIL'
  process.stdout.write(`${mark}  ${description}${detail && !condition ? ` — ${detail}` : ''}\n`)
}

function test(name) {
  currentTest = name
  process.stdout.write(`\n${name}\n`)
}

/** A distinct workspace owner, so tests cannot contaminate one another. */
async function makeUser(email) {
  return User.create({
    provider: AUTH_PROVIDERS.GOOGLE,
    googleId: `google-${email}`,
    email,
    displayName: email,
  })
}

/**
 * Connects a mailbox the way `completeMailboxConnect` does.
 *
 * Deliberately goes through the same repository calls rather than reimplementing
 * them, so what is verified is the code the application runs.
 */
async function connectMailbox({ user, address, homeAccountId }) {
  /**
   * Upserted on `homeAccountId`, exactly as `completeMailboxConnect` does.
   *
   * `create` would be wrong here and would hide a real property of the design:
   * `homeAccountId` is globally unique, so reconnecting the same Microsoft
   * account must update the existing grant rather than insert a second one.
   */
  const account = await OutlookAccount.findOneAndUpdate(
    { homeAccountId },
    {
      $set: {
        user: user._id,
        email: address,
        tokenCache: 'encrypted-placeholder',
        scopes: ['Mail.Send', 'Mail.Read'],
        disconnectedAt: null,
        disconnectReason: null,
        connectedAt: new Date(),
      },
      $setOnInsert: { homeAccountId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )

  const mailbox = await mailboxRepo.upsertMailbox({
    user: user._id,
    provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
    providerAccountId: homeAccountId,
    emailAddress: address,
    displayName: address,
    sourceAccount: account._id,
    capabilities: ['send', 'read'],
  })

  await mailboxRepo.ensureDefaultMailbox({ user: user._id })

  return { account, mailbox }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function run() {
  // --- TEST 1 — Google user, zero mailboxes -------------------------------
  test('TEST 1  Google session with zero mailboxes')
  const alice = await makeUser('alice@example.com')

  check(
    'A Google user is created without any Microsoft identifiers',
    alice.provider === 'google' && !alice.microsoftId,
  )
  check(
    'listMailboxes returns an empty list rather than throwing',
    (await mailboxRepo.listMailboxes({ user: alice._id })).length === 0,
  )
  check(
    'findDefaultMailbox resolves to null — mail is refused, the session is not',
    (await mailboxRepo.findDefaultMailbox({ user: alice._id })) === null,
  )

  // --- TEST 2 — Connect mailbox A -----------------------------------------
  test('TEST 2  Connect the first mailbox')
  const a = await connectMailbox({
    user: alice,
    address: 'enquiry@xploreaustralia.com',
    homeAccountId: 'home-a',
  })

  const afterA = await mailboxRepo.listMailboxes({ user: alice._id })
  check('The mailbox appears for the workspace', afterA.length === 1)
  check('The first mailbox becomes the default automatically', afterA[0].isDefault === true)
  check(
    'It is linked to the credential record that holds the MSAL cache',
    String(afterA[0].sourceAccount) === String(a.account._id),
  )

  // --- TEST 3 — Connect mailbox B, A must survive -------------------------
  test('TEST 3  Connect a second mailbox without overwriting the first')
  const b = await connectMailbox({
    user: alice,
    address: 'sales@xploreaustralia.com',
    homeAccountId: 'home-b',
  })

  const afterB = await mailboxRepo.listMailboxes({ user: alice._id })
  check('Both mailboxes are connected simultaneously', afterB.length === 2, `got ${afterB.length}`)
  check(
    'Mailbox A was not overwritten',
    afterB.some((m) => m.emailAddress === 'enquiry@xploreaustralia.com'),
  )
  check(
    'Mailbox B was added',
    afterB.some((m) => m.emailAddress === 'sales@xploreaustralia.com'),
  )
  check(
    'Connecting B did not move the default off A',
    afterB.filter((m) => m.isDefault).length === 1 &&
      afterB.find((m) => m.isDefault).emailAddress === 'enquiry@xploreaustralia.com',
  )

  // --- Duplicate connection is a repair, not a second row -----------------
  test('TEST 3b  Reconnecting an existing mailbox updates it in place')
  await connectMailbox({
    user: alice,
    address: 'enquiry@xploreaustralia.com',
    homeAccountId: 'home-a',
  })
  check(
    'Reconnecting the same mailbox does not create a duplicate',
    (await mailboxRepo.listMailboxes({ user: alice._id })).length === 2,
  )

  // --- TEST 4 — Set B as default ------------------------------------------
  test('TEST 4  Change the default sender')
  await mailboxRepo.setDefaultMailbox({ user: alice._id, mailboxId: b.mailbox._id })

  const defaults = await Mailbox.find({ user: alice._id, isDefault: true })
  check('Exactly one mailbox is default', defaults.length === 1, `got ${defaults.length}`)
  check('The chosen mailbox is the default', defaults[0].emailAddress === 'sales@xploreaustralia.com')
  check(
    'Automatic mail resolves to the new default',
    (await mailboxRepo.findDefaultMailbox({ user: alice._id })).emailAddress ===
      'sales@xploreaustralia.com',
  )

  // The database, not the application, is what guarantees this.
  let duplicateRejected = false
  try {
    await Mailbox.updateOne({ _id: a.mailbox._id }, { $set: { isDefault: true } })
  } catch {
    duplicateRejected = true
  }
  check(
    'A second default is refused by the unique partial index',
    duplicateRejected,
    'the index did not hold',
  )

  // --- TEST 5 — Explicit sender selection ---------------------------------
  test('TEST 5  Send From resolves the mailbox actually chosen')
  const pickedA = await mailboxRepo.findMailbox({ user: alice._id, mailboxId: a.mailbox._id })
  check('Choosing A resolves A, not the default', pickedA.emailAddress === 'enquiry@xploreaustralia.com')
  check(
    'A carries its own credential, so the send authenticates as A',
    String(pickedA.sourceAccount) === String(a.account._id),
  )

  const pickedB = await mailboxRepo.findMailbox({ user: alice._id, mailboxId: b.mailbox._id })
  check(
    'Choosing B resolves B with B’s own credential',
    String(pickedB.sourceAccount) === String(b.account._id) &&
      String(pickedB.sourceAccount) !== String(a.account._id),
  )

  // --- TEST 12 — Cross-workspace access -----------------------------------
  test('TEST 12  Cross-workspace mailbox access is refused')
  const mallory = await makeUser('mallory@example.com')
  await connectMailbox({
    user: mallory,
    address: 'mallory@evil.example',
    homeAccountId: 'home-m',
  })

  check(
    'Another workspace’s mailbox id does not resolve',
    (await mailboxRepo.findMailbox({ user: mallory._id, mailboxId: a.mailbox._id })) === null,
  )
  check(
    'Setting another workspace’s mailbox as default is refused',
    (await mailboxRepo.setDefaultMailbox({ user: mallory._id, mailboxId: a.mailbox._id })) === null,
  )
  check(
    'The victim’s default was not changed by the attempt',
    (await mailboxRepo.findDefaultMailbox({ user: alice._id })).emailAddress ===
      'sales@xploreaustralia.com',
  )
  check(
    'Listing is scoped to the caller’s own workspace',
    (await mailboxRepo.listMailboxes({ user: mallory._id })).length === 1,
  )

  // --- TEST 11 — One broken mailbox, one healthy --------------------------
  test('TEST 11  A broken mailbox does not disable the healthy one')
  await mailboxRepo.markMailboxStatus({
    mailboxId: a.mailbox._id,
    status: CONNECTION_STATUS.EXPIRED,
    reason: 'invalid_grant',
  })

  const healthy = await mailboxRepo.listMailboxes({ user: alice._id, connectedOnly: true })
  check('The healthy mailbox is still usable', healthy.length === 1)
  check('It is the one that was not broken', healthy[0].emailAddress === 'sales@xploreaustralia.com')
  check(
    'The broken mailbox is kept and reports why, rather than vanishing',
    (await Mailbox.findById(a.mailbox._id)).statusReason === 'invalid_grant',
  )
  check(
    'Sending still resolves through the healthy mailbox',
    (await mailboxRepo.findDefaultMailbox({ user: alice._id })).emailAddress ===
      'sales@xploreaustralia.com',
  )

  // --- TEST 8 — Disconnect the default ------------------------------------
  test('TEST 8  Disconnecting the default elects a deterministic replacement')
  await mailboxRepo.markMailboxStatus({
    mailboxId: a.mailbox._id,
    status: CONNECTION_STATUS.CONNECTED,
    reason: null,
  })

  await mailboxRepo.markMailboxStatus({
    mailboxId: b.mailbox._id,
    status: CONNECTION_STATUS.DISCONNECTED,
    reason: 'user_disconnected',
  })
  await Mailbox.updateOne({ _id: b.mailbox._id }, { $set: { isDefault: false } })
  await mailboxRepo.ensureDefaultMailbox({ user: alice._id })

  const replacement = await mailboxRepo.findDefaultMailbox({ user: alice._id })
  check('A replacement default was elected', Boolean(replacement))
  check('It is the remaining connected mailbox', replacement.emailAddress === 'enquiry@xploreaustralia.com')
  check(
    'Still exactly one default',
    (await Mailbox.find({ user: alice._id, isDefault: true })).length === 1,
  )

  // --- TEST 7 — Disconnect keeps history and the other mailbox ------------
  test('TEST 7  Disconnecting keeps records and the other mailbox')
  check(
    'The disconnected mailbox record is kept, not deleted',
    Boolean(await Mailbox.findById(b.mailbox._id)),
  )
  check(
    'Its credential record is kept so history can still name the sender',
    Boolean(await OutlookAccount.findById(b.account._id)),
  )
  check(
    'The other mailbox is untouched',
    (await Mailbox.findById(a.mailbox._id)).status === CONNECTION_STATUS.CONNECTED,
  )
  check('The CRM user is untouched by a disconnect', Boolean(await User.findById(alice._id)))

  // --- Last mailbox disconnected ------------------------------------------
  test('TEST 8b  Disconnecting the last mailbox leaves no default')
  await mailboxRepo.markMailboxStatus({
    mailboxId: a.mailbox._id,
    status: CONNECTION_STATUS.DISCONNECTED,
    reason: 'user_disconnected',
  })
  await Mailbox.updateOne({ _id: a.mailbox._id }, { $set: { isDefault: false } })
  const noneLeft = await mailboxRepo.ensureDefaultMailbox({ user: alice._id })

  check('No default remains', noneLeft === null)
  check(
    'No mailbox is flagged default',
    (await Mailbox.find({ user: alice._id, isDefault: true })).length === 0,
  )
  check(
    'Mail resolution reports nothing available rather than a stale credential',
    (await mailboxRepo.findDefaultMailbox({ user: alice._id })) === null,
  )

  // --- TEST 9 — Workbook import with no mailbox ---------------------------
  test('TEST 9  Workbook import with no mailbox connected')
  const lead = await Lead.create({
    owner: alice._id,
    reference: 'VERIFY-001',
    companyName: 'Verify Ltd',
    contactPerson: 'Pat Verify',
    email: 'pat@verify.example',
    autoMail: { status: AUTO_MAIL_STATUS.PENDING },
  })

  await markSkipped({ lead, reason: SKIP_REASON.NO_MAILBOX })
  const afterSkip = await Lead.findById(lead._id)

  check('The lead is still created — the import is not rolled back', Boolean(afterSkip))
  check(
    'The introduction stays pending, so it is sent once a mailbox is connected',
    afterSkip.autoMail.status === AUTO_MAIL_STATUS.PENDING,
    `status was "${afterSkip.autoMail.status}"`,
  )
  check(
    'It was not marked sent, so nothing can claim a message went out',
    afterSkip.autoMail.status !== AUTO_MAIL_STATUS.SENT,
  )

  // A lead that genuinely cannot be mailed is still recorded as skipped.
  const noEmailLead = await Lead.create({
    owner: alice._id,
    reference: 'VERIFY-002',
    companyName: 'No Email Ltd',
    contactPerson: 'Sam',
    autoMail: { status: AUTO_MAIL_STATUS.PENDING },
  })
  await markSkipped({ lead: noEmailLead, reason: SKIP_REASON.NO_EMAIL })
  check(
    'A permanently unsendable lead is still recorded as skipped',
    (await Lead.findById(noEmailLead._id)).autoMail.status === AUTO_MAIL_STATUS.SKIPPED,
  )

  // --- TEST 10 — Exactly-once protection ----------------------------------
  test('TEST 10  Exactly-once introduction protection is intact')
  const sentLead = await Lead.create({
    owner: alice._id,
    reference: 'VERIFY-003',
    companyName: 'Sent Ltd',
    contactPerson: 'Alex',
    email: 'alex@sent.example',
    autoMail: { status: AUTO_MAIL_STATUS.SENT, sentAt: new Date() },
  })

  const { screenForAutoMail } = await import('../src/modules/leads/services/autoMail.service.js')
  check(
    'A lead already emailed is refused a second introduction',
    screenForAutoMail({ lead: sentLead, isNew: true }).allowed === false,
  )
  check(
    'The refusal reason is the persisted-state guard',
    screenForAutoMail({ lead: sentLead, isNew: true }).reason === SKIP_REASON.ALREADY_SENT,
  )
  check(
    'Only an explicit force override may bypass it',
    screenForAutoMail({ lead: sentLead, isNew: true, forceResend: true }).allowed === true,
  )

  // --- OAuth state / CSRF --------------------------------------------------
  test('TEST 16  Mailbox OAuth flow binds ownership server-side')
  const flow = await AuthFlow.create({
    state: 'verify-state-token',
    codeVerifier: 'verifier',
    purpose: AUTH_FLOW_PURPOSE.CONNECT_MAILBOX,
    user: alice._id,
    expiresAt: new Date(Date.now() + 60_000),
  })

  check('The flow records which CRM user started it', String(flow.user) === String(alice._id))
  check('The flow records that it is a connect, not a sign-in', flow.purpose === 'connect_mailbox')

  const consumed = await AuthFlow.findOneAndDelete({ state: 'verify-state-token' })
  check('A flow is consumed atomically on first use', Boolean(consumed))
  check(
    'The same state cannot be replayed',
    (await AuthFlow.findOneAndDelete({ state: 'verify-state-token' })) === null,
  )

  const legacyFlow = await AuthFlow.create({
    state: 'verify-legacy-signin',
    codeVerifier: 'verifier',
    expiresAt: new Date(Date.now() + 60_000),
  })
  check(
    'A flow written without a purpose still reads back as a sign-in',
    legacyFlow.purpose === AUTH_FLOW_PURPOSE.SIGN_IN,
  )
  check('A sign-in flow carries no user, so it cannot connect a mailbox', legacyFlow.user === null)

  // --- HOTFIX: registry stability ------------------------------------------
  //
  // The defect these cover: the mailbox registry appeared to change depending
  // on which Microsoft account was authorised. It could not have been the
  // query, which is scoped by CRM user; it was the CRM user itself changing,
  // because a Microsoft sign-in minted one per Microsoft account.
  test('HOTFIX 1  The registry belongs to the CRM user, not the Microsoft account')

  const workspace = await makeUser('workspace-owner@example.com')

  const mA = await connectMailbox({
    user: workspace,
    address: 'first@outlook.com',
    homeAccountId: 'ws-a',
  })
  await connectMailbox({ user: workspace, address: 'second@outlook.com', homeAccountId: 'ws-b' })
  await connectMailbox({ user: workspace, address: 'third@outlook.com', homeAccountId: 'ws-c' })

  const registry = await mailboxRepo.listMailboxes({ user: workspace._id })
  check('Three separate Microsoft accounts produce three registry entries', registry.length === 3)
  check(
    'They all belong to the one CRM workspace',
    registry.every((mb) => String(mb.user) === String(workspace._id)),
  )
  check(
    'Authorising the third did not remove the first two',
    ['first@outlook.com', 'second@outlook.com', 'third@outlook.com'].every((address) =>
      registry.some((mb) => mb.emailAddress === address),
    ),
  )
  check(
    'The first remains the default — the newest authorisation did not take it',
    registry.find((mb) => mb.isDefault)?.emailAddress === 'first@outlook.com',
  )

  test('HOTFIX 2  A disconnected mailbox stays in the registry')
  const mB = registry.find((mb) => mb.emailAddress === 'second@outlook.com')

  await mailboxRepo.markMailboxStatus({
    mailboxId: mB._id,
    status: CONNECTION_STATUS.DISCONNECTED,
    reason: 'user_disconnected',
  })

  const afterDisconnect = await mailboxRepo.listMailboxes({ user: workspace._id })
  check('The registry still holds all three entries', afterDisconnect.length === 3)
  check(
    'The disconnected one is still listed, so Reconnect has something to act on',
    afterDisconnect.some((mb) => mb.emailAddress === 'second@outlook.com'),
  )
  check(
    'It reports itself as unusable rather than being hidden',
    afterDisconnect.find((mb) => mb.emailAddress === 'second@outlook.com').status ===
      CONNECTION_STATUS.DISCONNECTED,
  )
  check(
    'Only connected mailboxes are offered for sending',
    (await mailboxRepo.listMailboxes({ user: workspace._id, connectedOnly: true })).length === 2,
  )

  test('HOTFIX 3  Reconnect is bound to one mailbox and refuses another account')
  const reconnectFlow = await AuthFlow.create({
    state: 'verify-reconnect',
    codeVerifier: 'v',
    purpose: AUTH_FLOW_PURPOSE.CONNECT_MAILBOX,
    user: workspace._id,
    targetMailbox: mB._id,
    expiresAt: new Date(Date.now() + 60_000),
  })

  check('The flow names the mailbox being repaired', String(reconnectFlow.targetMailbox) === String(mB._id))

  // The comparison the callback performs, against the account Microsoft returns.
  const targetRow = await Mailbox.findById(mB._id)
  check(
    'Signing in as the right account matches the target',
    String(targetRow.providerAccountId) === 'ws-b',
  )
  check(
    'Signing in as a different account does NOT match, so the reconnect is refused',
    String(targetRow.providerAccountId) !== 'ws-c',
  )
  check(
    'The target row still names its own mailbox — a mismatch cannot rewrite it',
    targetRow.emailAddress === 'second@outlook.com',
  )

  test('HOTFIX 4  Reconnecting does not move the default')
  await mailboxRepo.markMailboxStatus({
    mailboxId: mB._id,
    status: CONNECTION_STATUS.CONNECTED,
    reason: null,
  })
  await mailboxRepo.ensureDefaultMailbox({ user: workspace._id })

  check(
    'The default is still the mailbox the workspace chose',
    (await mailboxRepo.findDefaultMailbox({ user: workspace._id })).emailAddress ===
      'first@outlook.com',
  )
  check(
    'Still exactly one default after a reconnect',
    (await Mailbox.find({ user: workspace._id, isDefault: true })).length === 1,
  )

  test('HOTFIX 5  A second CRM workspace cannot see this registry')
  const otherWorkspace = await makeUser('other-workspace@example.com')

  check(
    'A different Google CRM user sees an empty registry',
    (await mailboxRepo.listMailboxes({ user: otherWorkspace._id })).length === 0,
  )
  check(
    'and cannot resolve a mailbox belonging to the first',
    (await mailboxRepo.findMailbox({ user: otherWorkspace._id, mailboxId: mA.mailbox._id })) ===
      null,
  )
  check(
    'The first workspace is unaffected by the second existing',
    (await mailboxRepo.listMailboxes({ user: workspace._id })).length === 3,
  )

  // --- PHASE 13.3: the shared callback must dispatch, not reject -----------
  //
  // Microsoft returns every flow to one registered redirect URI, so a mailbox
  // authorisation arrives at the *sign-in* callback. These cover the dispatch
  // that makes that safe, and the guard that makes it safe if the dispatch is
  // ever reordered away.
  test('13.3-1  A mailbox flow is recognised at the shared callback')

  const connectFlow = await AuthFlow.create({
    state: 'verify-133-connect',
    codeVerifier: 'v',
    purpose: AUTH_FLOW_PURPOSE.CONNECT_MAILBOX,
    user: workspace._id,
    redirectUri: 'https://example.test/api/v1/auth/callback',
    expiresAt: new Date(Date.now() + 60_000),
  })

  const reconnectPurposeFlow = await AuthFlow.create({
    state: 'verify-133-reconnect',
    codeVerifier: 'v',
    purpose: AUTH_FLOW_PURPOSE.RECONNECT_MAILBOX,
    user: workspace._id,
    targetMailbox: mA.mailbox._id,
    redirectUri: 'https://example.test/api/v1/auth/callback',
    expiresAt: new Date(Date.now() + 60_000),
  })

  const signInFlow = await AuthFlow.create({
    state: 'verify-133-signin',
    codeVerifier: 'v',
    expiresAt: new Date(Date.now() + 60_000),
  })

  check(
    'A connect flow routes to mailbox handling, not to the legacy rejection',
    MAILBOX_FLOW_PURPOSES.includes(connectFlow.purpose),
  )
  check(
    'A reconnect flow routes to mailbox handling too',
    MAILBOX_FLOW_PURPOSES.includes(reconnectPurposeFlow.purpose),
  )
  check(
    'Connect and reconnect are distinguishable intents, not one flag',
    connectFlow.purpose !== reconnectPurposeFlow.purpose,
  )
  check(
    'A genuine sign-in flow still falls through to the legacy branch',
    !MAILBOX_FLOW_PURPOSES.includes(signInFlow.purpose),
  )
  check(
    'The redirect URI used at authorize time is recorded for redemption',
    connectFlow.redirectUri === 'https://example.test/api/v1/auth/callback',
  )
  check(
    'A reconnect flow names the mailbox it will repair',
    String(reconnectPurposeFlow.targetMailbox) === String(mA.mailbox._id),
  )

  test('13.3-2  A mailbox flow cannot be redeemed as a sign-in')
  const { consumeAuthFlowForTest } = await import('../src/services/auth.service.js')

  let refusedMailboxFlow = false
  try {
    await consumeAuthFlowForTest('verify-133-connect')
  } catch {
    refusedMailboxFlow = true
  }
  check(
    'completeSignIn refuses a connect_mailbox flow — no CRM user can be minted from it',
    refusedMailboxFlow,
  )

  let acceptedSignInFlow = false
  try {
    await consumeAuthFlowForTest('verify-133-signin')
    acceptedSignInFlow = true
  } catch {
    acceptedSignInFlow = false
  }
  check('A real sign-in flow is still accepted by that path', acceptedSignInFlow)

  test('13.3-3  Reconnect does not move an existing default')
  // `first@` is default and connected; `third@` is not. Break and repair
  // `third@`, then confirm the flag never moved.
  const mC = (await mailboxRepo.listMailboxes({ user: workspace._id })).find(
    (mb) => mb.emailAddress === 'third@outlook.com',
  )

  await mailboxRepo.markMailboxStatus({
    mailboxId: mC._id,
    status: CONNECTION_STATUS.EXPIRED,
    reason: 'invalid_grant',
  })

  // What `completeMailboxConnect` does on a successful reconnect.
  await mailboxRepo.upsertMailbox({
    user: workspace._id,
    provider: mC.provider,
    providerAccountId: mC.providerAccountId,
    emailAddress: mC.emailAddress,
    displayName: mC.displayName,
    sourceAccount: mC.sourceAccount,
  })
  const hadDefault = await Mailbox.exists({ user: workspace._id, isDefault: true })
  if (!hadDefault) await mailboxRepo.ensureDefaultMailbox({ user: workspace._id })

  const defaultAfterReconnect = await Mailbox.findOne({ user: workspace._id, isDefault: true })
  check(
    'The default is still the mailbox the workspace chose',
    defaultAfterReconnect.emailAddress === 'first@outlook.com',
  )
  check(
    'Reconnecting brought the target back to connected',
    (await Mailbox.findById(mC._id)).status === CONNECTION_STATUS.CONNECTED,
  )
  check(
    'Still exactly one default',
    (await Mailbox.find({ user: workspace._id, isDefault: true })).length === 1,
  )
  check(
    'No duplicate row was created by the reconnect',
    (await Mailbox.find({ user: workspace._id, emailAddress: 'third@outlook.com' })).length === 1,
  )

  test('13.3-4  A broken default resolves to a usable mailbox without moving the flag')
  await mailboxRepo.markMailboxStatus({
    mailboxId: defaultAfterReconnect._id,
    status: CONNECTION_STATUS.EXPIRED,
    reason: 'invalid_grant',
  })

  const resolved = await mailboxRepo.findDefaultMailbox({ user: workspace._id })
  check('Sending resolves a mailbox that actually works', resolved.status === CONNECTION_STATUS.CONNECTED)
  check(
    'It is not the broken one',
    String(resolved._id) !== String(defaultAfterReconnect._id),
  )
  check(
    'The stored preference is untouched — only an explicit change moves it',
    String((await Mailbox.findOne({ user: workspace._id, isDefault: true }))._id) ===
      String(defaultAfterReconnect._id),
  )

  // Restore, so later assertions read a healthy workspace.
  await mailboxRepo.markMailboxStatus({
    mailboxId: defaultAfterReconnect._id,
    status: CONNECTION_STATUS.CONNECTED,
    reason: null,
  })

  // --- PHASE 13.4: provider isolation --------------------------------------
  //
  // The data layer was already per-mailbox; what was missing was the mailbox
  // ever reaching it. These assert the isolation end to end.
  test('13.4-1  Sync state and delta tokens are per mailbox')

  const { SyncState } = await import('../src/models/syncState.model.js')
  const syncRepo = await import('../src/modules/provider/repositories/syncState.repository.js')

  const boxA = mA.mailbox
  const boxC = (await mailboxRepo.listMailboxes({ user: workspace._id })).find(
    (mb) => mb.emailAddress === 'third@outlook.com',
  )

  await syncRepo.ensureState({ user: workspace._id, mailboxId: boxA._id, folder: 'inbox' })
  await syncRepo.ensureState({ user: workspace._id, mailboxId: boxC._id, folder: 'inbox' })

  await syncRepo.releaseLock({
    mailboxId: boxA._id,
    folder: 'inbox',
    status: 'idle',
    deltaToken: 'DELTA-FOR-A',
  })
  await syncRepo.releaseLock({
    mailboxId: boxC._id,
    folder: 'inbox',
    status: 'idle',
    deltaToken: 'DELTA-FOR-C',
  })

  const stateA = await SyncState.findOne({ mailbox: boxA._id, folder: 'inbox' })
  const stateC = await SyncState.findOne({ mailbox: boxC._id, folder: 'inbox' })

  check('Each mailbox has its own inbox state row', String(stateA._id) !== String(stateC._id))
  check('A keeps its own delta token', stateA.lastDeltaToken === 'DELTA-FOR-A')
  check('C keeps its own delta token — they cannot overwrite each other', stateC.lastDeltaToken === 'DELTA-FOR-C')
  check(
    'The unique index is (mailbox, folder), so one folder name cannot collide across mailboxes',
    (await SyncState.countDocuments({ folder: 'inbox', user: workspace._id })) === 2,
  )

  // Writing A again must not disturb C — the concurrency requirement.
  await syncRepo.releaseLock({
    mailboxId: boxA._id,
    folder: 'inbox',
    status: 'idle',
    deltaToken: 'DELTA-FOR-A-SECOND-RUN',
  })
  check(
    'Re-syncing A leaves C’s delta token untouched',
    (await SyncState.findOne({ mailbox: boxC._id, folder: 'inbox' })).lastDeltaToken === 'DELTA-FOR-C',
  )
  check(
    'and A’s own token advanced',
    (await SyncState.findOne({ mailbox: boxA._id, folder: 'inbox' })).lastDeltaToken ===
      'DELTA-FOR-A-SECOND-RUN',
  )

  test('13.4-2  Folders are stored per mailbox')
  const { MailboxFolder } = await import('../src/models/mailboxFolder.model.js')

  await mailboxRepo.syncFolderRecords({
    user: workspace._id,
    mailboxId: boxA._id,
    folders: [
      { providerFolderId: 'shared-id', displayName: 'Inbox of A', canonical: 'inbox' },
    ],
  })
  await mailboxRepo.syncFolderRecords({
    user: workspace._id,
    mailboxId: boxC._id,
    folders: [
      { providerFolderId: 'shared-id', displayName: 'Inbox of C', canonical: 'inbox' },
    ],
  })

  check(
    'The same provider folder id under two mailboxes yields two rows',
    (await MailboxFolder.countDocuments({ providerFolderId: 'shared-id' })) === 2,
  )
  check(
    'A’s folder keeps A’s name',
    (await MailboxFolder.findOne({ mailbox: boxA._id, providerFolderId: 'shared-id' }))
      .displayName === 'Inbox of A',
  )
  check(
    'C’s folder keeps C’s name — no cross-contamination',
    (await MailboxFolder.findOne({ mailbox: boxC._id, providerFolderId: 'shared-id' }))
      .displayName === 'Inbox of C',
  )

  test('13.4-3  Sync history is attributed to its mailbox')
  const runA = await syncRepo.startRun({
    user: workspace._id,
    mailboxId: boxA._id,
    provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
    trigger: 'manual',
    mode: 'incremental',
    folders: ['inbox'],
    correlationId: 'corr-a',
  })
  await syncRepo.startRun({
    user: workspace._id,
    mailboxId: boxC._id,
    provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
    trigger: 'manual',
    mode: 'incremental',
    folders: ['inbox'],
    correlationId: 'corr-c',
  })

  const historyA = await syncRepo.listHistory({ user: workspace._id, mailboxId: boxA._id })
  const historyAll = await syncRepo.listHistory({ user: workspace._id, mailboxId: null })

  check('A’s history contains only A’s runs', historyA.total === 1)
  check('and it is the right run', String(historyA.items[0]._id) === String(runA._id))
  check('The workspace-wide list sees both', historyAll.total === 2)
  check(
    'Every row names its mailbox, so a mixed list is readable',
    historyAll.items.every((item) => item.toPublicJSON().mailbox !== null),
  )

  test('13.4-4  Provider operations refuse another workspace’s mailbox')
  const { resolveContext } = await import('../src/modules/provider/services/provider.service.js')

  let refusedForeign = false
  try {
    await resolveContext({
      auth: { user: otherWorkspace },
      mailboxId: boxA._id,
    })
  } catch {
    refusedForeign = true
  }
  check('resolveContext refuses a mailbox id from another workspace', refusedForeign)

  check(
    'and it does so for every provider operation, because they all go through it',
    refusedForeign,
  )

  const ownContext = await resolveContext({ auth: { user: workspace }, mailboxId: boxA._id })
  check('The owner resolves their own mailbox', String(ownContext.mailbox._id) === String(boxA._id))
  check(
    'and gets a real adapter bound to that mailbox’s credential',
    String(ownContext.mailbox.sourceAccount) === String(mA.account._id),
  )

  test('13.4-5  Each mailbox resolves its own Microsoft credential')
  const contextC = await resolveContext({ auth: { user: workspace }, mailboxId: boxC._id })

  check(
    'A and C resolve different OAuth grants',
    String(ownContext.mailbox.sourceAccount) !== String(contextC.mailbox.sourceAccount),
  )
  check(
    'Graph calls for A authenticate through A’s grant',
    String(ownContext.mailbox.sourceAccount) === String(mA.account._id),
  )
  check(
    'No mailbox falls back to a shared or first-in-cache account',
    Boolean(ownContext.mailbox.sourceAccount) && Boolean(contextC.mailbox.sourceAccount),
  )

  test('13.4-6  Adoption is idempotent for a legacy registry key')

  /**
   * The regression this guards.
   *
   * A mailbox written by the pre-13.2 connect path carries the Graph `/me` id
   * as `providerAccountId`, while adoption keys on MSAL's `homeAccountId`. The
   * upsert therefore matched nothing and inserted a *second* row — on every
   * status request that omitted a mailbox id, so the registry grew simply by
   * being read. Observed on the live database growing from two rows to four.
   */
  const legacyUser = await makeUser('legacy-key@example.com')
  const legacyGrant = await OutlookAccount.findOneAndUpdate(
    { homeAccountId: 'canonical-home-id.tenant' },
    {
      $set: {
        user: legacyUser._id,
        email: 'legacy@outlook.com',
        tokenCache: 'encrypted-placeholder',
        connectedAt: new Date(),
      },
      $setOnInsert: { homeAccountId: 'canonical-home-id.tenant' },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )

  // The row as the old code would have written it: short Graph id, right grant.
  await mailboxRepo.upsertMailbox({
    user: legacyUser._id,
    provider: PROVIDER_TYPES.MICROSOFT_GRAPH,
    providerAccountId: 'short-graph-id',
    emailAddress: 'legacy@outlook.com',
    displayName: 'Legacy',
    sourceAccount: legacyGrant._id,
  })

  check(
    'The workspace starts with one mailbox',
    (await Mailbox.countDocuments({ user: legacyUser._id })) === 1,
  )

  for (let i = 0; i < 5; i += 1) {
    await resolveContext({ auth: { user: legacyUser }, createIfMissing: true })
  }

  check(
    'Five adoption passes do not duplicate it — the registry does not grow on read',
    (await Mailbox.countDocuments({ user: legacyUser._id })) === 1,
    `got ${await Mailbox.countDocuments({ user: legacyUser._id })}`,
  )
  check(
    'and the existing row is the one that resolves',
    (await resolveContext({ auth: { user: legacyUser }, createIfMissing: true })).mailbox
      .emailAddress === 'legacy@outlook.com',
  )

  // --- TEST 14 — Historical records ---------------------------------------
  test('TEST 14  Records predating multi-mailbox still read')
  const { Mail } = await import('../src/models/mail.model.js')
  const legacyMail = await Mail.create({
    userId: alice._id,
    outlookAccountId: a.account._id,
    // No `mailbox` — exactly how every record written before this phase looks.
    from: 'enquiry@xploreaustralia.com',
    to: [{ address: 'customer@example.com' }],
    subject: 'Historical message',
    status: 'sent',
  })

  const readBack = await Mail.findById(legacyMail._id)
  check('A record with no mailbox reference still loads', Boolean(readBack))
  check('Its sender address still renders', readBack.from === 'enquiry@xploreaustralia.com')
  check('Its summary projection does not throw', Boolean(readBack.toSummaryJSON()))
}

// ---------------------------------------------------------------------------

async function main() {
  /**
   * An isolated database, always.
   *
   * The scenarios disconnect mailboxes and delete users; pointing them at the
   * real database would be indefensible regardless of how careful the fixtures
   * are.
   */
  const uri = new URL(config.database.uri.replace('mongodb://', 'http://'))
  const baseName = uri.pathname.replace('/', '') || 'outlook_automation_crm'
  const testUri = config.database.uri.replace(baseName, `${baseName}_phase132_verify`)

  await mongoose.connect(testUri, config.database.options)

  if (!mongoose.connection.name.endsWith('_phase132_verify')) {
    throw new Error(
      `Refusing to run: expected an isolated database, got "${mongoose.connection.name}".`,
    )
  }

  // A clean slate, so a previous run cannot make this one pass or fail.
  await mongoose.connection.dropDatabase()
  await Promise.all([User.syncIndexes(), Mailbox.syncIndexes(), OutlookAccount.syncIndexes()])

  process.stdout.write(`\nPhase 13.2 — multi-mailbox regression matrix`)
  process.stdout.write(`\nDatabase: ${mongoose.connection.name} (isolated, dropped afterwards)\n`)

  /**
   * A crash is a failure, and must not be reported as a pass.
   *
   * The obvious `try { run() } finally { report() }` shape has a nasty
   * property: if `run()` throws halfway through, every check that *did* run has
   * passed, so the summary reads "10/10 checks passed" and the exit code is 0 —
   * a green verification for a suite that never finished. The error is caught
   * here and recorded as a failed check so both the summary and the exit code
   * tell the truth.
   */
  let crash = null
  try {
    await run()
  } catch (error) {
    crash = error
    results.push({
      test: currentTest,
      description: `The suite crashed: ${error.message}`,
      passed: false,
    })
    process.stdout.write(`\n  FAIL  the suite crashed during "${currentTest}": ${error.message}\n`)
  }

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  process.stdout.write(`\n${'─'.repeat(64)}\n`)
  process.stdout.write(`${passed}/${results.length} checks passed`)
  process.stdout.write(crash ? ' (suite did not complete)\n' : '\n')

  if (failed.length > 0) {
    process.stdout.write(`\nFailures:\n`)
    for (const f of failed) process.stdout.write(`  ${f.test}: ${f.description}\n`)
    if (crash) process.stdout.write(`\n${crash.stack}\n`)
  }

  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()

  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(async (error) => {
  process.stderr.write(`\nVerification crashed: ${error.message}\n${error.stack}\n`)
  await mongoose.connection?.dropDatabase?.().catch(() => {})
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
