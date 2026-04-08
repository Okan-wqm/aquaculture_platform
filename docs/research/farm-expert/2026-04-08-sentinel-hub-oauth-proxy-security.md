# Research: Sentinel Hub OAuth Token Proxy + GraphQL Hidden Field Security

**Topic:** How to safely integrate Sentinel Hub (satellite imagery) into a multi-tenant SaaS without leaking OAuth tokens or client secrets to the frontend.
**Date:** 2026-04-08
**Agent:** farm-expert

## Sources
- [Sentinel Hub Authentication docs](https://docs.sentinel-hub.com/api/latest/api/overview/authentication/)
- [Copernicus Sentinel Hub Authentication](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Overview/Authentication.html)
- [Sentinel Hub OAuth Credentials — Forum thread](https://forum.sentinel-hub.com/t/oauth-credentials/8180)
- [Copernicus Sentinel Hub Beginners Guide](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/UserGuides/BeginnersGuide.html)
- [GraphQL Best Practices — graphql.org](https://graphql.org/faq/best-practices/)

## Key Findings

1. **Sentinel Hub uses OAuth2 client-credentials flow.** Every API call requires an access token obtained by exchanging `client_id` + `client_secret` at the token endpoint. Tokens expire (typically 1 hour).
2. **The official documentation explicitly warns against using the OAuth client in a frontend application** because the secret would be exposed in client-side code.
3. **Correct pattern: backend proxy.** A backend controller (e.g. `SentinelHubProxyController`) holds the `client_id` / `client_secret`, obtains and caches the access token, and proxies API requests. The frontend calls the proxy, never Sentinel Hub directly.
4. **Token caching** must be tenant-scoped if each tenant has its own Sentinel Hub account. Otherwise one tenant's imagery quota can be consumed by another tenant — a CRITICAL cross-tenant concern.
5. **Client secret storage:** secrets must be encrypted at rest in the database (AES-256-GCM) or loaded from a secrets manager (AWS Secrets Manager, HashiCorp Vault, Kubernetes Secrets). Plaintext client secret in a config file or DB column = CRITICAL.
6. **GraphQL `@HideField()` directive** on `accessToken`, `clientSecret`, or any derived token fields in TypeGraphQL / Nest GraphQL types ensures the field never appears in the schema or in responses — defense-in-depth against accidental exposure via a resolver mistake.
7. **Rate limiting at the proxy** is mandatory because Sentinel Hub enforces per-account quotas. A proxy without rate limiting allows one tenant to exhaust the quota for all tenants.
8. **SSRF risk:** if the proxy forwards user-controlled URLs to Sentinel Hub, validate against an allowlist. Sentinel Hub's own API URLs should be hardcoded server-side, not constructed from user input.

## Security Concerns
- Client secret in frontend code / exposed config = **CRITICAL** — full account takeover.
- Client secret in plaintext DB column = **CRITICAL**.
- Missing `@HideField()` on `accessToken` GraphQL type = **HIGH** — accidental exposure via introspection or resolver.
- Token caching NOT tenant-scoped when tenants have separate accounts = **CRITICAL** — cross-tenant quota exhaustion and data leakage.
- Proxy without rate limiting = **HIGH** — enables DoS via quota exhaustion.
- Proxy forwarding user-controlled URL to Sentinel Hub without allowlist = **HIGH** — SSRF class.
- Token refresh not handling expiry race (concurrent requests trigger multiple refreshes) = **MEDIUM** — minor quota waste, not exploitable.

## Performance Concerns
- Token cache with too-short TTL causes excessive token endpoint hits. Sentinel Hub tokens last ~1 hour; cache for 55 minutes to leave refresh buffer.
- Concurrent refresh deduplication: a single shared promise for in-flight refresh prevents thundering herd.
- Imagery requests are expensive (bandwidth, CPU, quota). Cache by tile identity + time window where appropriate.

## Architectural Implications for farm-expert reviews
- Any reference to Sentinel Hub from frontend code with a direct API URL = CRITICAL.
- Any GraphQL type exposing `accessToken` or `clientSecret` without `@HideField()` = HIGH.
- Any raw client secret in config files, environment variables without secret manager, or plaintext DB columns = CRITICAL.
- Missing token refresh deduplication = MEDIUM.
- Missing tenant-scoped token cache when tenants have separate Sentinel Hub accounts = CRITICAL.
- Missing proxy-level rate limiting = HIGH.

## Domain Rule Additions for farm-expert

Add to `## Domain Rules → Sentinel Hub Security (SEC-C14)` (extend existing section):
- Client secrets MUST be encrypted at rest (AES-256-GCM) OR loaded from a secrets manager. Plaintext secrets in DB / config = CRITICAL.
- Token cache MUST be tenant-scoped when tenants hold separate Sentinel Hub accounts. Global cache across tenants with separate credentials = CRITICAL (cross-tenant quota exhaustion).
- Token refresh MUST be deduplicated (shared in-flight promise). Concurrent refresh without dedup = MEDIUM.
- Proxy endpoints MUST enforce rate limiting per tenant to prevent quota-based DoS between tenants. Missing per-tenant rate limit = HIGH.
- Any user-controlled URL passed through the Sentinel Hub proxy MUST be validated against a strict allowlist (SSRF prevention). Missing allowlist = HIGH.
- `@HideField()` MUST be applied to `accessToken`, `clientSecret`, and any derived token fields in GraphQL types. Missing `@HideField()` = HIGH.
