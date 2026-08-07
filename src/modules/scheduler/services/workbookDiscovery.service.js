/**
 * Finding this morning's workbook.
 *
 * ## Where a workbook comes from when nobody uploads one
 *
 * Until this phase, a workbook existed because a human dragged it into the
 * browser. Automating the run means the file has to arrive some other way, and
 * there are only two candidates: a folder the team drops it in, or a cloud
 * mailbox the server reaches into. The second is out of scope for this phase
 * and would put the daily run behind the Graph token lifetime, so this module
 * watches a folder.
 *
 * The folder is deployment configuration (`WORKBOOK_INBOX_DIR`), not a settings
 * field — see the note in `schedulerSetting.model.js` for why a server path must
 * never arrive in a request body.
 *
 * ## What this module refuses to do
 *
 * Parse, compare, create or send. It answers "which file, and is it whole?" and
 * hands back bytes. The classifier and the queue do everything else, exactly as
 * they do for an upload.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { createContextLogger } from '../../../utils/logger.js'
import { SCHEDULER_SKIP_REASON, WORKBOOK_SETTLE_MS } from '../constants/schedulerConstants.js'

const log = createContextLogger('workbook-discovery')

/** The only extension the workbook engine reads. */
const WORKBOOK_EXTENSION = '.xlsx'

/**
 * Names that look like workbooks but are not.
 *
 * `~$today.xlsx` is the lock file Excel writes while the sheet is open on
 * somebody's desktop. It is a few hundred bytes of nothing, it is always the
 * newest file in the directory, and picking it would mean the scheduler
 * processes a lock file every morning somebody left the workbook open.
 */
const isIgnoredName = (name) => name.startsWith('~$') || name.startsWith('.')

/**
 * Creates the inbox if it is not there.
 *
 * Called once at boot rather than on every check, because a folder that appears
 * as a side effect of reading it is a folder nobody can deliberately remove.
 * Failure is not fatal — an unwritable parent is a deployment problem worth a
 * warning, not a reason to refuse to serve the API.
 */
export async function ensureInbox(directory) {
  try {
    await mkdir(directory, { recursive: true })
    return true
  } catch (error) {
    log.warn('The workbook inbox could not be created', { directory, error: error.message })
    return false
  }
}

/**
 * Lists candidate workbooks, newest first.
 *
 * Sorted by the file's own modification time rather than its name, because
 * "Mukesh Primary Sheet (3).xlsx" sorts after "(11)" and the team's naming is
 * not the scheduler's business. Filename breaks a tie, so the choice is
 * deterministic when two files share an mtime to the millisecond.
 */
async function listCandidates(directory) {
  const entries = await readdir(directory, { withFileTypes: true })

  const stats = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          !isIgnoredName(entry.name) &&
          path.extname(entry.name).toLowerCase() === WORKBOOK_EXTENSION,
      )
      .map(async (entry) => {
        const absolute = path.join(directory, entry.name)

        try {
          const info = await stat(absolute)
          return { filename: entry.name, path: absolute, size: info.size, modifiedAt: info.mtime }
        } catch {
          // Vanished between the listing and the stat — somebody is tidying the
          // folder while we read it. Not an error; there is simply one fewer
          // candidate than there was a moment ago.
          return null
        }
      }),
  )

  return stats
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.modifiedAt.getTime() - a.modifiedAt.getTime() || b.filename.localeCompare(a.filename),
    )
}

/**
 * Picks the newest workbook in the inbox and reads it.
 *
 * Never throws for an ordinary "nothing to do" outcome — a missing directory,
 * an empty directory and a file still being copied are all normal mornings, and
 * a scheduler that threw on them would fill the log with stack traces on every
 * day the team happened not to export. Each returns a reason instead.
 *
 * @param {{ directory: string, now?: Date }} params
 * @returns {Promise<
 *   | { found: true, filename, path, size, modifiedAt, buffer: Buffer, hash: string, candidates: number }
 *   | { found: false, reason: string, message: string }
 * >}
 */
export async function findLatestWorkbook({ directory, now = new Date() }) {
  let candidates

  try {
    candidates = await listCandidates(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        found: false,
        reason: SCHEDULER_SKIP_REASON.NO_INBOX,
        message:
          `The workbook inbox (${directory}) does not exist, so there was nothing to check. ` +
          'Create the folder and drop the daily export into it.',
      }
    }

    // A permission problem or an unreadable mount is worth surfacing as a skip
    // with its reason rather than as a retry: retrying will not grant access.
    return {
      found: false,
      reason: SCHEDULER_SKIP_REASON.NO_INBOX,
      message: `The workbook inbox (${directory}) could not be read: ${error.message}`,
    }
  }

  if (candidates.length === 0) {
    return {
      found: false,
      reason: SCHEDULER_SKIP_REASON.NO_WORKBOOK,
      message: `No workbook was found in the inbox (${directory}). Nothing was imported.`,
    }
  }

  const newest = candidates[0]

  /**
   * A file that changed a moment ago may still be arriving.
   *
   * See `WORKBOOK_SETTLE_MS`. The run is not lost — the next tick is a minute
   * away, by which time the copy has finished and the same file is chosen.
   */
  const age = now.getTime() - newest.modifiedAt.getTime()
  if (age < WORKBOOK_SETTLE_MS) {
    return {
      found: false,
      reason: SCHEDULER_SKIP_REASON.NO_WORKBOOK,
      message:
        `"${newest.filename}" is still being written (last changed ${Math.round(age / 1000)}s ago). ` +
        'It will be picked up once the copy finishes.',
    }
  }

  if (newest.size === 0) {
    return {
      found: false,
      reason: SCHEDULER_SKIP_REASON.UNREADABLE,
      message: `"${newest.filename}" is empty (0 bytes), so it was not imported.`,
    }
  }

  const buffer = await readFile(newest.path)

  log.info('Workbook selected', {
    file: newest.path,
    bytes: newest.size,
    modifiedAt: newest.modifiedAt.toISOString(),
    candidates: candidates.length,
  })

  return {
    found: true,
    ...newest,
    buffer,
    /**
     * Content identity.
     *
     * The same bytes are the same workbook whatever they are called and
     * whenever they were touched, which is the only definition under which
     * "never process the same workbook twice" means what an operator expects.
     */
    hash: createHash('sha256').update(buffer).digest('hex'),
    candidates: candidates.length,
  }
}

export default { findLatestWorkbook, ensureInbox }
