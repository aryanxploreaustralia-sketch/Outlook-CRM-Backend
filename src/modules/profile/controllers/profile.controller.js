/**
 * Employee profile controllers.
 *
 * ## One set of handlers, two audiences
 *
 * Each handler resolves a `targetId` and nothing else decides scope. For the
 * self routes that is always `req.auth.user._id`; for the admin routes it is
 * the path parameter, and the route has already required the permission. The
 * handler never chooses — which means there is no branch here that could pick
 * the wrong one.
 *
 * ## Uploads arrive as a raw body
 *
 * The same mechanism the workbook import already uses: `express.raw` with the
 * filename and the metadata in headers. No multipart parser is introduced,
 * because the CRM has never needed one and adding a dependency to accept a
 * single file would be the wrong trade.
 */

import { createReadStream } from 'node:fs'

import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { ApiError } from '../../../utils/ApiError.js'
import { DOCUMENT_STATUS } from '../../../constants/employeeProfile.js'
import { recordAudit } from '../../audit/services/auditRecorder.service.js'
import { respondWithPerformance } from '../../admin/controllers/admin.controller.js'
import * as service from '../services/profile.service.js'
import { resolveStoredPath } from '../services/documentStorage.service.js'
import { signatureSchema } from '../validators/profile.validator.js'
import { User } from '../../../models/user.model.js'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import {
  documentDecisionSchema,
  documentUpdateSchema,
  documentUploadSchema,
  objectIdSchema,
  profileUpdateSchema,
} from '../validators/profile.validator.js'

/** The signed-in user's own id. The only scope the self routes ever use. */
const self = (req) => String(req.auth.user._id)

/** The path parameter, for the admin routes. Validated as an id. */
const target = (req) => objectIdSchema.parse(req.params.id)

/**
 * Pulls the raw bytes off the request.
 *
 * Mirrors `fileFrom` in the workbook controller — same shape, same header, so
 * a client that can upload a workbook can upload a document.
 */
function fileFrom(req) {
  const buffer = Buffer.isBuffer(req.body) ? req.body : null

  if (!buffer || buffer.length === 0) throw ApiError.badRequest('No file was uploaded.')

  return {
    buffer,
    // Bounded and stripped of path separators: this is attacker-controlled text
    // and it must never be able to describe a location.
    filename: String(req.get('x-filename') ?? 'document')
      .replaceAll(/[/\\]/g, '_')
      .slice(0, 256),
  }
}

/** Document metadata rides in a header beside the raw body. */
function metaFrom(req, schema) {
  try {
    return schema.parse(JSON.parse(req.get('x-document-meta') ?? '{}'))
  } catch (error) {
    if (error?.name === 'ZodError') throw error
    throw ApiError.badRequest('The document metadata header is not valid JSON.')
  }
}

// ---------------------------------------------------------------------------
// Self
// ---------------------------------------------------------------------------

/** GET /api/v1/profile */
export const getMyProfile = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'Profile loaded.', data: await service.getProfile(self(req)) }),
)

/** PATCH /api/v1/profile */
export const patchMyProfile = asyncHandler(async (req, res) => {
  const patch = profileUpdateSchema.parse(req.body ?? {})

  return sendSuccess(res, {
    message: 'Profile updated.',
    data: await service.updateProfile({ targetId: self(req), patch, actor: req.auth.user }),
  })
})

/** PUT /api/v1/profile/photo */
export const putMyPhoto = asyncHandler(async (req, res) => {
  const { buffer } = fileFrom(req)

  return sendSuccess(res, {
    message: 'Profile photo updated.',
    data: await service.setProfilePhoto({ targetId: self(req), buffer, actor: req.auth.user }),
  })
})

/** DELETE /api/v1/profile/photo */
export const deleteMyPhoto = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Profile photo removed.',
    data: await service.removeProfilePhoto({ targetId: self(req) }),
  }),
)

/**
 * GET /api/v1/profile/photo/:id
 *
 * Served by id rather than by path, so the storage layout is never exposed.
 * Any signed-in user may fetch any photo: it is the avatar already shown beside
 * that person's name across the CRM, so treating it as a secret here while
 * rendering it everywhere else would be theatre.
 */
