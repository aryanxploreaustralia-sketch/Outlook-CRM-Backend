/**
 * Sanitises the HTML this CRM puts into an email.
 *
 * ## Why a library and not a regex
 *
 * HTML is not a regular language. Every hand-rolled sanitiser is eventually
 * defeated by something the author did not think of — a malformed tag the
 * parser recovers differently from the filter, an attribute split across a
 * newline, an entity-encoded `javascript:`. `sanitize-html` parses the document
 * and re-serialises only what the allow-list permits, so anything unrecognised
 * cannot survive by being unusual.
 *
 * ## Allow-list, not block-list
 *
 * The tag and attribute lists below are what the editor legitimately produces
 * plus what mail clients need. Anything absent is dropped rather than escaped.
 * A block-list would need extending every time a new vector is published; this
 * needs extending only when the editor gains a feature.
 *
 * ## Why the style allow-list is so long
 *
 * `RichTextEditor` builds tables for Outlook, whose rendering engine is Word's:
 * it ignores stylesheets, so every rule has to be an inline style. Stripping
 * inline styles would be a defensible security decision in a web page and is
 * the wrong one here — it would silently flatten every table, colour and
 * alignment the composer produced, and the user would conclude the editor was
 * broken rather than that the mail was sanitised. So styles are permitted, but
 * only these properties and only values matching the patterns below.
 */

import sanitizeHtml from 'sanitize-html'

/**
 * Style properties the editor and its tables actually emit.
 *
 * Values are pattern-matched, not merely name-checked: `sanitize-html` drops a
 * declaration whose value fails its regex, which is what stops
 * `background-color: url(javascript:...)` from riding in on an allowed property.
 */
const STYLE_VALUES = Object.freeze({
  color: [/^#[\da-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z-]+$/i],
  'background-color': [/^#[\da-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i, /^[a-z-]+$/i],
  'font-size': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/i],
  'font-family': [/^[\w\s\-,'"]+$/i],
  'font-weight': [/^(normal|bold|bolder|lighter|[1-9]00)$/i],
  'font-style': [/^(normal|italic|oblique)$/i],
  'text-decoration': [/^[\w\s-]+$/i],
  'text-align': [/^(left|right|center|justify)$/i],
  'vertical-align': [/^(top|middle|bottom|baseline)$/i],
  width: [/^\d+(\.\d+)?(px|pt|em|rem|%)?$/i],
  // Added for inserted images: without it a wide picture overflows the message
  // column in every client. `auto` is permitted so `height:auto` can pair with it.
  'max-width': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/i, /^none$/i],
  'max-height': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/i, /^none$/i],
  height: [/^\d+(\.\d+)?(px|pt|em|rem|%)?$/i, /^auto$/i],
  padding: [/^[\d\s.]+(px|pt|em|rem|%)?([\d\s.a-z%]+)?$/i],
  margin: [/^[\d\s.]+(px|pt|em|rem|%)?([\d\s.a-z%]+)?$/i],
  border: [/^[\w\s#(),.%-]+$/i],
  'border-collapse': [/^(collapse|separate)$/i],
  'border-color': [/^[\w\s#(),.%-]+$/i],
  'border-width': [/^[\d\s.]+(px|pt|em|rem)?$/i],
  'border-style': [/^(none|solid|dashed|dotted|double)$/i],
  'line-height': [/^[\d.]+(px|pt|em|rem|%)?$/i],
})

/** Applied to every element, so a style on a `<span>` is checked like one on a `<td>`. */
const ALLOWED_STYLES = Object.freeze({ '*': STYLE_VALUES })

export const EMAIL_HTML_POLICY = Object.freeze({
  allowedTags: [
    'p', 'div', 'br', 'span', 'hr',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'small',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'a',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    /*
     * `img` is allowed deliberately, even though image *insertion* is not built
     * yet. Templates written before this change may already contain one, and a
     * sanitiser that silently deleted them would corrupt saved content the
     * first time it was re-saved. `src` is protocol-restricted below.
     */
    'img',
  ],

  allowedAttributes: {
    '*': ['style', 'align', 'dir', 'lang', 'title'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    // The presentational attributes Outlook honours when it ignores CSS.
    table: ['border', 'cellpadding', 'cellspacing', 'width', 'bgcolor', 'role'],
    th: ['colspan', 'rowspan', 'width', 'height', 'bgcolor', 'valign', 'scope'],
    td: ['colspan', 'rowspan', 'width', 'height', 'bgcolor', 'valign'],
    tr: ['bgcolor', 'valign'],
    col: ['span', 'width'],
    colgroup: ['span', 'width'],
  },

  allowedStyles: ALLOWED_STYLES,

  /*
   * Protocols. `javascript:`, `vbscript:` and `file:` are absent, so a URL
   * carrying one is dropped along with its attribute.
   *
   * `data:` is permitted for `img` only. It cannot execute in an `<img>`, it is
   * how an inline logo would arrive, and excluding it here would mean silently
   * deleting the image rather than refusing the paste.
   */
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
  allowProtocolRelative: false,

  /*
   * Anything not on the tag list is removed *with its content* when the content
   * is code rather than prose. Without this, `<script>alert(1)</script>` would
   * have its tags stripped and leave the literal text `alert(1)` in the email.
   */
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],

  // A link that opens a new tab should not hand the opener over with it.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true),
  },

  /*
   * Entities are left alone.
   *
   * Template variables travel through this as literal text — `{{firstName}}` is
   * not markup and no rule here touches it — but `&nbsp;` inside the generated
   * table cells must survive as an entity rather than being re-encoded to
   * `&amp;nbsp;`, which is what would happen if the output were escaped again.
   */
  parser: { decodeEntities: false },
})

/**
 * Returns email-safe HTML.
 *
 * Null and undefined pass through as an empty string rather than throwing: a
 * message with no HTML body is ordinary — every plain-text send has one — and
 * this sits directly in the send path.
 *
 * @param {?string} html
 * @returns {string}
 */
export function sanitizeEmailHtml(html) {
  if (html === null || html === undefined) return ''

  const raw = String(html)
  if (raw.trim() === '') return raw

  return sanitizeHtml(raw, EMAIL_HTML_POLICY)
}

export default sanitizeEmailHtml
