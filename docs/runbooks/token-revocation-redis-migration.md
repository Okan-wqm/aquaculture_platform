# Token Revocation Redis Migration Runbook

Canonical revocation keys:

- `token:blacklist:<jti>`
- `token:blacklist:user:<userId>`
- `token:blacklist:tenant:<tenantId>`

Gateway and auth-service read and write only canonical keys. Legacy gateway/user blacklist prefixes are not part of the active revocation path.

## Verification

1. Suspend a tenant.
2. Confirm `token:blacklist:tenant:<tenantId>` exists with a `blacklistedAt` timestamp.
3. Reuse a token issued before suspension against HTTP and WebSocket gateway paths.
4. Confirm both paths reject the token.

SSoT checks:

1. `tests/invariants/token-blacklist-ssot.spec.ts` passes.
2. HTTP, GraphQL, and WebSocket replay checks reject tokens issued before tenant/user revocation.
3. No code path writes or reads retired gateway-prefixed or user-level legacy revocation prefixes.

Production auth-service and gateway must fail boot when Redis revocation storage is unavailable.

## Rollback

Rollback must preserve canonical keys. Do not reintroduce legacy prefixes; redeploy the last known-good gateway/auth-service pair that reads `token:blacklist:*`.
