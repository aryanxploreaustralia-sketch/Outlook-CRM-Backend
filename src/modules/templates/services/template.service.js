/**
 * The email template engine.
 *
 * One template per workspace is ACTIVE, and that one is what the morning
 * workbook run sends. Everything else here exists to make that single fact
 * reliable: the lifecycle that decides which template it is, the renderer that
 * turns it into a message for one lead, and the validation that stops a broken
 * template becoming the active one.
 *
 * ## Where this sits
 *
 * It reuses the collection the campaign builder has always used rather than
 * starting a second library. Two template stores would let the morning run and
 * the campaign builder disagree about what the company's introduction says,
 * which is the exact problem this phase exists to remove. The campaign
 * endpoints are untouched and keep behaving as before.
 *
 * ## Rendering
 *
 * Substitution is Phase 7's `render`, unchanged. Only the *values* are
 * different: lead-shaped rather than contact-shaped, and blank rather than
 * fallback-filled. See `leadVariables.service.js` for why.
 */

import { htmlToText } from '../../../services/mail.service.js'
import { ApiError } from '../../../utils/ApiError.js'
import { CampaignTemplate } from '../../../models/campaignTemplate.model.js'
import { createContextLogger } from '../../../utils/logger.js'
import { extractVariables, render } from '../../campaigns/services/personalisation.service.js'
import { TEMPLATE_STATUS } from '../constants/templateConstants.js'
import { DEFAULT_INTRODUCTION } from './defaultTemplate.js'
import { resolveLeadVariables, unknownVariables } from './leadVariables.service.js'

const log = createContextLogger('templates')

/** Statuses a template can be in and still be edited. */
const EDITABLE = new Set([TEMPLATE_STATUS.DRAFT, TEMPLATE_STATUS.INACTIVE, TEMPLATE_STATUS.ACTIVE])

/**
 * Renders a template for one lead.
 *
 * The single rendering path. The morning run, the live preview and the test
 * send all call this, so a preview cannot promise something a send would not
 * produce — which is the only way a preview is worth having.
 *
 * @param {object} params
 * @param {{subject: string, bodyHtml: string, bodyText?: string}} params.template
 * @param {object} params.lead
 * @param {Date}   [params.now]
 * @returns {{subject: string, html: string, text: string, values: object, unresolved: string[]}}
 */
export function renderForLead({ template, lead, now = new Date() }) {
  const values = resolveLeadVariables({ lead, now })

  // The subject is plain text in the mail client's UI; escaping it would show
  // the recipient "&amp;" where the company name has an ampersand.
  const subject = render(template.subject, values, { blankUnresolved: true })

  // The body is escaped. Lead data originates in a spreadsheet anyone can edit,
  // and a company name containing a tag would otherwise be injected into every
  // message and rendered by the recipient's mail client.
  const html = render(template.bodyHtml, values, { escape: true, blankUnresolved: true })

  /**
   * The text alternative comes from the template when it has one, and from the
   * *rendered* HTML when it does not — so it carries the same personalisation
   * rather than the placeholders. Sending HTML with no text part measurably
   * raises a message's spam score, which for cold B2B outreach is the
   * difference between the inbox and the junk folder.
   */
  const text = template.bodyText?.trim()
    ? render(template.bodyText, values, { blankUnresolved: true }).output
    : htmlToText(html.output)

  return {
    subject: subject.output,
    html: html.output,
    text,
    values,
    unresolved: [...new Set([...subject.unresolved, ...html.unresolved])],
  }
}

/**
 * Checks a template before it is saved.
 *
 * Throws rather than returning a report, because every caller's response to a
 * bad template is the same: refuse it and say why.
 *
 * @param {{subject: string, bodyHtml: string}} params
 */
export function assertRenderable({ subject, bodyHtml }) {
  if (!subject?.trim()) throw ApiError.badRequest('A template needs a subject line.')
  if (!bodyHtml?.trim()) throw ApiError.badRequest('A template needs a message body.')

  const used = extractVariables(subject, bodyHtml)
  const unknown = unknownVariables(used)

  if (unknown.length > 0) {
    throw ApiError.badRequest(
      `${unknown.map((name) => `{{${name}}}`).join(', ')} ${unknown.length === 1 ? 'is not a variable' : 'are not variables'} this engine can fill. Use the variable picker to insert one.`,
    )
  }

  return { used }
}

/**
 * Translates a duplicate-key error into something a person can act on.
 *
 * Two unique indexes can fire here and they mean completely different things,
 * so the message has to distinguish them.
 */
function translateDuplicate(error, fallback) {
  if (error?.code !== 11000) return error

  if (String(error?.message ?? '').includes('one_active_template_per_owner')) {
    return ApiError.conflict(
      'Another template is already active. Activating a template deactivates the current one automatically — try again.',
    )
  }

  return ApiError.conflict(fallback)
}

/**
 * Makes one template the active one.
 *
 * Two writes, in this order: stand the incumbent down, then promote the
 * successor. The reverse order cannot work — the unique index would reject the
 * second active template — and doing it in this order means the worst case is a
 * workspace with no active template, which the morning run reports clearly,
 * rather than two and an unpredictable choice between them.
 *
 * @param {{ owner: any, id: string, actor?: any }} params
 */
