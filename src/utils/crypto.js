/**
 * Cryptographic helpers for secrets held at rest.
 *
 * OAuth refresh tokens are long-lived credentials: anyone holding one can mint
 * access tokens and read or send a user's mail until it is revoked. A database
 * dump must therefore not be enough to impersonate a user, so the entire MSAL
 * token cache is encrypted before it is written.
 *
 * AES-256-GCM is used rather than CBC because it is *authenticated*: decryption
 * fails loudly if the ciphertext was altered, instead of silently returning
 * corrupted plaintext.
 *
 * Stored format: `v1.<iv>.<authTag>.<ciphertext>`, each part base64url.
 * The version prefix exists so a future key rotation can recognise and migrate
 * older records rather than guessing at the layout.
 */

import crypto from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12 // 96 bits, the size GCM is specified for.
const VERSION = 'v1'

/**
 * Decodes and validates the configured encryption key.
 *
 * Kept as a function rather than a module-level constant so a missing key only
 * fails when encryption is actually used, letting the API boot without auth
 * configured during early development.
 *
 * @param {string} rawKey Base64-encoded 32-byte key.
 * @returns {Buffer}
 */
function resolveKey(rawKey) {
  if (!rawKey) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not configured. Generate one with: npm run generate:secrets',
    )
  }

  const key = Buffer.from(rawKey, 'base64')

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate a valid key with: npm run generate:secrets',
    )
  }

  return key
}

/**
 * Encrypts a UTF-8 string.
 *
 * @param {string} plaintext
 * @param {string} rawKey Base64-encoded 32-byte key.
 * @returns {string} Serialised ciphertext.
 */
export function encryptSecret(plaintext, rawKey) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptSecret expects a string.')
  }

  const key = resolveKey(rawKey)

  // A fresh random IV per encryption is mandatory for GCM. Reusing an IV with
  // the same key catastrophically breaks the cipher's confidentiality.
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [
    VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

/**
 * Decrypts a value produced by `encryptSecret`.
 *
 * Throws when the payload is malformed, the key is wrong, or the ciphertext was
 * tampered with — all three are security-relevant and must never be swallowed.
 *
 * @param {string} payload
 * @param {string} rawKey Base64-encoded 32-byte key.
 * @returns {string}
 */
export function decryptSecret(payload, rawKey) {
  if (typeof payload !== 'string') {
    throw new TypeError('decryptSecret expects a string.')
  }

  const parts = payload.split('.')

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Encrypted payload is malformed or uses an unsupported version.')
  }

  const [, ivPart, tagPart, dataPart] = parts
  const key = resolveKey(rawKey)

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))

  // `final()` throws if the auth tag does not verify.
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * The challenge travels to Microsoft; the verifier never leaves this server and
 * is replayed only at the token exchange. That is what makes an intercepted
 * authorization code useless on its own.
 *
 * Extracted here in Phase 14.8B. Two byte-identical private copies existed —
 * one in `services/auth.service.js`, one in
 * `modules/provider/services/mailboxConnect.service.js` — and a third was about
 * to be written for administrator sign-in. Three copies of a security primitive
 * is three places for one of them to quietly drift to a weaker parameter.
 *
 * @returns {{ codeVerifier: string, codeChallenge: string }}
 */
export function createPkcePair() {
  // RFC 7636 allows 43-128 characters; 32 random bytes base64url-encoded gives 43.
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')

  return { codeVerifier, codeChallenge }
}

/**
 * Generates a cryptographically random, URL-safe opaque token.
 *
 * Used for session identifiers and OAuth `state` values, both of which must be
 * unguessable.
 *
 * @param {number} [bytes]
 * @returns {string}
 */
export function generateOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

/**
 * Hashes a token for storage using SHA-256.
 *
 * Session identifiers are stored hashed for the same reason passwords are: a
 * leaked database should not hand an attacker usable session cookies. SHA-256
 * without a salt is correct here — unlike a password, the input is already
 * high-entropy random, so rainbow tables are not a threat.
 *
 * @param {string} token
 * @returns {string} Hex digest.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Compares two strings in constant time.
 *
 * A naive `===` leaks information through timing, allowing an attacker to
 * recover a secret one character at a time.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeCompare(a, b) {
  const bufferA = Buffer.from(String(a))
  const bufferB = Buffer.from(String(b))

  // `timingSafeEqual` throws on length mismatch, which would itself leak length.
  if (bufferA.length !== bufferB.length) return false

  return crypto.timingSafeEqual(bufferA, bufferB)
}

export default {
  encryptSecret,
  decryptSecret,
  createPkcePair,
  generateOpaqueToken,
  hashToken,
  safeCompare,
}