export const getPhoto = asyncHandler(async (req, res) => {
  const { User } = await import('../../../models/user.model.js')
  const user = await User.findById(objectIdSchema.parse(req.params.id)).select('profilePhoto').lean()

  if (!user?.profilePhoto) throw ApiError.notFound('That profile has no photo.')

  const absolute = resolveStoredPath(user.profilePhoto)

  /*
   * Existence is checked before a single header is written.
   *
   * `createReadStream(...).pipe(res)` used to run unconditionally. When the file
   * was gone — a redeploy that replaced the app directory, a row written by an
   * older build — the stream emitted `error` with nothing listening, *after*
   * `Content-Type` had already been sent. The client received a truncated
   * response rather than a status it could act on, which an `<img>` reports
   * only as a generic load failure. Checking first turns that into an honest
   * 404 that shows up plainly in the network log.
   */
  try {
    await access(absolute, fsConstants.R_OK)
  } catch {
    throw ApiError.notFound('That profile photo is no longer stored on this server.', {
      code: 'PHOTO_FILE_MISSING',
    })
  }

  res.setHeader('Content-Type', user.profilePhoto.endsWith('.png') ? 'image/png' : 'image/jpeg')
  // Private: an avatar is not secret, but it is not public either, and a shared
  // cache should not hold it.
  res.setHeader('Cache-Control', 'private, max-age=300')

  const stream = createReadStream(absolute)

  /*
   * A late read failure cannot become a response any more — headers are out —
   * so the socket is closed rather than left hanging for the browser's timeout.
   */
  stream.on('error', () => res.destroy())

  return stream.pipe(res)
})

/**
 * GET /api/v1/profile/performance
 *
 * The caller's own dashboard, through the same responder the admin route uses
 * — one code path, so the employee and their manager cannot be shown different
 * numbers for the same person.
 */
export const getMyPerformance = asyncHandler((req, res) =>
  respondWithPerformance(req, res, self(req)),
)

/** GET /api/v1/profile/documents */
export const getMyDocuments = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'Documents loaded.', data: await service.listDocuments(self(req)) }),
)

/** POST /api/v1/profile/documents */
export const postMyDocument = asyncHandler(async (req, res) => {
  const { buffer, filename } = fileFrom(req)
  const meta = metaFrom(req, documentUploadSchema)

  const document = await service.uploadDocument({
    targetId: self(req),
    buffer,
    originalFileName: filename,
    meta,
    actor: req.auth.user,
  })

  return sendSuccess(res, { message: `${document.title} uploaded.`, data: document })
})

/** PATCH /api/v1/profile/documents/:documentId */
export const patchMyDocument = asyncHandler(async (req, res) => {
  const documentId = objectIdSchema.parse(req.params.documentId)

  // A body means bytes; no body means metadata only, carried in the header.
  const hasBytes = Buffer.isBuffer(req.body) && req.body.length > 0
  const meta = metaFrom(req, documentUpdateSchema)

  return sendSuccess(res, {
    message: 'Document updated.',
    data: await service.updateDocument({
      targetId: self(req),
      documentId,
      patch: meta,
      buffer: hasBytes ? req.body : null,
      originalFileName: hasBytes ? fileFrom(req).filename : null,
      actor: req.auth.user,
    }),
  })
})

/** DELETE /api/v1/profile/documents/:documentId */
export const deleteMyDocument = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Document deleted.',
    data: await service.deleteDocument({
      targetId: self(req),
      documentId: objectIdSchema.parse(req.params.documentId),
      actor: req.auth.user,
    }),
  }),
)

/** GET /api/v1/profile/documents/:documentId/file — preview and download. */
export const getMyDocumentFile = asyncHandler(async (req, res) =>
  streamDocument(res, await service.readDocumentFile({
    targetId: self(req),
    documentId: objectIdSchema.parse(req.params.documentId),
  }), req.query.download === '1'),
)

/**
 * Streams a stored document.
 *
 * `inline` for preview, `attachment` for download — the client chooses with a
 * query flag rather than the server guessing from the MIME type.
 *
 * `X-Content-Type-Options: nosniff` matters here more than almost anywhere
 * else: these are user-uploaded bytes, and without it a browser may sniff a
 * crafted file into something executable regardless of the type we declare.
 */
