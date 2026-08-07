/**
 * Provider controller.
 *
 * Thin by design, matching the rest of the API: validate HTTP input, delegate to
 * `provider.service`, wrap the result in the standard envelope. No adapter is
 * constructed here and no Graph symbol is imported — that is the whole point of
 * the layer below.
 */

import { z } from 'zod'

import { HTTP_STATUS } from '../../../constants/httpStatus.js'
import { asyncHandler } from '../../../utils/asyncHandler.js'
import { sendSuccess } from '../../../utils/ApiResponse.js'
import { FOLDERS, SYNCABLE_FOLDERS } from '../constants/folderTypes.js'
import { SYNC_MODE, SYNC_TRIGGER } from '../constants/syncStatus.js'
import { PROVIDER_TYPE_VALUES } from '../constants/providerTypes.js'
import * as providerService from '../services/provider.service.js'
import {
  toConnectDto,
  toFolderListDto,
  toHistoryDto,
  toStatusDto,
  toSyncRunDto,
} from '../dto/provider.dto.js'

/**
 * The mailbox a request acts on.
 *
 * Optional everywhere, so a client that never sends it keeps the previous
 * behaviour exactly: the service falls back to the workspace default.
 *
 * Validated for *shape* only. Whether the id belongs to the caller is decided
 * in `resolveContext`, against the database and scoped by user — a format check
 * is not an ownership check, and an endpoint that treated it as one would be an
 * IDOR waiting to happen.
 */
const mailboxIdSchema = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, 'That is not a valid mailbox id.')
  .optional()

/** Reads `mailboxId` from the query string, then the body. */
const readMailboxId = (req) =>
  mailboxIdSchema.parse(req.query?.mailboxId ?? req.body?.mailboxId ?? undefined) ?? null

/** `POST /provider/connect` body. */
const connectSchema = z.object({
  provider: z.enum(PROVIDER_TYPE_VALUES).optional(),
})

/** `POST /provider/sync` body. */
const syncSchema = z.object({
  folders: z
    .array(z.enum(Object.values(FOLDERS)))
    .min(1, 'Name at least one folder, or omit the field to sync all of them.')
    .optional(),
  mode: z.enum(Object.values(SYNC_MODE)).optional().default(SYNC_MODE.INCREMENTAL),
  trigger: z.enum(Object.values(SYNC_TRIGGER)).optional().default(SYNC_TRIGGER.MANUAL),
})

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  /** Opt in to a workspace-wide list. Each row still names its own mailbox. */
  allMailboxes: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})

const foldersQuerySchema = z.object({
  /** Re-reads folders from the provider instead of serving the stored list. */
  refresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})

/**
 * GET /api/v1/provider/status
 *
 * Connection state, sync state and the last run. Answers for an unconfigured
 * deployment too — "not connected, mock mode" is a successful response the web
 * client needs on first load, not an error.
 */
export const getStatus = asyncHandler(async (req, res) => {
  const status = await providerService.getStatus({
    auth: req.auth,
    mailboxId: readMailboxId(req),
  })

  return sendSuccess(res, {
    message: status.isMock
      ? 'Provider status retrieved (simulated).'
      : 'Provider status retrieved successfully.',
    data: toStatusDto(status),
  })
})

/**
 * GET /api/v1/provider/folders
 *
 * The mailbox's folders with their canonical mapping. `?refresh=true` re-reads
 * them from the provider first.
 */
export const getFolders = asyncHandler(async (req, res) => {
  const { refresh } = foldersQuerySchema.parse(req.query)

  const { folders, mailbox } = await providerService.listFolders({
    auth: req.auth,
    mailboxId: readMailboxId(req),
    refresh,
  })

  return sendSuccess(res, {
    message: 'Folders retrieved successfully.',
    data: toFolderListDto({ folders, mailbox }),
  })
})

/**
 * POST /api/v1/provider/connect
 *
 * Idempotent — connecting an already-connected mailbox refreshes its details
 * rather than failing.
 */
export const connect = asyncHandler(async (req, res) => {
  const { provider } = connectSchema.parse(req.body ?? {})

  const result = await providerService.connect({ auth: req.auth, providerType: provider })

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: result.isMock
      ? 'Connected to a simulated mailbox. Configure Microsoft credentials for live data.'
      : 'Mailbox connected successfully.',
    data: toConnectDto(result),
  })
})

/**
 * POST /api/v1/provider/disconnect
 *
 * Synced messages are retained — a disconnect is not a request to delete the
 * user's mail history.
 */
export const disconnect = asyncHandler(async (req, res) => {
  const { mailbox } = await providerService.disconnect({
    auth: req.auth,
    mailboxId: readMailboxId(req),
  })

  return sendSuccess(res, {
    message: 'Mailbox disconnected. Synchronised messages have been kept.',
    data: { mailbox: mailbox.toPublicJSON() },
  })
})

/** Shared by the general sync endpoint and each per-folder variant. */
const runSync = (folders) =>
  asyncHandler(async (req, res) => {
    const body = syncSchema.parse(req.body ?? {})

    const { run, isMock } = await providerService.runSync({
      auth: req.auth,
      mailboxId: readMailboxId(req),
      folders: folders ?? body.folders ?? SYNCABLE_FOLDERS,
      mode: body.mode,
      trigger: body.trigger,
    })

    return sendSuccess(res, {
      message: isMock
        ? 'Synchronisation complete (simulated data).'
        : 'Synchronisation complete.',
      data: toSyncRunDto({ run, isMock }),
    })
  })

/** POST /api/v1/provider/sync — every syncable folder, or those named in the body. */
export const sync = runSync(null)

/** POST /api/v1/provider/sync/inbox */
export const syncInbox = runSync([FOLDERS.INBOX])

/** POST /api/v1/provider/sync/sent */
export const syncSent = runSync([FOLDERS.SENT])

/** POST /api/v1/provider/sync/drafts */
export const syncDrafts = runSync([FOLDERS.DRAFTS])

/** POST /api/v1/provider/sync/archive */
export const syncArchive = runSync([FOLDERS.ARCHIVE])

/**
 * GET /api/v1/provider/history
 *
 * Paginated run history, newest first.
 */
export const getHistory = asyncHandler(async (req, res) => {
  const { page, limit, allMailboxes } = historyQuerySchema.parse(req.query)

  const { items, meta } = await providerService.getHistory({
    auth: req.auth,
    mailboxId: readMailboxId(req),
    allMailboxes,
    page,
    limit,
  })

  return sendSuccess(res, {
    message: 'Synchronisation history retrieved successfully.',
    data: toHistoryDto({ items }),
    meta,
  })
})

/**
 * GET /api/v1/provider/validate
 *
 * Live probe. Distinct from `/status`, which reports stored state — this makes
 * a real round trip to the provider.
 */
export const validate = asyncHandler(async (req, res) => {
  const result = await providerService.validate({
    auth: req.auth,
    mailboxId: readMailboxId(req),
  })

  return sendSuccess(res, {
    message: 'Connection validated.',
    data: result,
  })
})

export default {
  getStatus,
  getFolders,
  connect,
  disconnect,
  sync,
  syncInbox,
  syncSent,
  syncDrafts,
  syncArchive,
  getHistory,
  validate,
}