export async function activateTemplate({ owner, id, actor = null }) {
  const template = await CampaignTemplate.findOne({ _id: id, owner, isDeleted: false })
  if (!template) throw ApiError.notFound('No template with that id exists.')

  if (template.status === TEMPLATE_STATUS.ARCHIVED) {
    throw ApiError.badRequest(
      'An archived template cannot be activated. Restore it to inactive first.',
    )
  }

  // Validated at the moment of activation, not only at save: a template saved
  // as a draft may have been left half-written, and this is the point where it
  // becomes the thing that emails customers unattended.
  assertRenderable({ subject: template.subject, bodyHtml: template.bodyHtml })

  const previous = await CampaignTemplate.find({
    owner,
    status: TEMPLATE_STATUS.ACTIVE,
    _id: { $ne: template._id },
  })

  if (previous.length > 0) {
    await CampaignTemplate.updateMany(
      { owner, status: TEMPLATE_STATUS.ACTIVE, _id: { $ne: template._id } },
      { $set: { status: TEMPLATE_STATUS.INACTIVE } },
    )
  }

  template.status = TEMPLATE_STATUS.ACTIVE
  template.activatedAt = new Date()
  template.activatedBy = actor

  try {
    await template.save()
  } catch (error) {
    throw translateDuplicate(error, 'A template with that name already exists.')
  }

  log.info('Template activated', {
    template: String(template._id),
    name: template.name,
    version: template.version,
    deactivated: previous.map((entry) => entry.name),
  })

  return { template, deactivated: previous.map((entry) => entry.toSummaryJSON()) }
}

/**
 * The template the automatic send should use.
 *
 * Three outcomes, and the difference between the last two matters:
 *
 *   - an active template exists  → use it;
 *   - the workspace has **no templates at all** → it has never been configured,
 *     so seed the built-in introduction and use that. A first upload that
 *     creates leads and emails nobody looks like a broken product rather than a
 *     missing setting;
 *   - templates exist but none is active → somebody deliberately deactivated
 *     them. Do not guess which one they meant. Refuse, and say so.
 *
 * @param {{ owner: any, createIfMissing?: boolean }} params
 * @returns {Promise<object>} A CampaignTemplate document.
 */
export async function resolveActiveTemplate({ owner, createIfMissing = true }) {
  const active = await CampaignTemplate.findOne({
    owner,
    status: TEMPLATE_STATUS.ACTIVE,
    isDeleted: false,
  })

  if (active) return active

  const total = await CampaignTemplate.countDocuments({ owner, isDeleted: false })

  if (total > 0) {
    throw ApiError.badRequest(
      'No email template is active, so nothing can be sent automatically. Open Email Templates and activate one.',
    )
  }

  if (!createIfMissing) {
    throw ApiError.badRequest(
      'No email template is active, so nothing can be sent automatically. Open Email Templates and activate one.',
    )
  }

  return seedDefaultTemplate({ owner })
}

/**
 * Writes the built-in introduction into a workspace that has none.
 *
 * Idempotent by way of the unique name index: two morning runs starting at the
 * same moment cannot produce two copies, and the loser of that race reads the
 * winner's row.
 *
 * @param {{ owner: any, actor?: any }} params
 */
export async function seedDefaultTemplate({ owner, actor = null }) {
  try {
    const template = await CampaignTemplate.create({
      ...DEFAULT_INTRODUCTION,
      owner,
      createdBy: actor,
      activatedAt: new Date(),
      activatedBy: actor,
      isSeeded: true,
    })

    log.info('Default introduction seeded', { owner: String(owner), template: String(template._id) })

    return template
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await CampaignTemplate.findOne({
        owner,
        name: DEFAULT_INTRODUCTION.name,
        isDeleted: false,
      }).collation({ locale: 'en', strength: 2 })

      if (existing) return existing
    }

    throw error
  }
}

/**
 * Creates a template.
 *
 * @param {{ owner: any, actor?: any, data: object }} params
 */
export async function createTemplate({ owner, actor = null, data }) {
  assertRenderable({ subject: data.subject, bodyHtml: data.bodyHtml })

  const wantsActive = data.status === TEMPLATE_STATUS.ACTIVE

  let template
  try {
    template = await CampaignTemplate.create({
      ...data,
      // Created inactive even when active was asked for, then promoted through
      // the one path that knows how to stand the incumbent down.
      status: wantsActive ? TEMPLATE_STATUS.INACTIVE : (data.status ?? TEMPLATE_STATUS.DRAFT),
      owner,
      createdBy: actor,
      updatedBy: actor,
    })
  } catch (error) {
    throw translateDuplicate(error, `A template named "${data.name}" already exists.`)
  }

  if (wantsActive) {
    const result = await activateTemplate({ owner, id: template._id, actor })
    return result.template
  }

  return template
}

/**
 * Updates a template.
 *
 * An archived template is read-only. Editing history is not a feature, it is a
 * way of making the archive worthless.
 *
 * @param {{ owner: any, id: string, actor?: any, data: object }} params
 */
