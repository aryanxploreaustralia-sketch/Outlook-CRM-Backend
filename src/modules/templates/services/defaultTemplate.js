/**
 * The introduction seeded into a new workspace.
 *
 * This is **content, not engine**. Nothing in the renderer knows the company's
 * name, its services or its wording — it all lives in this one object, is
 * written into the database on first use, and is editable from the Email
 * Templates screen from that moment on. Changing the company's introduction is
 * therefore a thing a salesperson does in the application, never a code change,
 * which is the whole point of the phase.
 *
 * If you are looking for where to change the wording: don't change it here.
 * Edit the template in the application. This object is only ever read once per
 * workspace, when no template exists at all.
 */

import { TEMPLATE_STATUS } from '../constants/templateConstants.js'

/**
 * Inline styles rather than a stylesheet.
 *
 * Outlook, Gmail and Apple Mail all strip or ignore `<style>` blocks to varying
 * degrees; inline attributes are the only styling that survives all three. A
 * table wrapper is used for the same reason — it is the one layout primitive
 * every mail client renders consistently.
 */
const BODY_HTML = `
<div style="margin:0;padding:0;background-color:#f4f6f8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border-radius:8px;border:1px solid #e2e8f0;">
          <tr>
            <td style="padding:32px 32px 8px 32px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1e293b;">
              <p style="margin:0 0 16px 0;">Dear {{ContactPerson}},</p>

              <p style="margin:0 0 16px 0;">
                Greetings from <strong>Xplore Australia</strong>, a Destination Management
                Company specialising in Australia and New Zealand.
              </p>

              <p style="margin:0 0 16px 0;">
                We work as the ground partner for travel agents and tour operators,
                handling everything on the destination side so you can concentrate on
                selling. Our team is based in the destination, contracts directly, and
                supports your travellers from arrival to departure.
              </p>

              <p style="margin:0 0 8px 0;font-weight:600;">What we handle</p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1e293b;">
                <tr><td style="padding:2px 12px 2px 0;">&bull;</td><td style="padding:2px 0;">Hotels across all categories, directly contracted</td></tr>
                <tr><td style="padding:2px 12px 2px 0;">&bull;</td><td style="padding:2px 0;">Airport and inter-city transfers</td></tr>
                <tr><td style="padding:2px 12px 2px 0;">&bull;</td><td style="padding:2px 0;">FIT arrangements</td></tr>
                <tr><td style="padding:2px 12px 2px 0;">&bull;</td><td style="padding:2px 0;">Series and ad-hoc groups</td></tr>
                <tr><td style="padding:2px 12px 2px 0;">&bull;</td><td style="padding:2px 0;">MICE, conferences and incentives</td></tr>
                <tr><td style="padding:2px 12px 2px 0;">&bull;</td><td style="padding:2px 0;">Luxury and bespoke travel</td></tr>
                <tr><td style="padding:2px 12px 2px 0;">&bull;</td><td style="padding:2px 0;">Sightseeing, attractions and day tours</td></tr>
                <tr><td style="padding:2px 12px 2px 0;">&bull;</td><td style="padding:2px 0;">Custom itinerary design and costing</td></tr>
                <tr><td style="padding:2px 12px 2px 0;">&bull;</td><td style="padding:2px 0;">24&times;7 ground support while your clients are travelling</td></tr>
              </table>

              <p style="margin:0 0 16px 0;">
                We would be glad to be your Australia and New Zealand partner, whether
                that is a single quotation or a full season of departures.
              </p>

              <p style="margin:0 0 24px 0;">
                <strong>Please reply to this email if you have any Australia or New Zealand travel requirements.</strong>
              </p>

              <p style="margin:0 0 4px 0;">Warm regards,</p>
              <p style="margin:0 0 24px 0;">
                <strong>{{HandledBy}}</strong><br>
                Xplore Australia<br>
                <span style="color:#64748b;">Australia &amp; New Zealand Destination Management</span>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px 32px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
              Your enquiry reference is {{Reference}}. Quoting it in your reply helps us
              find your file straight away.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>
`.trim()

const BODY_TEXT = `
Dear {{ContactPerson}},

Greetings from Xplore Australia, a Destination Management Company specialising
in Australia and New Zealand.

We work as the ground partner for travel agents and tour operators, handling
everything on the destination side so you can concentrate on selling. Our team
is based in the destination, contracts directly, and supports your travellers
from arrival to departure.

What we handle:

  - Hotels across all categories, directly contracted
  - Airport and inter-city transfers
  - FIT arrangements
  - Series and ad-hoc groups
  - MICE, conferences and incentives
  - Luxury and bespoke travel
  - Sightseeing, attractions and day tours
  - Custom itinerary design and costing
  - 24x7 ground support while your clients are travelling

We would be glad to be your Australia and New Zealand partner, whether that is
a single quotation or a full season of departures.

Please reply to this email if you have any Australia or New Zealand travel
requirements.

Warm regards,
{{HandledBy}}
Xplore Australia
Australia & New Zealand Destination Management

Your enquiry reference is {{Reference}}. Quoting it in your reply helps us find
your file straight away.
`.trim()

/**
 * Seeded as ACTIVE.
 *
 * A workspace that has never opened the templates screen still has a working
 * morning run — the alternative is a first upload that creates leads and emails
 * nobody, which looks like a broken product rather than a missing setting.
 */
export const DEFAULT_INTRODUCTION = Object.freeze({
  name: 'B2B Introduction',
  description:
    'Introduces the company to a travel agent or corporate client who has just raised their first enquiry. Sent automatically to every NEW lead found in the morning workbook.',
  category: 'travel_offer',
  status: TEMPLATE_STATUS.ACTIVE,
  subject: 'Partner with Xplore Australia | Your Trusted Australia & New Zealand DMC',
  bodyHtml: BODY_HTML,
  bodyText: BODY_TEXT,
})

export default DEFAULT_INTRODUCTION
