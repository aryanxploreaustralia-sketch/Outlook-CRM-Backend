/**
 * Template personalisation.
 *
 * Renders `{{FirstName}}`-style placeholders against a contact.
 *
 * ## Two rules that matter more than the substitution itself
 *
 * **HTML escaping.** Contact data comes from spreadsheets that anyone can edit.
 * A company field containing `<script>` would otherwise be injected into every
 * message and executed in the recipient's mail client. Values are escaped when
 * substituted into an HTML body, and left raw for the plain-text alternative
 * and the subject line, where escaping would show the entities literally.
 *
 * **Fallbacks.** An unresolved variable must never render as an empty string.
 * "Dear ," is worse than not personalising at all, and a spreadsheet always has
 * rows with a missing first name. Every variable resolves to its fallback, and
 * the default fallback for a name is deliberately generic rather than blank.
 */

import { htmlToText } from '../../../services/mail.service.js'

/**
 * Placeholder syntax: `{{Name}}`, tolerant of internal whitespace.
 *
 * Deliberately not a general expression language. A template is written by a
 * salesperson, not a programmer, and a syntax that can fail at render time
 * — mid-campaign, per recipient — is a liability.
 */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g

/** Escapes the five characters that are structural in HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Built-in variables and where each is read from.
 *
 * `Destination` and `Agent` are campaign-level rather than contact-level: they
 * describe the offer being made, not the person receiving it, so they come from
 * the campaign's own values.
 */
export const BUILT_IN_VARIABLES = Object.freeze({
  FirstName: { source: 'contact', field: 'firstName', fallback: 'there' },
  LastName: { source: 'contact', field: 'lastName', fallback: '' },
  FullName: { source: 'contact', field: 'displayName', fallback: 'there' },
  Company: { source: 'contact', field: 'company', fallback: 'your company' },
  JobTitle: { source: 'contact', field: 'jobTitle', fallback: '' },
  Email: { source: 'contact', field: 'primaryEmail', fallback: '' },
  City: { source: 'contact', field: 'city', fallback: '' },
  State: { source: 'contact', field: 'state', fallback: '' },
  Country: { source: 'contact', field: 'country', fallback: '' },
  Source: { source: 'contact', field: 'leadSource', fallback: '' },
  Website: { source: 'contact', field: 'website', fallback: '' },
  Destination: { source: 'campaign', fallback: '' },
  Agent: { source: 'campaign', fallback: '' },
})

/**
 * Resolves every variable a template might use for one contact.
 *
 * Resolution order, strongest first:
 *   1. explicit per-recipient overrides
 *   2. the contact's own `customFields` — columns the import preserved
 *   3. the contact's mapped fields
 *   4. campaign-level values
 *   5. the declared fallback
 *
 * `customFields` sits above the mapped fields on purpose: if a sheet carried a
 * "Destination" column, that is more specific to this recipient than whatever
 * the campaign set globally.
 *
 * @param {object} params
 * @returns {Record<string, string>}
 */
export function resolveVariables({ contact, campaignValues = {}, overrides = {}, declared = [] }) {
  const values = {}

  const customFields =
    contact?.customFields instanceof Map
      ? Object.fromEntries(contact.customFields)
      : (contact?.customFields ?? {})

  // Built-ins first.
  for (const [name, spec] of Object.entries(BUILT_IN_VARIABLES)) {
    let value = null

    if (spec.source === 'contact') value = contact?.[spec.field] ?? null
    else value = campaignValues[name] ?? null

    // A custom column of the same name is more specific than the mapped field.
    if (customFields[name]) value = customFields[name]

    values[name] = String(value ?? '').trim() || spec.fallback
  }

  // Variables the template declared that are not built in.
  for (const variable of declared) {
    if (values[variable.name] && values[variable.name] !== '') continue

    const value =
      customFields[variable.name] ??
      campaignValues[variable.name] ??
      contact?.[variable.name] ??
      null

    values[variable.name] = String(value ?? '').trim() || (variable.fallback ?? '')
  }

  // Any custom column becomes usable as a variable, even if undeclared — a sheet
  // with a "Package" column should be usable as {{Package}} without ceremony.
  for (const [name, value] of Object.entries(customFields)) {
    if (values[name] === undefined) values[name] = String(value ?? '').trim()
  }

  // Explicit overrides win over everything.
  for (const [name, value] of Object.entries(overrides)) {
    values[name] = String(value ?? '')
  }

  return values
}

