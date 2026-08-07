/**
 * Employee profile and document management.
 *
 * ## Two audiences, one service, one rule
 *
 * An employee reads and writes their own profile. An owner or admin reads
 * anybody's and decides on documents. Rather than two services that drift,
 * every function takes an explicit `targetId` and the *route* decides who may
 * ask — so the ownership check happens once, at the boundary, and nothing here
 * has to remember whose data it is holding.
 *
 * ## What an employee may never write
 *
 * `email`, `role`, `status` and `joiningDate` are read-only to the person
 * themselves. They are not merely hidden in the form — the update schema does
 * not contain them, so a hand-crafted PATCH cannot set them either. An employee
 * who could edit their own `role` would make the entire permission engine
 * decorative.
 */

import {
  DOCUMENT_MIME_TYPES,
  DOCUMENT_STATUS,
  GENDER_LABELS,
  MAX_DOCUMENTS_PER_USER,
  MAX_DOCUMENT_BYTES,
  MAX_PHOTO_BYTES,
  PHOTO_MIME_TYPES,
  profileCompletion,
} from '../../../constants/employeeProfile.js'
import { ROLE_LABELS } from '../../../constants/roles.js'
import { deriveUserStatus, USER_STATUS_LABELS } from '../../../constants/userStatus.js'
import { User } from '../../../models/user.model.js'
import { UserDocument } from '../../../models/userDocument.model.js'
import { ApiError } from '../../../utils/ApiError.js'
import { createContextLogger } from '../../../utils/logger.js'
import {
  removeFile,
  sniffMimeType,
  storeFile,
} from './documentStorage.service.js'

const log = createContextLogger('profile')

/**
 * The profile, shaped for the client.
 *
 * `completion` is derived on every read — see the note in
 * `constants/employeeProfile.js` on why it is never stored.
 */
export function profileDTO(user) {
  const status = deriveUserStatus(user)

  return {
    id: String(user._id),

    // --- Basic, mostly read-only ---
    displayName: user.displayName ?? null,
    email: user.email,
    profilePhoto: user.profilePhoto ? `/api/v1/profile/photo/${user._id}` : null,
    phone: user.phone ?? null,
    employeeId: user.employeeId ?? null,
    department: user.department ?? null,
    designation: user.designation ?? user.jobTitle ?? null,

    /**
     * Falls back to `createdAt`, which is the closest thing to the truth for an
     * account nobody has filled in — and is honest, because it is genuinely
     * when the CRM first knew about them.
     */
    joiningDate: user.joiningDate ?? user.createdAt ?? null,
    joiningDateIsInferred: !user.joiningDate,

    role: user.role,
    roleLabel: ROLE_LABELS[user.role] ?? user.role,
    status,
    statusLabel: USER_STATUS_LABELS[status] ?? status,

    // --- Personal ---
    dateOfBirth: user.dateOfBirth ?? null,
    gender: user.gender ?? null,
    genderLabel: user.gender ? (GENDER_LABELS[user.gender] ?? user.gender) : null,

    address: {
      line1: user.address?.line1 ?? null,
      line2: user.address?.line2 ?? null,
      city: user.address?.city ?? null,
      state: user.address?.state ?? null,
      country: user.address?.country ?? null,
      postalCode: user.address?.postalCode ?? null,
    },

    emergencyContact: {
      name: user.emergencyContact?.name ?? null,
      phone: user.emergencyContact?.phone ?? null,
      relationship: user.emergencyContact?.relationship ?? null,
    },

    completion: profileCompletion(user),
  }
}

/** Reads one profile. Used by both the self and the admin route. */
export async function getProfile(targetId) {
  const user = await User.findById(targetId).lean()

  if (!user || user.isDeleted) throw ApiError.notFound('That profile could not be found.')

  return profileDTO(user)
}

/**
 * Applies a validated patch.
 *
 * The schema has already stripped anything an employee may not set, so this
 * writes what it is given. Nested paths are flattened to dotted keys so a
 * partial address update does not blow away the fields it omitted — `$set` on
 * `address` with two keys would drop the other four.
 */
export async function updateProfile({ targetId, patch, actor }) {
  const update = {}

  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      for (const [nested, nestedValue] of Object.entries(value)) {
        update[`${key}.${nested}`] = nestedValue
      }
    } else {
      update[key] = value
    }
  }

  if (Object.keys(update).length === 0) return getProfile(targetId)

  let updated
  try {
    updated = await User.findOneAndUpdate(
      { _id: targetId, isDeleted: { $ne: true } },
      { $set: update },
      { returnDocument: 'after', runValidators: true },
    )
  } catch (error) {
    // The partial unique index on `employeeId` caught a collision this
    // function's own check could not see.
    if (error?.code === 11_000) {
      throw ApiError.conflict('That employee ID is already assigned to somebody else.', {
        details: { reason: 'employee_id_taken' },
      })
    }
    throw error
  }

  if (!updated) throw ApiError.notFound('That profile could not be found.')

  log.info('Profile updated', {
    userId: String(targetId),
    actor: String(actor._id),
    fields: Object.keys(update),
  })

  return profileDTO(updated.toObject())
}

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------

