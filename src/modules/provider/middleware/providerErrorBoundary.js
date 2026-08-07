/**
 * Translates provider failures into the application's error envelope.
 *
 * Without it, a `ProviderError` would reach the global handler unrecognised and
 * be reported as a non-operational 500 — hiding an actionable message ("this
 * mailbox has no Exchange licence") behind "an unexpected error occurred".
 *
 * Registered on the provider router only, so nothing outside this module has to
 * know the type exists.
 */

import { ProviderError } from '../constants/providerErrors.js'
import { toApiError } from '../services/provider.service.js'

/** @type {import('express').ErrorRequestHandler} */
export function providerErrorBoundary(error, _req, _res, next) {
  // Handing the translated error onward rather than responding here keeps the
  // application's single response format, and its logging, in one place.
  next(error instanceof ProviderError ? toApiError(error) : error)
}

export default providerErrorBoundary
