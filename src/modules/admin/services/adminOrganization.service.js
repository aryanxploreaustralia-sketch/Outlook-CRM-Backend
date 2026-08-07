/**
 * Organization information, read-only.
 *
 * ## There is no `Organization` collection, and this phase does not create one
 *
 * The Phase 14.0 design specifies it; Phase 14.3 builds it, together with the
 * `Membership` model and the workspace resolver it exists to serve. Creating it
 * here would be a database migration in a phase whose brief forbids one, and a
 * half-built tenancy root is worse than none — it invites code to start reading
 * a boundary that nothing yet enforces.
 *
 * So this endpoint answers `configured: false` and returns what the deployment
 * *does* know about itself, drawn from configuration and from the records that
 * already exist:
 *
 *  - the application name and environment, from validated config;
 *  - the scheduling timezone, from the elected primary `SchedulerSetting` —
 *    which is the only timezone in this system that currently decides anything;
 *  - when the workspace began, from the earliest user account.
 *
 * Every one of those is real. Nothing here is invented to fill a field, because
 * a placeholder that looks like a setting is a placeholder somebody will try to
 * change.
 */

import { config } from '../../../config/index.js'
import { SchedulerSetting } from '../../../models/schedulerSetting.model.js'
import { User } from '../../../models/user.model.js'

/**
 * Builds the organization payload.
 *
 * @returns {Promise<object>}
 */
export async function buildAdminOrganization() {
  const [primaryScheduler, founder, userCount] = await Promise.all([
    SchedulerSetting.findOne({ isPrimary: true }).select('timezone runTime owner').lean(),
    User.findOne({ isDeleted: { $ne: true } })
      .sort({ createdAt: 1 })
      .select('displayName email createdAt')
      .lean(),
    User.countDocuments({ isDeleted: { $ne: true } }),
  ])

  return {
    /**
     * The flag the console branches on.
     *
     * False until Phase 14.3 introduces the `Organization` document. Everything
     * below is derived, not stored, and the interface says so rather than
     * offering a Save button over values that have nowhere to be saved.
     */
    configured: false,

    reason: 'no_organization_record',
    message:
      'No organization record exists yet. The values below are derived from configuration and from existing records; editing them becomes possible once the organization is created.',

    identity: {
      /** The deployment's own name, from validated config — not a guess. */
      name: config.app.name,
      environment: config.app.env,
      version: config.app.version,
      /** Null rather than a fabricated trading name. */
      legalName: null,
      logoUrl: null,
    },

    regional: {
      /**
       * The scheduling timezone, and the note that it is the one that matters.
       *
       * This is the timezone the morning run uses. It is owned by
       * `SchedulerSetting` and edited from CRM Settings — not here, and not by
       * this phase. Reporting it as an organization setting without saying so
       * is how somebody ends up changing the wrong one.
       */
      timezone: primaryScheduler?.timezone ?? null,
      timezoneSource: primaryScheduler ? 'scheduler' : null,
      timezoneNote:
        'This is the scheduling timezone. It governs when automated mail is sent and is configured in CRM Settings.',
      scheduledRunTime: primaryScheduler?.runTime ?? null,
      locale: null,
      currency: null,
    },

    workspace: {
      userCount,
      establishedAt: founder?.createdAt ?? null,
      /** Present for context; identifies the account, never a credential. */
      firstUser: founder
        ? { displayName: founder.displayName ?? null, email: founder.email ?? null }
        : null,
    },

    /** What the deployment can actually do, read from validated config. */
    integrations: {
      microsoft: { configured: config.microsoft.enabled === true },
      google: { configured: config.google.enabled === true },
    },

    meta: { source: 'derived', generatedAt: new Date().toISOString() },
  }
}

export default { buildAdminOrganization }
