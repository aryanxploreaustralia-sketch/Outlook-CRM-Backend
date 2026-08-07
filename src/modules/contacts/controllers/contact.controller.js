/**
 * Contacts controller.
 *
 * Thin by design, matching the rest of the API: validate HTTP input, delegate,
 * wrap the result in the standard envelope.
 */

import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { ApiError } from '../../../utils/ApiError.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { Contact } from '../../../models/contact.model.js'
import { TRANSFER_FORMAT, TRANSFER_MIME_TYPES } from '../constants/contactConstants.js'
import * as repository from '../repositories/contact.repository.js'
import * as groups from '../repositories/contactGroup.repository.js'
import { applyMerge, findDuplicateClusters, findDuplicates } from '../services/duplicate.service.js'
import { exportContacts, importContacts, parseImportFile } from '../services/transfer.service.js'
import { fromXlsx, listSheets } from '../utils/xlsx.js'
import { classifySheet } from '../../leads/services/worksheetClassifier.service.js'
import { SHEET_KIND } from '../../leads/constants/leadConstants.js'
import { runContactSync } from '../services/contactSync.service.js'
import { resolveContext } from '../../provider/services/provider.service.js'
import { providerRegistry } from '../../provider/services/providerRegistry.js'
import { MicrosoftGraphContactProvider } from '../providers/microsoft/MicrosoftGraphContactProvider.js'
import { MockContactProvider } from '../providers/mock/MockContactProvider.js'
import { PROVIDER_TYPES } from '../../provider/constants/providerTypes.js'
import {
  bulkSchema,
  contactIdSchema,
  createContactSchema,
  exportSchema,
  importSchema,
  listContactsSchema,
  mergeSchema,
  syncSchema,
  updateContactSchema,
} from '../validators/contact.validator.js'

/** The signed-in user's id, which scopes every query in this module. */
const ownerOf = (req) => req.auth.user._id

/**
 * Builds the contact adapter for the current mailbox.
 *
 * Mirrors Phase 5's registry decision — including its mock fallback — so the
 * contacts module behaves identically when Microsoft is unconfigured rather than
 * returning 503 from every endpoint.
 */
async function resolveContactProvider(req) {
  const { mailbox, isMock, fallbackReason } = await resolveContext({
    auth: req.auth,
    createIfMissing: true,
  })

  const useMock = isMock || !mailbox || mailbox.provider === PROVIDER_TYPES.MOCK

  return {
    mailbox,
    isMock: useMock,
    fallbackReason,
    provider: useMock ? new MockContactProvider() : new MicrosoftGraphContactProvider(),
  }
}

/**
 * GET /api/v1/contacts
 *
 * Paginated, searchable and filterable. Returns the facet lists alongside the
 * page so the filter dropdowns can populate without a second request.
 */
export const list = asyncHandler(async (req, res) => {
  const query = listContactsSchema.parse(req.query)
  const owner = ownerOf(req)

  const [{ items, total }, facets] = await Promise.all([
    repository.list({ owner, ...query }),
    repository.facets({ owner }),
  ])

  return sendSuccess(res, {
    message: 'Contacts retrieved successfully.',
    data: { items, facets },
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
      hasNextPage: query.page * query.limit < total,
      hasPreviousPage: query.page > 1,
    },
  })
})

/** GET /api/v1/contacts/statistics — dashboard widgets. */
export const statistics = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Contact statistics retrieved successfully.',
    data: await repository.statistics({ owner: ownerOf(req) }),
  }),
)

/** GET /api/v1/contacts/duplicates — clusters for the review screen. */
export const duplicates = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Duplicate clusters retrieved successfully.',
    data: { clusters: await findDuplicateClusters({ owner: ownerOf(req) }) },
  }),
)

/**
 * GET /api/v1/contacts/:id
 *
 * Includes the photo and the groups this contact belongs to.
 */
export const getById = asyncHandler(async (req, res) => {
  const { id } = contactIdSchema.parse(req.params)
  const owner = ownerOf(req)

  const contact = await repository.findById({ owner, id, withPhoto: true })

  // 404 rather than 403 for another user's contact: distinguishing them would
  // confirm the id exists.
  if (!contact) throw ApiError.notFound('No contact with that id exists in your address book.')

  const memberships = await groups.groupsForContact({ owner, contactId: contact._id })

  return sendSuccess(res, {
    message: 'Contact retrieved successfully.',
    data: {
      contact: {
        ...contact.toPublicJSON(),
        photo: contact.photo?.contentBytes
          ? { contentType: contact.photo.contentType, contentBytes: contact.photo.contentBytes }
          : null,
      },
      groups: memberships,
    },
  })
})

/**
 * POST /api/v1/contacts
 *
 * Reports potential duplicates in the response rather than refusing to create.
 * The user may legitimately have two people with one shared switchboard number,
 * and blocking that would be wrong; surfacing it lets them decide.
 */
