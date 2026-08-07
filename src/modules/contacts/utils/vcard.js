/**
 * vCard 3.0 reader and writer.
 *
 * 3.0 rather than 4.0 because it is what Outlook, Apple Contacts and Google
 * Contacts all import without complaint; 4.0 support is still patchy in exactly
 * the clients a CRM user is likely to have.
 *
 * The two details that break naive implementations are both handled here:
 * **line folding** (long lines are split and continued with a leading space,
 * which must be rejoined before parsing) and **value escaping** (semicolons and
 * commas are structural, so a company name containing one must be escaped or the
 * record silently loses fields).
 */

/** Escapes a value for a vCard property. */
function escapeValue(value) {
  if (value === null || value === undefined) return ''

  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/** Reverses `escapeValue`. */
function unescapeValue(value) {
  return String(value ?? '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

/**
 * Folds a line at 75 octets, as the specification requires.
 *
 * Some parsers reject longer lines outright, and a long notes field will exceed
 * it routinely.
 */
function foldLine(line) {
  if (line.length <= 75) return line

  const parts = [line.slice(0, 75)]
  let rest = line.slice(75)

  while (rest.length > 74) {
    parts.push(` ${rest.slice(0, 74)}`)
    rest = rest.slice(74)
  }

  if (rest.length > 0) parts.push(` ${rest}`)

  return parts.join('\r\n')
}

/** Formats a date as the `YYYY-MM-DD` vCard expects. */
function toVCardDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

/**
 * Serialises one contact to a vCard record.
 *
 * @param {object} contact
 * @returns {string}
 */
export function toVCard(contact) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0']

  const push = (line) => lines.push(foldLine(line))

  // N is structured: family;given;additional;prefix;suffix — order is fixed.
  push(`N:${escapeValue(contact.lastName)};${escapeValue(contact.firstName)};;;`)
  push(`FN:${escapeValue(contact.displayName ?? [contact.firstName, contact.lastName].filter(Boolean).join(' '))}`)

  if (contact.company || contact.jobTitle) {
    if (contact.company) push(`ORG:${escapeValue(contact.company)}`)
    if (contact.jobTitle) push(`TITLE:${escapeValue(contact.jobTitle)}`)
  }

  if (contact.primaryEmail) push(`EMAIL;TYPE=INTERNET,PREF:${escapeValue(contact.primaryEmail)}`)
  if (contact.secondaryEmail) push(`EMAIL;TYPE=INTERNET:${escapeValue(contact.secondaryEmail)}`)

  if (contact.mobile) push(`TEL;TYPE=CELL:${escapeValue(contact.mobile)}`)
  if (contact.businessPhone) push(`TEL;TYPE=WORK:${escapeValue(contact.businessPhone)}`)
  if (contact.phone) push(`TEL;TYPE=HOME:${escapeValue(contact.phone)}`)

  if (contact.website) push(`URL:${escapeValue(contact.website)}`)

  const hasAddress =
    contact.address || contact.city || contact.state || contact.country || contact.postalCode

  if (hasAddress) {
    // ADR is structured: pobox;ext;street;locality;region;postal;country
    push(
      `ADR;TYPE=WORK:;;${escapeValue(contact.address)};${escapeValue(contact.city)};` +
        `${escapeValue(contact.state)};${escapeValue(contact.postalCode)};${escapeValue(contact.country)}`,
    )
  }

  const birthday = toVCardDate(contact.birthday)
  if (birthday) push(`BDAY:${birthday}`)

  if (contact.notes) push(`NOTE:${escapeValue(contact.notes)}`)

  // Tags map onto CATEGORIES, which Outlook and Apple Contacts both round-trip.
  if (contact.tags?.length > 0) {
    push(`CATEGORIES:${contact.tags.map(escapeValue).join(',')}`)
  }

  if (contact.photo?.contentBytes && contact.photo?.contentType) {
    const subtype = contact.photo.contentType.split('/')[1]?.toUpperCase() ?? 'JPEG'
    push(`PHOTO;ENCODING=b;TYPE=${subtype}:${contact.photo.contentBytes}`)
  }

  lines.push('END:VCARD')

  return lines.join('\r\n')
}

/** Serialises many contacts into one file. */
export function toVCardFile(contacts) {
  return `${contacts.map(toVCard).join('\r\n')}\r\n`
}

/** Splits a structured value on unescaped semicolons. */
function splitStructured(value) {
  const parts = []
  let current = ''
  let escaped = false

  for (const char of String(value ?? '')) {
    if (escaped) {
      current += `\\${char}`
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === ';') {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }

  parts.push(current)
  return parts.map(unescapeValue)
}

/**
 * Parses a vCard file into contact-shaped objects.
 *
 * @param {string} text
 * @returns {object[]}
 */
export function fromVCardFile(text) {
  // Unfold first: a continuation line begins with a space or tab and belongs to
  // the line before it. Parsing without this truncates every long value.
  const unfolded = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')

  const contacts = []
  let current = null

  for (const rawLine of unfolded.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue

    if (/^BEGIN:VCARD$/i.test(line)) {
      current = { tags: [] }
      continue
    }

    if (/^END:VCARD$/i.test(line)) {
      if (current) {
        if (!current.displayName) {
          current.displayName =
            [current.firstName, current.lastName].filter(Boolean).join(' ') || current.primaryEmail
        }
        contacts.push(current)
      }
      current = null
      continue
    }

    if (!current) continue

    const separator = line.indexOf(':')
    if (separator === -1) continue

    const rawKey = line.slice(0, separator)
    const value = line.slice(separator + 1)

    // A property may carry parameters: `TEL;TYPE=CELL`. The name is the first part.
    const [name, ...params] = rawKey.split(';')
    const property = name.toUpperCase()
    const paramText = params.join(';').toUpperCase()

    switch (property) {
      case 'N': {
        const [family, given] = splitStructured(value)
        current.lastName = family || null
        current.firstName = given || null
        break
      }

      case 'FN':
        current.displayName = unescapeValue(value)
        break

      case 'ORG':
        // ORG is structured (company;department); only the company is kept.
        current.company = splitStructured(value)[0] || null
        break

      case 'TITLE':
        current.jobTitle = unescapeValue(value)
        break

      case 'EMAIL': {
        const address = unescapeValue(value).toLowerCase()
        // PREF marks the primary; otherwise first-seen wins.
        if (paramText.includes('PREF') || !current.primaryEmail) {
          if (current.primaryEmail && !current.secondaryEmail) {
            current.secondaryEmail = current.primaryEmail
          }
          current.primaryEmail = address
        } else if (!current.secondaryEmail) {
          current.secondaryEmail = address
        }
        break
      }

      case 'TEL': {
        const number = unescapeValue(value)
        if (paramText.includes('CELL') || paramText.includes('MOBILE')) current.mobile = number
        else if (paramText.includes('WORK')) current.businessPhone = number
        else if (paramText.includes('HOME')) current.phone = number
        else if (!current.businessPhone) current.businessPhone = number
        break
      }

      case 'URL':
        current.website = unescapeValue(value)
        break

      case 'ADR': {
        const [, , street, locality, region, postal, country] = splitStructured(value)
        current.address = street || null
        current.city = locality || null
        current.state = region || null
        current.postalCode = postal || null
        current.country = country || null
        break
      }

      case 'BDAY': {
        const date = new Date(unescapeValue(value))
        current.birthday = Number.isNaN(date.getTime()) ? null : date
        break
      }

      case 'NOTE':
        current.notes = unescapeValue(value)
        break

      case 'CATEGORIES':
        current.tags = unescapeValue(value)
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
        break

      default:
        // Unknown properties are ignored rather than failing the record — real
        // vCards carry plenty of client-specific extensions.
        break
    }
  }

  return contacts
}

export default { toVCard, toVCardFile, fromVCardFile }
