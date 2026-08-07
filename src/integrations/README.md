# src/integrations

Clients for third-party services, one folder per provider.

Microsoft Graph and the Microsoft identity platform (OAuth) live here in a later
phase. Isolating them behind an internal interface keeps provider-specific
details — token refresh, throttling, pagination — out of the services that use
them, and makes the provider mockable in tests.