export const create = asyncHandler(async (req, res) => {
  const data = createContactSchema.parse(req.body)
  const owner = ownerOf(req)

  const potentialDuplicates = await findDuplicates({ candidate: data, owner })

  const contact = await repository.create({ owner, data, createdBy: owner })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: 'Contact created successfully.',
    data: {
      contact: contact.toPublicJSON(),
      possibleDuplicates: potentialDuplicates.map((match) => ({
        id: match.contact._id.toString(),
        displayName: match.contact.displayName,
        strategy: match.strategy,
        confidence: match.confidence,
        matchedOn: match.matchedOn,
      })),
    },
  })
})

/** PUT /api/v1/contacts/:id */
export const update = asyncHandler(async (req, res) => {
  const { id } = contactIdSchema.parse(req.params)
  const data = updateContactSchema.parse(req.body)

  const contact = await repository.update({ owner: ownerOf(req), id, data, updatedBy: ownerOf(req) })

  if (!contact) throw ApiError.notFound('No contact with that id exists in your address book.')

  return sendSuccess(res, {
    message: 'Contact updated successfully.',
    data: { contact: contact.toPublicJSON() },
  })
})

/**
 * DELETE /api/v1/contacts/:id
 *
 * Soft delete. A contact carries tags, notes and group membership that exist
 * nowhere else, so removal must be recoverable.
 */
export const remove = asyncHandler(async (req, res) => {
  const { id } = contactIdSchema.parse(req.params)

  const contact = await repository.softDelete({ owner: ownerOf(req), id, updatedBy: ownerOf(req) })

  if (!contact) throw ApiError.notFound('No contact with that id exists in your address book.')

  return sendSuccess(res, {
    message: 'Contact deleted. It can be restored from the deleted view.',
    data: { id, deleted: true },
  })
})

/** POST /api/v1/contacts/:id/restore */
export const restore = asyncHandler(async (req, res) => {
  const { id } = contactIdSchema.parse(req.params)

  const contact = await repository.restore({ owner: ownerOf(req), id, updatedBy: ownerOf(req) })

  if (!contact) throw ApiError.notFound('No deleted contact with that id exists.')

  return sendSuccess(res, {
    message: 'Contact restored successfully.',
    data: { contact: contact.toPublicJSON() },
  })
})

/** POST /api/v1/contacts/bulk */
export const bulk = asyncHandler(async (req, res) => {
  const { ids, action, value } = bulkSchema.parse(req.body)

  const result = await repository.bulk({
    owner: ownerOf(req),
    ids,
    action,
    value,
    updatedBy: ownerOf(req),
  })

  return sendSuccess(res, {
    message: `${result.modified} contact(s) updated.`,
    data: { action, ...result },
  })
})

/** POST /api/v1/contacts/:id/merge */
export const merge = asyncHandler(async (req, res) => {
  const { id } = contactIdSchema.parse(req.params)
  const { absorbId, strategy } = mergeSchema.parse(req.body)

  if (id === absorbId) throw ApiError.badRequest('A contact cannot be merged into itself.')

  const result = await applyMerge({
    keepId: id,
    absorbId,
    owner: ownerOf(req),
    strategy,
    updatedBy: ownerOf(req),
  })

  return sendSuccess(res, {
    message: 'Contacts merged successfully.',
    data: {
      contact: result.contact.toPublicJSON(),
      conflicts: result.conflicts,
      absorbedId: result.absorbedId,
    },
  })
})

/** POST /api/v1/contacts/sync */
export const sync = asyncHandler(async (req, res) => {
  const { mode } = syncSchema.parse(req.body ?? {})

  const { provider, mailbox, isMock, fallbackReason } = await resolveContactProvider(req)

  if (!mailbox) {
    throw ApiError.badRequest(
      'No mailbox is connected. Call POST /api/v1/provider/connect first.',
    )
  }

  const run = await runContactSync({
    provider,
    mailbox,
    user: req.auth.user,
    mode,
    isMock,
  })

  return sendSuccess(res, {
    message: isMock
      ? 'Contact synchronisation complete (simulated data).'
      : 'Contact synchronisation complete.',
    data: { mockMode: isMock, fallbackReason, run: run.toPublicJSON() },
  })
})

/**
 * Reports whether an uploaded workbook is really a lead register.
 *
 * Reuses the lead module's classifier rather than re-deriving the rules, so the
 * two modules can never disagree about what a lead sheet looks like. Returns
 * null for anything that is not one, including a file this cannot read — a
 * detector that throws would block ordinary imports.
 */
