/**
 * Employee self-service profile routes.
 *
 * Mounted at `${API_PREFIX}/v1/profile`.
 *
 * ## Authentication only, and that is the whole access model
 *
 * Every handler is scoped to `req.auth.user._id` with no parameter that can
 * widen it, so there is nothing here a signed-in person is not entitled to —
 * their own profile. A permission would mean an account could exist that cannot
 * read its own details, which is not a state anybody wants to administer.
 *
 * The one exception is `GET /photo/:id`, which serves any user's avatar. That
 * image is already rendered beside their name on every screen in the CRM;
 * gating it here while displaying it everywhere else would be theatre.
 *
 * ## Uploads
 *
 * `express.raw`, exactly as the workbook import does — filename and metadata in
 * headers. No multipart parser is introduced.
 */

import express, { Router } from 'express'

import { MAX_DOCUMENT_BYTES } from '../../../constants/employeeProfile.js'
import { requireAuth } from '../../../middlewares/authenticate.js'
import * as controller from '../controllers/profile.controller.js'

const router = Router()

router.use(requireAuth)

/**
 * The body parser for uploads.
 *
 * `limit` is the real defence: it refuses oversized bodies before they are
 * buffered into memory. The per-file check in the service runs afterwards and
 * produces the friendlier message, but this is what stops a 2 GB request.
 */
const rawUpload = express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES })

// --- Profile ---------------------------------------------------------------
router.get('/', controller.getMyProfile)
router.patch('/', controller.patchMyProfile)

/*
 * The caller's email signature. Authenticated only, like the rest of this
 * router — it reads and writes the requester's own document and cannot address
 * anybody else's.
 */
router.get('/signature', controller.getMySignature)
router.put('/signature', controller.putMySignature)

// --- Photo -----------------------------------------------------------------
// The literal path is registered before `/photo/:id` cannot shadow it.
router.put('/photo', rawUpload, controller.putMyPhoto)
router.delete('/photo', controller.deleteMyPhoto)
router.get('/photo/:id', controller.getPhoto)

// --- Documents -------------------------------------------------------------
/**
 * The signed-in person's own performance dashboard (Phase 17.3).
 *
 * Here rather than under `/admin` because it is a self route in every sense
 * that matters: the subject is `req.auth.user._id`, there is no id in the URL,
 * and no permission is involved. An employee may read their own numbers — the
 * brief says so, and a system that scores people without letting them see the
 * score is one nobody should build.
 *
 * The engine itself lives in the admin module, which owns cross-user analytics.
 * Importing it is deliberate: a second implementation for the self view would be
 * a second set of numbers, and the employee's copy disagreeing with their
 * manager's is precisely the failure this phase exists to avoid.
 */
router.get('/performance', controller.getMyPerformance)

router.get('/documents', controller.getMyDocuments)
router.post('/documents', rawUpload, controller.postMyDocument)
router.get('/documents/:documentId/file', controller.getMyDocumentFile)
router.patch('/documents/:documentId', rawUpload, controller.patchMyDocument)
router.delete('/documents/:documentId', controller.deleteMyDocument)

export default router
