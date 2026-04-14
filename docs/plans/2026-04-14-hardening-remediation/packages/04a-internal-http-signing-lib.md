# Package 04a: internal-http-signing-lib

## Metadata
Status: IN_PROGRESS
Estimated Tokens: 9K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes (tier 0)
Prerequisites: none
Closing-Findings: [HIGH-003]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md (scope extension finding #8)

## Context
The platform already signs inter-service HTTP with HMAC via `ServiceIdentityGuard` and `generateServiceIdentityHeaders()`. But the signature covered only `timestamp:serviceName`. The forwarded `X-Tenant-ID` header was not cryptographically bound to the signature, so a compromised service with a valid HMAC secret could forward a request with a spoofed tenant and pass verification. P04a binds tenantId into the HMAC, closes the spoofing window, and adds a reusable `signedFetch` helper that makes correct usage the easiest path.

## Findings
**HIGH-003** (2026-04-14 gap scan, finding #8):
> Service-to-service HTTP unsigned — INTERNAL_SERVICE_SECRET guard exists but internal HTTP calls have no HMAC signing; tenant propagation via untrusted `X-Tenant-ID` header.

Refinement on investigation: service identity IS signed; the gap is tenant binding, not the presence of signing.

## Affected Files
- /var/aqua-saas/libs/backend-common/src/utils/service-identity.util.ts (bind tenantId)
- /var/aqua-saas/libs/backend-common/src/guards/service-identity.guard.ts (verify with tenantId)
- /var/aqua-saas/libs/backend-common/src/http/signed-http-client.ts (NEW)
- /var/aqua-saas/libs/backend-common/src/index.ts (export)
- /var/aqua-saas/apps/gateway-api/src/app.module.ts (pass tenantId on gateway→subgraph calls)
- /var/aqua-saas/apps/notification-service/src/notification/event-handlers/auth-event.handler.ts (pass tenantId on 3 fetch sites)
- /var/aqua-saas/apps/event-store-service/src/guards/internal-api-key.guard.ts (bind tenantId in local verify)

## Atomic Commit Plan

```
security(internal-http): bind tenantId into HMAC, add signedFetch helper

ServiceIdentityGuard already verified HMAC on inter-service HTTP, but the
signature covered only timestamp:serviceName — not the X-Tenant-ID header
the gateway forwards to subgraphs. A compromised caller with a valid
INTERNAL_SERVICE_SECRET could forward a signed request with a spoofed
tenant and pass verification. This commit binds tenantId into the HMAC
so any tamper of X-Tenant-ID after signing fails verification.

- service-identity.util.ts: HMAC input is now timestamp:serviceName:tenantId.
  tenantId defaults to empty string for backwards compatibility on non-
  tenant-scoped paths.
- service-identity.guard.ts: reads x-tenant-id from the request and passes
  it as the tenantId argument to verifyServiceIdentity.
- signed-http-client.ts (NEW): signedFetch + buildSignedInternalHeaders
  helpers. INTERNAL_SERVICE_SECRET is required at call time — hard-fail
  prevents silent unsigned fallbacks. Intended migration target for raw
  fetch() calls in P04b.
- gateway-api: willSendRequest now passes the resolved tenant UUID into
  generateServiceIdentityHeaders. Tenant validation (uuidRegex) already
  filters non-UUID strings; pass empty string when no valid tenant.
- notification-service auth-event handler: 3 fetch sites now pass
  tenantId into generateServiceIdentityHeaders — matches the x-tenant-id
  header already being sent.
- event-store-service internal-api-key.guard: local verifyServiceIdentity
  extended to accept tenantId; binds x-tenant-id header into verification.

Backwards compatible: callers that already passed no tenantId continue
to sign with empty string. Only callsites that previously forwarded
x-tenant-id needed updating — they now bind the same value into the HMAC.

Closes: docs/security/2026-04-12-hardening-gap-report.md#HIGH-003
```

## Test Plan
- Scoped tsc on the changed lib files (clean)
- No existing specs for service-identity utilities to break
- Integration test (manual): `generateServiceIdentityHeaders('svc', secret, 'tenant-a')` + `verifyServiceIdentity('svc', ts, sig, secret, 'tenant-a')` returns true; same verify with 'tenant-b' returns false

## Verification Command
scoped tsc on the two library files

## Rollback Plan
`git revert {commit_hash} --no-edit`
Restores pre-binding HMAC. Gateway→subgraph continues to work because the signature domain is unchanged when tenantId is empty and the guard is reverted.

## Failure Notes
_(empty at plan creation)_