/**
 * Replaces the profile photo.
 *
 * The previous file is unlinked *after* the new row is written, never before:
 * if the write fails, the person still has the photo they had.
 */
export async function setProfilePhoto({ targetId, buffer, actor }) {
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw ApiError.badRequest(
      `That image is ${Math.round(buffer.length / 1024 / 1024)} MB. The limit is 5 MB.`,
    )
  }

  const mimeType = sniffMimeType(buffer)
  const extension = PHOTO_MIME_TYPES[mimeType]

  if (!extension) {
    throw ApiError.badRequest('A profile photo must be a PNG or JPEG image.')
  }

  const user = await User.findById(targetId)
  if (!user || user.isDeleted) throw ApiError.notFound('That profile could not be found.')

  const previous = user.profilePhoto
  const stored = await storeFile({ userId: targetId, buffer, extension })

  user.profilePhoto = stored.storageKey
  await user.save()

  if (previous) await removeFile(previous)

  log.info('Profile photo updated', { userId: String(targetId), actor: String(actor._id) })

  return profileDTO(user.toObject())
}

/** Removes the photo. */
export async function removeProfilePhoto({ targetId }) {
  const user = await User.findById(targetId)
  if (!user || user.isDeleted) throw ApiError.notFound('That profile could not be found.')

  const previous = user.profilePhoto
  user.profilePhoto = null
  await user.save()

  if (previous) await removeFile(previous)

  return profileDTO(user.toObject())
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** One person's documents, newest first. Deleted rows never appear. */
export async function listDocuments(targetId) {
  const documents = await UserDocument.find({ user: targetId, isDeleted: { $ne: true } }).sort({
    uploadedAt: -1,
  })

  return {
    items: documents.map((document) => document.toPublicJSON()),
    limit: MAX_DOCUMENTS_PER_USER,
    remaining: Math.max(0, MAX_DOCUMENTS_PER_USER - documents.length),
  }
}

/**
 * Uploads a document.
 *
 * The five-file cap counts only live rows, so deleting one frees a slot — a cap
 * that counted deleted rows would let somebody lock themselves out permanently
 * by uploading and removing five files.
 */
export async function uploadDocument({ targetId, buffer, originalFileName, meta, actor }) {
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw ApiError.badRequest(
      `That file is ${Math.round(buffer.length / 1024 / 1024)} MB. The limit is 10 MB.`,
    )
  }

  const mimeType = sniffMimeType(buffer)
  const extension = DOCUMENT_MIME_TYPES[mimeType]

  if (!extension) {
    throw ApiError.badRequest('Documents must be a PDF, PNG or JPEG file.')
  }

  const live = await UserDocument.countDocuments({ user: targetId, isDeleted: { $ne: true } })

  if (live >= MAX_DOCUMENTS_PER_USER) {
    throw ApiError.conflict(
      `That is the maximum of ${MAX_DOCUMENTS_PER_USER} documents. Delete one to upload another.`,
      { details: { reason: 'document_limit' } },
    )
  }

  const stored = await storeFile({ userId: targetId, buffer, extension })

  const document = await UserDocument.create({
    user: targetId,
    title: meta.title,
    category: meta.category,
    description: meta.description ?? null,
    storageKey: stored.storageKey,
    originalFileName,
    mimeType,
    size: stored.size,
    checksum: stored.checksum,
    status: DOCUMENT_STATUS.PENDING,
    uploadedBy: actor._id,
    uploadedAt: new Date(),
  })

  log.info('Document uploaded', {
    userId: String(targetId),
    documentId: String(document._id),
    category: meta.category,
    size: stored.size,
  })

  return document.toPublicJSON()
}

/** Loads a document within one person's scope. */
async function loadDocument({ targetId, documentId }) {
  const document = await UserDocument.findOne({
    _id: documentId,
    user: targetId,
    isDeleted: { $ne: true },
  })

  if (!document) throw ApiError.notFound('That document could not be found.')

  return document
}

/**
 * Updates a document's own metadata, or replaces its bytes.
 *
 * A verified document is frozen. Allowing a replace would let approved identity
 * evidence be swapped for something else after the fact, which defeats the
 * point of having verified it.
 */
