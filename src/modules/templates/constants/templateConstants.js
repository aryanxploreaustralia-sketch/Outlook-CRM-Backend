/**
 * Email template engine constants.
 *
 * The template library is the single source of truth for outgoing mail. It is
 * the same collection the campaign builder has always used — this module adds a
 * lifecycle and a lead-shaped variable set on top of it rather than starting a
 * second, competing library. Two template stores would mean the morning run and
 * the campaign builder could disagree about what the company's introduction
 * says, which is exactly the problem this phase exists to remove.
 */

/**
 * Template lifecycle.
 *
 * Only one template per owner may be `active` at a time, and that one is what
 * the workbook sync sends. The other three are all ways of not being that:
 * a `draft` is unfinished, `inactive` is finished but not chosen, `archived` is
 * kept for the record.
 */
export const TEMPLATE_STATUS = Object.freeze({
  DRAFT: 'draft',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  ARCHIVED: 'archived',
})

export const TEMPLATE_STATUS_VALUES = Object.freeze(Object.values(TEMPLATE_STATUS))

export const TEMPLATE_STATUS_LABELS = Object.freeze({
  draft: 'Draft',
  active: 'Active',
  inactive: 'Inactive',
  archived: 'Archived',
})

/**
 * The variables a template may use, and where each is read from.
 *
 * `field` names a path on the lead; `derived` means the resolver computes it.
 * This object is the single definition — the API serves it to the variable
 * picker, the validator checks against it, and the resolver reads it. A
 * variable cannot therefore exist in the picker but not the renderer.
 */
export const LEAD_VARIABLES = Object.freeze([
  {
    name: 'ContactPerson',
    label: 'Contact person',
    description: 'Who raised the enquiry. Falls back to the company name.',
    example: 'Priya Sharma',
  },
  {
    name: 'Company',
    label: 'Company',
    description: 'The agency or corporate client.',
    example: 'Horizon Travel',
  },
  {
    name: 'Reference',
    label: 'Reference',
    description: 'The enquiry number from the workbook. The business key.',
    example: 'XAMP001',
  },
  {
    name: 'Destination',
    label: 'Destination',
    description: 'City enquired about, or the market when no city is given.',
    example: 'Sydney',
  },
  {
    name: 'TravelDate',
    label: 'Travel date',
    description: 'As written in the workbook where possible.',
    example: '15 Oct 2026',
  },
  {
    name: 'HandledBy',
    label: 'Handled by',
    description: 'The agent who owns the enquiry.',
    example: 'MP',
  },
  {
    name: 'Email',
    label: 'Email',
    description: "The customer's address.",
    example: 'priya@horizontravel.com',
  },
  {
    name: 'Phone',
    label: 'Phone',
    description: 'First number on the enquiry.',
    example: '+91 98765 43210',
  },
  {
    name: 'Pax',
    label: 'Passengers',
    description: 'Traveller count as written.',
    example: '2 Adults',
  },
  {
    name: 'CurrentDate',
    label: "Today's date",
    description: 'The date the message is sent.',
    example: '1 August 2026',
  },
  {
    name: 'CurrentYear',
    label: 'Current year',
    description: 'Useful in footers.',
    example: '2026',
  },
])

/** Just the names, for validation. */
export const LEAD_VARIABLE_NAMES = Object.freeze(LEAD_VARIABLES.map((entry) => entry.name))

/** Ceilings, matched to the model so a rejection happens before the database. */
export const TEMPLATE_LIMITS = Object.freeze({
  NAME: 200,
  SUBJECT: 998,
  BODY: 500_000,
  DESCRIPTION: 1000,
})

export default TEMPLATE_STATUS