export async function updateTemplate({ owner, id, actor = null, data }) {
  const template = await CampaignTemplate.findOne({ _id: id, owner, isDeleted: false })
  if (!template) throw ApiError.notFound('No template with that id exists.')

  if (!EDITABLE.has(template.status)) {
    throw ApiError.badRequest(
      'An archived template cannot be edited. Duplicate it if you want to work from it.',
    )
  }

  const subject = data.subject ?? template.subject
  const bodyHtml = data.bodyHtml ?? template.bodyHtml
  assertRenderable({ subject, bodyHtml })

  for (const field of ['name', 'description', 'category', 'subject', 'bodyHtml', 'bodyText']) {
    if (data[field] !== undefined) template[field] = data[field]
  }

  template.updatedBy = actor

  /**
   * Editing the active template is allowed, and takes effect on the next send.
   *
   * That is the point of the screen — the whole phase exists so the wording can
   * be changed without a deployment. Messages already sent are unaffected: mail
   * history stores the rendered content, not a reference to this document.
   */
  try {
    await template.save()
  } catch (error) {
    throw translateDuplicate(error, `A template named "${data.name}" already exists.`)
  }

  return template
}

/**
 * Copies a template into a new draft.
 *
 * Always a draft, never active: duplicating is how someone experiments with a
 * change to the message that is currently going to customers, and the copy
 * taking over automatically would be the opposite of what they meant.
 *
 * @param {{ owner: any, id: string, actor?: any }} params
 */
export async function duplicateTemplate({ owner, id, actor = null }) {
  const source = await CampaignTemplate.findOne({ _id: id, owner, isDeleted: false })
  if (!source) throw ApiError.notFound('No template with that id exists.')

  // "Name (copy)", "Name (copy 2)" — the first free one, so duplicating twice
  // does not fail on the unique index.
  let name = `${source.name} (copy)`
  for (let attempt = 2; attempt < 50; attempt += 1) {
    const clash = await CampaignTemplate.findOne({ owner, name, isDeleted: false }).collation({
      locale: 'en',
      strength: 2,
    })
    if (!clash) break
    name = `${source.name} (copy ${attempt})`
  }

  return CampaignTemplate.create({
    owner,
    createdBy: actor,
    updatedBy: actor,
    name,
    description: source.description,
    category: source.category,
    subject: source.subject,
    bodyHtml: source.bodyHtml,
    bodyText: source.bodyText,
    variables: source.variables,
    status: TEMPLATE_STATUS.DRAFT,
    version: 1,
  })
}

/**
 * Moves a template between the non-active statuses.
 *
 * @param {{ owner: any, id: string, status: string }} params
 */
export async function setStatus({ owner, id, status }) {
  const template = await CampaignTemplate.findOne({ _id: id, owner, isDeleted: false })
  if (!template) throw ApiError.notFound('No template with that id exists.')

  if (status === TEMPLATE_STATUS.ACTIVE) {
    throw ApiError.badRequest('Use the activate endpoint to make a template active.')
  }

  /**
   * Deactivating the active template is allowed but stops automatic sending.
   *
   * Not blocked — an operator who wants the morning run to stop emailing while
   * the wording is rewritten has a legitimate need, and the run reports the
   * situation clearly rather than failing silently. The response says so.
   */
  const wasActive = template.status === TEMPLATE_STATUS.ACTIVE

  template.status = status
  if (wasActive) template.activatedAt = null

  await template.save()

  return { template, stoppedAutomation: wasActive }
}

/**
 * Deletes a draft.
 *
 * Only a draft. Anything that has been active has, or may have, sent mail to
 * customers, and deleting it would leave mail history naming a template nobody
 * can look up. Those are archived instead.
 *
 * @param {{ owner: any, id: string }} params
 */
export async function deleteTemplate({ owner, id }) {
  const template = await CampaignTemplate.findOne({ _id: id, owner, isDeleted: false })
  if (!template) throw ApiError.notFound('No template with that id exists.')

  if (template.status !== TEMPLATE_STATUS.DRAFT) {
    throw ApiError.badRequest(
      `Only a draft can be deleted. "${template.name}" is ${template.status} — archive it instead, so mail history sent with it stays readable.`,
    )
  }

  template.isDeleted = true
  await template.save()

  return template
}

/**
 * Records that a template was used to send something.
 *
 * Fire-and-forget: the message has already gone out, and a failure to increment
 * a counter must never be reported as a failure to send.
 *
 * @param {{ id: any, count?: number }} params
 */
export async function recordUse({ id, count = 1 }) {
  if (!id) return

  try {
    await CampaignTemplate.updateOne(
      { _id: id },
      { $inc: { useCount: count }, $set: { lastUsedAt: new Date() } },
    )
  } catch (error) {
    log.warn('Template use counter not updated', { template: String(id), error: error?.message })
  }
}

export default {
  renderForLead,
  assertRenderable,
  activateTemplate,
  resolveActiveTemplate,
  seedDefaultTemplate,
  createTemplate,
  updateTemplate,
  duplicateTemplate,
  setStatus,
  deleteTemplate,
  recordUse,
}