function detectLeadRegister(buffer) {
  try {
    const sheets = listSheets(buffer)
    if (sheets.length === 0) return null

    for (const sheet of sheets) {
      const parsed = fromXlsx(buffer, { sheet: sheet.name })
      const classified = classifySheet({
        name: sheet.name,
        headers: parsed.headers,
        rows: parsed.grid.slice(parsed.headerRowNumber),
      })

      if (classified.kind !== SHEET_KIND.LEADS) continue

      // Only worth diverting when the register carries enquiry data the
      // contacts importer would drop. A sheet of names and emails alone loses
      // nothing here.
      const enquiryFields = classified.mapping.filter((entry) =>
        ['reference', 'quoteDate', 'travelDate', 'pax', 'stage'].includes(entry.field),
      )

      if (enquiryFields.length < 2) continue

      const contactColumns = classified.mapping.filter((entry) =>
        ['contactPerson', 'email', 'phone', 'city', 'companyName'].includes(entry.field),
      ).length

      return { sheet: sheet.name, reason: classified.reason, columns: contactColumns }
    }

    return null
  } catch {
    return null
  }
}

/**
 * POST /api/v1/contacts/import
 *
 * Returns a per-row summary so a partial success is legible rather than opaque.
 */
export const importFile = asyncHandler(async (req, res) => {
  const { format, mode, content, encoding, defaultTags, contactsOnly } = importSchema.parse(req.body)

  const buffer = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')

  /**
   * A sales workbook uploaded here would lose its enquiries.
   *
   * The contacts importer keeps one record per *person*. A lead register keeps
   * one row per *enquiry* — the company sales workbook has 1,698 rows for 713
   * people. Importing it here would create the people and silently discard
   * every reference, quotation date, travel date, party size and pipeline
   * stage: 1,671 enquiries gone, with a cheerful success message.
   *
   * So the file is classified first, using the same classifier the lead
   * importer uses, and the caller is pointed at the endpoint that preserves the
   * data. `contactsOnly: true` overrides this for anyone who genuinely wants
   * only the people.
   */
  if (!contactsOnly && format === TRANSFER_FORMAT.XLSX) {
    const detected = detectLeadRegister(buffer)

    if (detected) {
      throw ApiError.badRequest(
        `"${detected.sheet}" looks like a lead register, not a contact list: ${detected.reason} ` +
          `Importing it here would keep the ${detected.columns} contact column(s) and discard the ` +
          'reference, quotation date, travel date, party size and status on every row. ' +
          'Upload it at POST /api/v1/leads/workbook/import (the Leads → Import workbook screen) ' +
          'to keep the enquiries. Send "contactsOnly": true to import the people only.',
      )
    }
  }

  let rows
  try {
    rows = parseImportFile({ content: buffer, format })
  } catch (error) {
    throw ApiError.badRequest(`The ${format.toUpperCase()} file could not be read: ${error.message}`)
  }

  if (rows.length === 0) {
    throw ApiError.badRequest('The file contained no usable rows.')
  }

  const summary = await importContacts({
    rows,
    owner: ownerOf(req),
    createdBy: ownerOf(req),
    mode,
    defaultTags,
  })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: `${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.failed} failed.`,
    data: summary,
  })
})

/**
 * POST /api/v1/contacts/export
 *
 * Streams a file rather than the JSON envelope — the response *is* the download,
 * and wrapping it would force the client to decode before saving.
 */
export const exportFile = asyncHandler(async (req, res) => {
  const { format, ids, filter, search, group } = exportSchema.parse(req.body ?? {})
  const owner = ownerOf(req)

  let contacts

  if (ids?.length > 0) {
    contacts = await Contact.find({ _id: { $in: ids }, owner, isDeleted: false })
  } else {
    // Exports are capped rather than unbounded: a runaway request would build
    // the entire address book in memory.
    const { items } = await repository.list({ owner, filter, search, group, page: 1, limit: 5000 })
    contacts = await Contact.find({ _id: { $in: items.map((item) => item.id) } })
  }

  const { buffer, filename, contentType } = exportContacts({ contacts, format })

  res.setHeader('Content-Type', contentType ?? TRANSFER_MIME_TYPES[format])
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Length', buffer.length)
  // Exposed so a browser fetch can read the filename, which CORS hides by default.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')

  return res.status(HTTP_STATUS.OK).send(buffer)
})

/** GET /api/v1/contacts/providers — which adapters are available. */
export const providers = asyncHandler(async (req, res) => {
  const { isMock, fallbackReason, provider } = await resolveContactProvider(req)

  return sendSuccess(res, {
    message: 'Contact providers retrieved successfully.',
    data: {
      active: provider.type,
      label: provider.label,
      capabilities: [...provider.capabilities],
      mockMode: isMock,
      fallbackReason,
      available: providerRegistry.available,
    },
  })
})

export default {
  list,
  statistics,
  duplicates,
  getById,
  create,
  update,
  remove,
  restore,
  bulk,
  merge,
  sync,
  importFile,
  exportFile,
  providers,
}