function streamDocument(res, file, asDownload) {
  const absolute = resolveStoredPath(file.storageKey)
  const disposition = asDownload ? 'attachment' : 'inline'

  res.setHeader('Content-Type', file.mimeType)
  res.setHeader('Content-Length', file.size)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${file.originalFileName.replaceAll('"', '')}"`,
  )

  return createReadStream(absolute).pipe(res)
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** GET /api/v1/admin/users/:id/profile */
export const getUserProfile = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'Profile loaded.', data: await service.getProfile(target(req)) }),
)

/** GET /api/v1/admin/users/:id/documents */
export const getUserDocuments = asyncHandler(async (req, res) =>
  sendSuccess(res, { message: 'Documents loaded.', data: await service.listDocuments(target(req)) }),
)

/** GET /api/v1/admin/users/:id/documents/:documentId/file */
export const getUserDocumentFile = asyncHandler(async (req, res) =>
  streamDocument(res, await service.readDocumentFile({
    targetId: target(req),
    documentId: objectIdSchema.parse(req.params.documentId),
  }), req.query.download === '1'),
)

/** Shared by verify and reject — the only difference is the status. */
const decide = (status) =>
  asyncHandler(async (req, res) => {
    const targetId = target(req)
    const documentId = objectIdSchema.parse(req.params.documentId)
    const { remarks } = documentDecisionSchema.parse(req.body ?? {})

    const document = await service.decideDocument({
      targetId,
      documentId,
      status,
      remarks,
      actor: req.auth.user,
    })

    /**
     * Recorded as a user event, because that is what it is about.
     *
     * A verification decision is a statement an administrator made about a
     * named person's identity evidence — exactly the kind of thing somebody
     * asks about later, and exactly what the audit log is for.
     */
    await recordAudit({
      req,
      event: status === DOCUMENT_STATUS.VERIFIED ? 'USER_DOCUMENT_VERIFIED' : 'USER_DOCUMENT_REJECTED',
      summary: `${status === DOCUMENT_STATUS.VERIFIED ? 'Verified' : 'Rejected'} "${document.title}"`,
      target: { type: 'user', id: targetId },
      performedFor: { _id: targetId },
      metadata: { documentId, category: document.category, remarks: document.remarks },
    })

    return sendSuccess(res, {
      message: `Document ${status}.`,
      data: document,
    })
  })

export const verifyUserDocument = decide(DOCUMENT_STATUS.VERIFIED)
export const rejectUserDocument = decide(DOCUMENT_STATUS.REJECTED)

export default {
  deleteMyDocument,
  deleteMyPhoto,
  getMyDocumentFile,
  getMyDocuments,
  getMyPerformance,
  getMyProfile,
  getPhoto,
  getUserDocumentFile,
  getUserDocuments,
  getUserProfile,
  patchMyDocument,
  patchMyProfile,
  postMyDocument,
  putMyPhoto,
  rejectUserDocument,
  verifyUserDocument,
}

/**
 * GET /api/v1/account/signature
 *
 * The caller's own signature. No permission beyond being signed in: it is the
 * reader's own content and nobody else's is reachable through this route.
 */
export const getMySignature = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    message: 'Signature loaded.',
    // `?? ''` rather than a nullish body: an account created before this field
    // existed has no value, and "no signature" is an empty one, not an error.
    data: { signatureHtml: req.auth.user.signatureHtml ?? '' },
  }),
)

/**
 * PUT /api/v1/account/signature
 *
 * Replaces it. Sanitised by the schema on the way in — see
 * `signatureSchema` — so nothing unchecked is ever written to the document.
 */
export const putMySignature = asyncHandler(async (req, res) => {
  const { signatureHtml } = signatureSchema.parse(req.body)

  const user = await User.findByIdAndUpdate(
    req.auth.user._id,
    { $set: { signatureHtml } },
    { new: true },
  ).select('signatureHtml')

  return sendSuccess(res, {
    message: signatureHtml === '' ? 'Signature cleared.' : 'Signature saved.',
    data: { signatureHtml: user?.signatureHtml ?? '' },
  })
})
