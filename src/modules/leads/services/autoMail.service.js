/**
 * The introductory email sent to a genuinely new lead.
 *
 * The single most consequential piece of the product, because the failure modes
 * are asymmetric: not sending is a missed enquiry, but sending twice is a
 * customer receiving the same introduction every morning until somebody
 * notices. Everything here is arranged around never doing the second one.
 *
 * ## Three independent guards
 *
 * 1. **Category.** Only a row categorised `new` is ever offered to this module.
 * 2. **Persisted state.** `lead.autoMail.status === 'sent'` refuses a resend,
 *    even if the categoriser were wrong. This lives on the lead rather than
 *    being inferred from mail history, so clearing mail history cannot cause a
 *    second send.
 * 3. **Explicit override.** `forceResend` is the only way past guard 2, it
 *    defaults off, and it records who forced it and when.
 *
 * Any one of the three failing still leaves two in place.
 */

import { Mail } from '../../../models/mail.model.js'
import { MAIL_STATUS } from '../../../constants/mailStatus.js'
import { createContextLogger } from '../../../utils/logger.js'
import { renderMessage } from '../../campaigns/services/personalisation.service.js'
import { renderForLead } from '../../templates/services/template.service.js'
import { AUTO_MAIL_STATUS, SKIP_REASON } from '../constants/syncConstants.js'

const log = createContextLogger('workbook-sync')

/**
 * The last-resort introduction.
 *
 * Phase 11 moved the real wording into the template library, where a
 * salesperson can edit it: the morning run resolves the ACTIVE template and
 * passes it in. This object remains only as the fallback for a caller that
 * supplies no template at all — the Phase 10 service signature allowed that,
 * and removing it would break any caller still relying on the default.
 *
 * It is deliberately plain. If you are looking for the message customers
 * actually receive, it is in the database, editable from Email Templates.
 */
export const DEFAULT_TEMPLATE = Object.freeze({
  subject: 'Your enquiry {{Reference}} — {{Destination}}',
  bodyHtml: [
    '<p>Dear {{ContactPerson}},</p>',
    '<p>Thank you for your enquiry. We have it on file under reference ',
    '<strong>{{Reference}}</strong> and are preparing your quotation.</p>',
    '<p>If anything has changed — dates, traveller numbers or destination — ',
    'just reply to this message and we will update it.</p>',
    '<p>Kind regards,<br>{{HandledBy}}</p>',
  ].join(''),
})

/**
 * Renders one lead's message.
 *
 * Phase 11's engine is used when the template carries lead variables, which is
 * every template the library produces. The Phase 7 contact personaliser is kept
 * for the one case it still serves: a caller passing a template written in the
 * campaign vocabulary (`{{FirstName}}`, `{{Agent}}`). Detecting which by
 * inspecting the content means neither kind of caller has to declare anything,
 * and no existing caller changes behaviour.
 */
function renderIntroduction({ template, lead, agentName }) {
  const source = `${template.subject ?? ''}${template.bodyHtml ?? ''}`
  const usesCampaignVocabulary = /\{\{\s*(FirstName|LastName|FullName|Agent|JobTitle)\s*\}\}/.test(source)

  if (!usesCampaignVocabulary) {
    return renderForLead({
      template: {
        subject: template.subject ?? DEFAULT_TEMPLATE.subject,
        bodyHtml: template.bodyHtml ?? DEFAULT_TEMPLATE.bodyHtml,
        bodyText: template.bodyText ?? null,
      },
      // `handledBy` carries the agent's name into `{{HandledBy}}`. A run may
      // name the sender explicitly; the workbook's own column is the fallback,
      // because it is who actually owns the enquiry.
      lead: { ...(lead.toObject?.() ?? lead), handledBy: agentName ?? lead.handledBy ?? '' },
    })
  }

  return renderMessage({
    subject: template.subject ?? DEFAULT_TEMPLATE.subject,
    bodyHtml: template.bodyHtml ?? DEFAULT_TEMPLATE.bodyHtml,
    bodyText: template.bodyText ?? null,
    contact: {
      firstName: lead.contactPerson?.split(' ')[0] ?? null,
      lastName: lead.contactPerson?.split(' ').slice(1).join(' ') || null,
      displayName: lead.contactPerson,
      company: lead.companyName,
      primaryEmail: lead.email,
      city: lead.city,
    },
    campaignValues: {
      Reference: lead.reference,
      Destination: lead.city ?? lead.market ?? 'your trip',
      Agent: agentName ?? 'the team',
      TravelDate: lead.travelDateText ?? lead.travelDate?.toISOString().slice(0, 10) ?? '',
      Pax: lead.paxText ?? '',
    },
  })
}

