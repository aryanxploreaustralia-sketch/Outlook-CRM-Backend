/**
 * Prints the configuration the application actually resolved at boot — with
 * every secret redacted.
 *
 *     npm run config:check
 *
 * ## Why this file exists
 *
 * The check used to be a one-liner in `package.json` that stringified the whole
 * config object. That printed the session secret, the token encryption key and
 * the database URI — credentials and all — in plain text, to a terminal that on
 * a demo machine is often on a projector. The information the command exists to
 * give (did this variable get set, and to what shape) never required the value.
 *
 * A key is redacted when its name suggests a credential. Presence is still
 * reported, because "is it configured?" is the actual question:
 *
 *     "secret": "<set: 64 chars>"
 *     "uri": "mongodb+srv://<redacted>@<host>/<db>"
 *
 * This reads configuration and prints. It changes nothing.
 */

import { config } from '../src/config/index.js'

/** Key names whose values must never be printed. */
const SECRET_KEY = /secret|password|token|credential|privateKey|apiKey|clientSecret/i

/** Key names holding a connection string, which carries credentials inline. */
const URI_KEY = /uri|url|dsn|connectionString/i

/**
 * A connection string with its credentials and host removed.
 *
 * The scheme and database name are kept because they answer real questions —
 * "is this Atlas or local?", "which database?" — without revealing anything
 * that grants access.
 */
function maskUri(value) {
  try {
    const url = new URL(value)

    /*
     * Only a URL that actually carries credentials is masked.
     *
     * An OAuth redirect URI is not a secret, and it is one of the things this
     * command exists to let somebody check before a deployment — masking the
     * host would remove the answer along with the risk.
     */
    if (!url.username && !url.password) return value

    return `${url.protocol}//<redacted>@<host>${url.pathname}`
  } catch {
    // Not a URL — an OAuth redirect path, a base URL fragment, or similar.
    // These are not secret, so they are printed as they are.
    return value
  }
}

function redact(node, key = '') {
  if (node === null || node === undefined) return node

  if (Array.isArray(node)) return node.map((entry) => redact(entry, key))

  if (typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, redact(v, k)]))
  }

  if (typeof node === 'string') {
    if (SECRET_KEY.test(key)) return node.length === 0 ? '<not set>' : `<set: ${node.length} chars>`
    if (URI_KEY.test(key) && /^[a-z+]+:\/\//i.test(node)) return maskUri(node)
  }

  return node
}

console.log(JSON.stringify(redact(config), null, 2))
console.log('\nSecrets are shown as <set: N chars>. Values are never printed.')
