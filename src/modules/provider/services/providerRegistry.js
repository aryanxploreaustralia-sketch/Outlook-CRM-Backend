/**
 * Adapter registry and dependency-injection container.
 *
 * The single place that decides which adapter serves a request. Callers ask for
 * "the provider for this mailbox" and get something satisfying `EmailProvider`;
 * they never construct one, and never learn which it is.
 *
 * ## Graceful fallback to the mock
 *
 * When Microsoft credentials are absent, or a mailbox has no Microsoft sign-in
 * behind it, `resolve()` returns `MockEmailProvider` rather than throwing. That
 * is what lets `/provider/*` stay fully functional before Azure is configured —
 * the sync engine, the UI and the tests all exercise real code paths against
 * simulated data instead of every endpoint returning 503.
 *
 * Fallback is always *reported*, never silent: the returned descriptor carries
 * `isMock` and `fallbackReason`, and the API surfaces both. A demo that quietly
 * looked like a live mailbox would be worse than no demo.
 *
 * ## Validation happens at registration
 *
 * Each adapter is checked against the interface when it is registered, so a
 * missing method is a startup failure naming the method — not a `TypeError`
 * thrown midway through a sync against a live mailbox.
 */

import { config } from '../../../config/index.js'
import { assertImplements } from '../interfaces/EmailProvider.js'
import { IMPLEMENTED_PROVIDERS, PROVIDER_TYPES } from '../constants/providerTypes.js'
import { PROVIDER_ERROR_CODES, ProviderError } from '../constants/providerErrors.js'
import { MicrosoftGraphProvider } from '../providers/microsoft/MicrosoftGraphProvider.js'
import { MockEmailProvider } from '../providers/mock/MockEmailProvider.js'
import { getAccessToken } from '../../../services/msal.service.js'
import { createContextLogger } from '../../../utils/logger.js'

const log = createContextLogger('provider-registry')

/** Why a mailbox is being served by the mock instead of a real adapter. */
export const FALLBACK_REASONS = Object.freeze({
  NOT_CONFIGURED: 'microsoft_not_configured',
  NO_LINKED_ACCOUNT: 'no_linked_microsoft_account',
  EXPLICIT: 'explicitly_requested',
  NONE: null,
})

export class ProviderRegistry {
  constructor() {
    /** @type {Map<string, () => import('../interfaces/EmailProvider.js').EmailProvider>} */
    this.factories = new Map()

    this.registerDefaults()
  }

  /**
   * Registers an adapter factory.
   *
   * A factory rather than an instance: adapters hold per-operation state (the
   * mock's in-session overrides, for one), and sharing a single instance across
   * concurrent users would leak one user's state into another's request.
   *
   * @param {string} type
   * @param {() => import('../interfaces/EmailProvider.js').EmailProvider} factory
   */
  register(type, factory) {
    const probe = factory()
    const result = assertImplements(probe)

    if (!result.ok) {
      throw new Error(
        `Provider "${type}" does not satisfy EmailProvider. Missing: ${result.missing.join(', ')}`,
      )
    }

    if (result.unsupported.length > 0) {
      // Not fatal — an adapter may legitimately not support an operation — but
      // worth stating at startup so the gap is a known one.
      log.debug(`Provider "${type}" leaves methods unimplemented`, {
        methods: result.unsupported,
      })
    }

    this.factories.set(type, factory)
    log.debug(`Registered provider "${type}"`)
  }

  /** Registers the adapters that ship with the application. */
  registerDefaults() {
    this.register(
      PROVIDER_TYPES.MICROSOFT_GRAPH,
      () => new MicrosoftGraphProvider({ getAccessToken }),
    )

    this.register(PROVIDER_TYPES.MOCK, () => new MockEmailProvider())
  }

  /** @returns {string[]} */
  get available() {
    return [...this.factories.keys()]
  }

  /**
   * Constructs an adapter by type.
   *
   * @param {string} type
   * @returns {import('../interfaces/EmailProvider.js').EmailProvider}
   */
  create(type) {
    const factory = this.factories.get(type)

    if (!factory) {
      throw new ProviderError(
        PROVIDER_ERROR_CODES.UNSUPPORTED,
        `No adapter is registered for provider "${type}". Available: ${this.available.join(', ')}.`,
        { provider: type },
      )
    }

    return factory()
  }

  /**
   * Decides which adapter should serve a mailbox, applying mock fallback.
   *
   * @param {object} [params]
   * @param {?object} [params.mailbox]
   * @param {boolean} [params.preferMock] Forces the mock regardless of configuration.
   * @returns {{
   *   provider: import('../interfaces/EmailProvider.js').EmailProvider,
   *   type: string,
   *   isMock: boolean,
   *   fallbackReason: ?string,
   * }}
   */
  resolve({ mailbox = null, preferMock = false } = {}) {
    if (preferMock) {
      return this.#mock(FALLBACK_REASONS.EXPLICIT)
    }

    const requested = mailbox?.provider ?? PROVIDER_TYPES.MICROSOFT_GRAPH

    if (requested === PROVIDER_TYPES.MOCK) {
      return this.#mock(FALLBACK_REASONS.EXPLICIT)
    }

    if (requested === PROVIDER_TYPES.MICROSOFT_GRAPH) {
      // No Azure credentials at all — the whole integration is unconfigured.
      if (!config.microsoft.enabled) {
        return this.#mock(FALLBACK_REASONS.NOT_CONFIGURED)
      }

      // Configured, but this mailbox has no OAuth grant to authenticate with.
      if (mailbox && !mailbox.sourceAccount) {
        return this.#mock(FALLBACK_REASONS.NO_LINKED_ACCOUNT)
      }

      return {
        provider: this.create(PROVIDER_TYPES.MICROSOFT_GRAPH),
        type: PROVIDER_TYPES.MICROSOFT_GRAPH,
        isMock: false,
        fallbackReason: FALLBACK_REASONS.NONE,
      }
    }

    // A provider named in the type list but with no adapter yet — Gmail, SMTP,
    // IMAP, SendGrid. Reported honestly rather than silently mocked, because
    // this is a configuration mistake and not a missing credential.
    if (!IMPLEMENTED_PROVIDERS.includes(requested)) {
      throw new ProviderError(
        PROVIDER_ERROR_CODES.UNSUPPORTED,
        `Provider "${requested}" is declared but has no adapter yet.`,
        { provider: requested },
      )
    }

    return {
      provider: this.create(requested),
      type: requested,
      isMock: false,
      fallbackReason: FALLBACK_REASONS.NONE,
    }
  }

  #mock(reason) {
    return {
      provider: this.create(PROVIDER_TYPES.MOCK),
      type: PROVIDER_TYPES.MOCK,
      isMock: true,
      fallbackReason: reason,
    }
  }

  /**
   * Whether the application would currently fall back to the mock.
   *
   * Read by `/provider/status` so the UI can display a "simulated data" banner
   * without first attempting a sync.
   */
  get isMockMode() {
    return !config.microsoft.enabled
  }
}

/** Shared registry. Factories are stateless; the adapters they build are not. */
export const providerRegistry = new ProviderRegistry()

export default providerRegistry