/**
 * Decides whether a lead may be emailed, without sending anything.
 *
 * Separate from the send so the preview can report exactly how many messages
 * will go out, and why the rest will not.
 *
 * @returns {{ allowed: boolean, reason: ?string }}
 */
export function screenForAutoMail({ lead, isNew, forceResend = false, automationEnabled = true }) {
  if (!automationEnabled) return { allowed: false, reason: SKIP_REASON.AUTOMATION_OFF }

  if (!isNew && !forceResend) return { allowed: false, reason: SKIP_REASON.NOT_NEW }

  if (lead.autoMail?.status === AUTO_MAIL_STATUS.SENT && !forceResend) {
    return { allowed: false, reason: SKIP_REASON.ALREADY_SENT }
  }

  if (!lead.email) return { allowed: false, reason: SKIP_REASON.NO_EMAIL }

  if (lead.doNotContact) return { allowed: false, reason: SKIP_REASON.DO_NOT_CONTACT }

  return { allowed: true, reason: null }
}

/**
 * Sends the introduction to one lead.
 *
 * Writes a Phase 4 `Mail` record as well, so an automatic send appears in mail
 * history beside anything sent by hand — a send the user cannot see in the
 * usual place is a send they cannot audit.
 *
 * @param {{ lead, provider, mailbox, owner, template, agentName, forceResend, actor, importJob }} params
 * @returns {Promise<{ sent: boolean, reason: ?string, error: ?string }>}
 */
export async function sendIntroduction({
  lead,
  provider,
  mailbox,
  owner,
  template = DEFAULT_TEMPLATE,
  agentName = null,
  forceResend = false,
  actor = null,
  importJob = null,
}) {
  const rendered = renderIntroduction({ template, lead, agentName })

  /**
   * Which template produced this, recorded on every mail row below.
   *
   * The name is denormalised alongside the id because a template can be
   * archived or deleted, and history reading "sent with a template that no
   * longer exists" is useless where "sent with B2B Introduction v3" is not.
   */
  const provenance = {
    template: template?._id ?? null,
    templateName: template?.name ?? null,
    templateVersion: template?.version ?? null,
    renderedVariables: rendered.values ?? undefined,
  }

  lead.autoMail = lead.autoMail ?? {}
  lead.autoMail.attempts = (lead.autoMail.attempts ?? 0) + 1
  lead.autoMail.lastAttemptAt = new Date()
  lead.autoMail.subject = rendered.subject

  try {
    const result = await provider.send(
      {
        to: [{ address: lead.email, name: lead.contactPerson ?? null }],
        subject: rendered.subject,
        bodyHtml: rendered.html,
      },
      { mailbox },
    )

    /**
     * The audit record is written in its own try/catch.
     *
     * Once the provider has accepted the message, the customer has been
     * emailed — that is a fact about the outside world, and nothing that
     * happens afterwards can undo it. An earlier version let a failure here
     * fall into the outer catch, which marked the lead `failed` and told the
     * operator the message had not gone out. It had. Worse, the mail history
     * would then disagree with reality in the other direction on a retry.
     *
     * So a failed audit write is logged and recorded on the lead, and the send
     * is still reported as what it was: successful.
     */
    let mail = null
    let auditError = null

    try {
      mail = await Mail.create({
        userId: owner,
        mailbox: mailbox?._id ?? null,
        provider: provider.type,
        from: mailbox?.emailAddress ?? null,
        to: [{ address: lead.email, name: lead.contactPerson ?? null }],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...provenance,
        status: MAIL_STATUS.SENT,
        sentAt: new Date(),
        graphRequestId: result?.correlationId ?? null,
        providerMessageId: result?.providerMessageId ?? null,
        internetMessageId: result?.internetMessageId ?? null,
        conversationId: result?.conversationId ?? null,
      })
    } catch (error) {
      auditError = error?.message ?? 'The mail history record could not be written.'
      log.warn('Send succeeded but its audit record did not', {
        reference: lead.reference,
        error: auditError,
      })
    }

    lead.autoMail.status = AUTO_MAIL_STATUS.SENT
    lead.autoMail.sentAt = new Date()
    lead.autoMail.mail = mail?._id ?? null
    lead.autoMail.providerMessageId = result?.providerMessageId ?? null
    /**
     * The RFC id and thread key are stored so a reply can be matched back.
     *
     * Phase 9's matcher resolves In-Reply-To against exactly these; without
     * them a customer's answer to this message would fall through to a weaker
     * strategy or land unmatched.
     */
    lead.autoMail.messageId = result?.internetMessageId ?? null
    lead.autoMail.conversationId = result?.conversationId ?? null
    // Null on a clean send; otherwise it names the audit problem, not a send
    // problem, so the two are never confused when someone reads the record.
    lead.autoMail.error = auditError

    if (forceResend) {
      lead.autoMail.forcedAt = new Date()
      lead.autoMail.forcedBy = actor
    }

    lead.lastContactedAt = new Date()
    await lead.save()

    log.info('Introduction sent', {
      reference: lead.reference,
      to: lead.email,
      importJob: importJob ? String(importJob) : null,
      forced: forceResend,
    })

    return { sent: true, reason: null, error: null }
  } catch (error) {
    lead.autoMail.status = AUTO_MAIL_STATUS.FAILED
    lead.autoMail.error = error?.message ?? 'The send failed.'
    await lead.save()

    // Recorded as a failed send too, so mail history shows the attempt rather
    // than the message simply never existing.
    await Mail.create({
      userId: owner,
      mailbox: mailbox?._id ?? null,
      provider: provider?.type ?? null,
      from: mailbox?.emailAddress ?? null,
      to: [{ address: lead.email, name: lead.contactPerson ?? null }],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...provenance,
      status: MAIL_STATUS.FAILED,
      error: { message: error?.message ?? 'The send failed.', code: error?.code ?? null },
    }).catch(() => {
      // A failed audit write must not mask the send failure it is describing.
    })

    log.warn('Introduction failed', {
      reference: lead.reference,
      to: lead.email,
      error: error?.message,
    })

    return { sent: false, reason: null, error: error?.message ?? 'The send failed.' }
  }
}

