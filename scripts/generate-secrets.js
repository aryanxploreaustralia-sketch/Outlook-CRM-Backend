#!/usr/bin/env node
/**
 * Generates the cryptographic secrets the authentication subsystem requires.
 *
 * Run with:  npm run generate:secrets
 *
 * Values are printed rather than written automatically, so an existing `.env` is
 * never silently overwritten — replacing TOKEN_ENCRYPTION_KEY makes every stored
 * token cache permanently unreadable, forcing all users to reconnect.
 */

import crypto from 'node:crypto'

/** SESSION_SECRET signs session cookies. 48 bytes comfortably exceeds the 32-char minimum. */
const sessionSecret = crypto.randomBytes(48).toString('base64url')

/** TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256. */
const tokenEncryptionKey = crypto.randomBytes(32).toString('base64')

process.stdout.write(
  [
    '',
    'Generated secrets — copy these into backend/.env',
    '='.repeat(64),
    '',
    `SESSION_SECRET=${sessionSecret}`,
    `TOKEN_ENCRYPTION_KEY=${tokenEncryptionKey}`,
    '',
    '='.repeat(64),
    'Notes:',
    '  - Never commit these. backend/.env is git-ignored.',
    '  - Use different values per environment.',
    '  - Rotating TOKEN_ENCRYPTION_KEY invalidates every stored token cache,',
    '    so all users must reconnect their Microsoft account.',
    '',
  ].join('\n'),
)
