# Package 04b: internal-http-callsite-rollout

## Metadata
Status: IN_PROGRESS
Estimated Tokens: 10K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: no (requires P04a)
Prerequisites: 04a-internal-http-signing-lib
Closing-Findings: [HIGH-003]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md (scope extension finding #8)

## Context
P04a introduced the `signedFetch` helper and bound `tenantId` into the HMAC. P04b migrates existing internal-HTTP callsites to use it, replacing the older "plaintext X-Internal-Service-Secret header" pattern in gateway-api's tenant lookup and the unsigned proxy calls to sensor-service.

## Affected Files
- /var/aqua-saas/apps/gateway-api/src/services/tenant-lookup.service.ts (migrate from X-Internal-Service-Secret plaintext to signedFetch)
- /var/aqua-saas/apps/gateway-api/src/routes/v1/sensor.routes.ts (4 fetch() calls → signedFetch with tenant-bound HMAC)

## Remaining internal-HTTP callsites (follow-up sweep)
Not in this package — tracked for future P04c sweep:
- apps/gateway-api/src/proxy/service-proxy.service.ts
- apps/gateway-api/src/proxy/load-balancer.service.ts (health probes only)
- apps/gateway-api/src/health/health.service.ts (health probes only)
- apps/gateway-api/src/services/http-pool.service.ts
- apps/admin-api-service/src/metrics/system-metrics.service.ts
- apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts

## Atomic Commit Plan

```
security(gateway): migrate internal fetch calls to signedFetch with tenantId

Two callsites were still using the older internal-auth patterns:
1. tenant-lookup.service.ts passed INTERNAL_SERVICE_SECRET in plaintext via
   X-Internal-Service-Secret header. The service itself logged a
   SECURITY WARNING about the plaintext secret being spoofable.
2. sensor.routes.ts proxied user requests to sensor-service via raw fetch
   with an untrusted X-Tenant-Id header. Any caller that reached the REST
   proxy could forward a spoofed tenant.

Migrating both to signedFetch:
- tenant-lookup: HMAC-signed identity + tenantId-bound signature. Removed
  the plaintext X-Internal-Service-Secret header path entirely. Startup
  warning kept; the call-site now hard-fails if the secret is missing.
- sensor.routes: 3 REST proxy endpoints (mqtt/status, firmware upload,
  data export) now sign with resolveTenantId() extracted from the
  incoming request. Health check endpoint left as plain fetch — unauth
  health checks do not benefit from HMAC.

Closes: docs/security/2026-04-12-hardening-gap-report.md#HIGH-003
```

## Test Plan
- Scoped tsc clean via nx/app tsconfig (deferred — sandbox lacks configured tsc, but imports match existing patterns)
- Integration: gateway → sensor-service proxy call should carry X-Service-Identity + X-Service-Timestamp + X-Service-Signature headers with tenant-bound HMAC

## Verification Command
Manual: boot gateway-api in dev, hit `/api/v1/sensors/health`, confirm request to sensor-service carries signed headers

## Rollback Plan
`git revert {commit_hash} --no-edit`

## Failure Notes
_(empty at plan creation)_