/**
 * Substitutes placeholders into a string.
 *
 * @param {string} text
 * @param {Record<string, string>} values
 * @param {object} [options]
 * @param {boolean} [options.escape]  Escape for HTML output.
 * @param {boolean} [options.blankUnresolved]
 *   Replace an unknown variable with an empty string instead of leaving the
 *   `{{Name}}` visible. Defaults to **false**, which is the campaign engine's
 *   long-standing behaviour and must stay that way: a marketing send that ships
 *   a literal `{{Destination}}` to five thousand people is a disaster the
 *   preview is meant to catch, so the placeholder is deliberately left showing.
 *   The template engine passes `true`, because a lead variable with no value is
 *   a normal, expected gap — a workbook row simply had no phone number — and
 *   printing `{{Phone}}` at the customer would be the worse outcome there.
 * @returns {{ output: string, unresolved: string[] }}
 */
export function render(text, values, { escape = false, blankUnresolved = false } = {}) {
  const unresolved = []

  const output = String(text ?? '').replace(PLACEHOLDER, (match, name) => {
    const value = values[name]

    if (value === undefined) {
      // Reported either way; only the substitution differs. The caller still
      // learns which variables went unmatched, so a preview can warn about a
      // typo even when the rendered output hides it.
      unresolved.push(name)
      return blankUnresolved ? '' : match
    }

    return escape ? escapeHtml(value) : value
  })

  return { output, unresolved }
}

/**
 * Renders a whole message for one contact.
 *
 * @param {object} params
 * @returns {{ subject: string, html: string, text: string, values: object, unresolved: string[] }}
 */
export function renderMessage({
  subject,
  bodyHtml,
  bodyText = null,
  contact,
  campaignValues = {},
  overrides = {},
  declared = [],
}) {
  const values = resolveVariables({ contact, campaignValues, overrides, declared })

  // The subject is plain text in the mail client's UI; escaping it would show
  // "&amp;" to the recipient.
  const renderedSubject = render(subject, values, { escape: false })
  const renderedHtml = render(bodyHtml, values, { escape: true })

  // The text alternative is derived from the *rendered* HTML when the template
  // has none, so it carries the same personalisation rather than placeholders.
  const sourceText = bodyText?.trim() ? render(bodyText, values, { escape: false }).output : htmlToText(renderedHtml.output)

  return {
    subject: renderedSubject.output,
    html: renderedHtml.output,
    text: sourceText,
    values,
    unresolved: [...new Set([...renderedSubject.unresolved, ...renderedHtml.unresolved])],
  }
}

/**
 * Lists the variables a template uses.
 *
 * Powers the builder's "this template needs these values" panel, so a user
 * discovers a missing campaign-level variable before launching rather than
 * after five thousand messages have gone out with a visible `{{Destination}}`.
 *
 * @param {...string} sources
 * @returns {string[]}
 */
export function extractVariables(...sources) {
  const found = new Set()

  for (const source of sources) {
    for (const match of String(source ?? '').matchAll(PLACEHOLDER)) {
      found.add(match[1])
    }
  }

  return [...found].sort()
}

/**
 * Reports which variables a template uses that nothing will resolve.
 *
 * @returns {{ ok: boolean, unresolvable: string[], campaignRequired: string[] }}
 */
export function checkTemplate({ subject, bodyHtml, declared = [], campaignValues = {} }) {
  const used = extractVariables(subject, bodyHtml)

  const declaredNames = new Set(declared.map((variable) => variable.name))
  const unresolvable = []
  const campaignRequired = []

  for (const name of used) {
    const builtIn = BUILT_IN_VARIABLES[name]

    if (builtIn) {
      // A campaign-sourced built-in with no value and no fallback renders blank.
      if (builtIn.source === 'campaign' && !campaignValues[name] && !builtIn.fallback) {
        campaignRequired.push(name)
      }
      continue
    }

    if (declaredNames.has(name) || campaignValues[name] !== undefined) continue

    // May still resolve from a contact's custom fields, so this is a warning
    // rather than an error — reported as such by the caller.
    unresolvable.push(name)
  }

  return { ok: campaignRequired.length === 0, unresolvable, campaignRequired, used }
}

export default { renderMessage, render, resolveVariables, extractVariables, checkTemplate }