/**
 * Marks a lead as deliberately not emailed.
 *
 * Recorded rather than left `pending`, so the auto-mail queue does not offer
 * the same unsendable lead on every subsequent run.
 */
export async function markSkipped({ lead, reason }) {
  lead.autoMail = lead.autoMail ?? {}

  /**
   * Some skips are permanent facts about the lead; others are temporary facts
   * about the run. Only the first kind may be recorded as `skipped`, because
   * `pendingIntroductions` counts `pending` and `failed` and a `skipped` lead is
   * never offered again.
   *
   * `no_email` and `do_not_contact` are properties of the lead — recording them
   * stops the queue offering an unsendable lead every morning.
   *
   * `automation_off` and `not_new` are properties of the run, and the lead is
   * still owed a message.
   *
   * ## Why `no_mailbox` joined the second group in Phase 13.2
   *
   * It is a property of the *workspace*, and a temporary one: somebody connects
   * a mailbox and it is fixed. It used to behave like the first group, which
   * was harmless while a Microsoft sign-in guaranteed a mailbox — "no mailbox"
   * essentially never happened.
   *
   * Google sign-in makes it the normal state of a brand-new workspace. A team
   * whose first act is importing the workbook before connecting a mailbox would
   * have had every lead marked `skipped` for good, and no introduction would
   * ever be sent for any of them — silently, with the leads themselves
   * perfectly intact. Leaving them `pending` means they go out on the next run
   * after a mailbox is connected.
   *
   * This does not weaken the duplicate guards: `autoMail.status === 'sent'`
   * still refuses a resend, and nothing here can set that. A lead that was
   * never emailed staying eligible to be emailed once is the intended
   * behaviour, not a retry loop.
   */
  const RUN_SCOPED_REASONS = [
    SKIP_REASON.AUTOMATION_OFF,
    SKIP_REASON.NOT_NEW,
    SKIP_REASON.NO_MAILBOX,
  ]

  if (RUN_SCOPED_REASONS.includes(reason)) return lead

  lead.autoMail.status = AUTO_MAIL_STATUS.SKIPPED
  lead.autoMail.error = reason
  await lead.save()

  return lead
}

export default { sendIntroduction, screenForAutoMail, markSkipped, DEFAULT_TEMPLATE }