export async function updateDocument({ targetId, documentId, patch, buffer, originalFileName, actor }) {
  const document = await loadDocument({ targetId, documentId })

  if (document.status === DOCUMENT_STATUS.VERIFIED) {
    throw ApiError.conflict('A verified document cannot be changed. Ask an administrator first.', {
      details: { reason: 'document_verified' },
    })
  }

  if (patch.title !== undefined) document.title = patch.title
  if (patch.category !== undefined) document.category = patch.category
  if (patch.description !== undefined) document.description = patch.description

  if (buffer) {
    if (buffer.length > MAX_DOCUMENT_BYTES) {
      throw ApiError.badRequest('That file is larger than the 10 MB limit.')
    }

    const mimeType = sniffMimeType(buffer)
    const extension = DOCUMENT_MIME_TYPES[mimeType]

    if (!extension) throw ApiError.badRequest('Documents must be a PDF, PNG or JPEG file.')

    const previous = document.storageKey
    const stored = await storeFile({ userId: targetId, buffer, extension })

    document.storageKey = stored.storageKey
    document.size = stored.size
    document.checksum = stored.checksum
    document.mimeType = mimeType
    document.originalFileName = originalFileName ?? document.originalFileName

    /**
     * Replacing the file returns it to pending, and clears the previous
     * decision. A rejected document that was re-uploaded and silently kept its
     * rejection would never be looked at again.
     */
    document.status = DOCUMENT_STATUS.PENDING
    document.verifiedBy = null
    document.verifiedByEmail = null
    document.verifiedAt = null
    document.remarks = null

    await document.save()
    await removeFile(previous)

    log.info('Document replaced', { documentId: String(document._id), actor: String(actor._id) })

    return document.toPublicJSON()
  }

  await document.save()
  return document.toPublicJSON()
}

/**
 * Deletes a document.
 *
 * Only while pending — an employee cannot remove evidence somebody has already
 * ruled on, in either direction. The row is soft-deleted so the verification
 * history survives; the bytes are unlinked, because retaining a passport scan
 * nobody can see through the interface is a liability, not a record.
 */
export async function deleteDocument({ targetId, documentId, actor }) {
  const document = await loadDocument({ targetId, documentId })

  if (document.status !== DOCUMENT_STATUS.PENDING) {
    throw ApiError.conflict(
      'Only a pending document can be deleted. This one has already been reviewed.',
      { details: { reason: 'document_reviewed', status: document.status } },
    )
  }

  const key = document.storageKey

  document.isDeleted = true
  document.deletedAt = new Date()
  await document.save()

  await removeFile(key)

  log.info('Document deleted', { documentId: String(document._id), actor: String(actor._id) })

  return { deleted: true, id: String(document._id) }
}

/**
 * Records a verification decision.
 *
 * The one function here an employee can never reach — the route requires the
 * review permission. A rejection must carry remarks: a refusal with no reason
 * gives the employee nothing to act on.
 */
export async function decideDocument({ targetId, documentId, status, remarks, actor }) {
  const document = await loadDocument({ targetId, documentId })

  if (status === DOCUMENT_STATUS.REJECTED && !remarks?.trim()) {
    throw ApiError.badRequest('A rejection needs a reason the employee can act on.')
  }

  if (String(actor._id) === String(targetId)) {
    /**
     * Nobody verifies their own document.
     *
     * An owner is the most likely person to hit this — they hold the permission
     * and they also have a profile. Self-verification would make the whole
     * review step a formality for exactly the account that matters most.
     */
    throw ApiError.forbidden('You cannot verify your own documents. Ask another administrator.', {
      details: { reason: 'self_verification' },
    })
  }

  document.status = status
  document.remarks = remarks?.trim() || null
  document.verifiedBy = actor._id
  document.verifiedByEmail = actor.email ?? null
  document.verifiedAt = new Date()

  await document.save()

  log.info('Document decision recorded', {
    documentId: String(document._id),
    status,
    actor: String(actor._id),
  })

  return document.toPublicJSON()
}

/** The bytes, for download and preview. Scoped by the caller. */
export async function readDocumentFile({ targetId, documentId }) {
  const document = await loadDocument({ targetId, documentId })

  return {
    storageKey: document.storageKey,
    mimeType: document.mimeType,
    originalFileName: document.originalFileName,
    size: document.size,
  }
}

export default {
  decideDocument,
  deleteDocument,
  getProfile,
  listDocuments,
  profileDTO,
  readDocumentFile,
  removeProfilePhoto,
  setProfilePhoto,
  updateDocument,
  updateProfile,
  uploadDocument,
}
