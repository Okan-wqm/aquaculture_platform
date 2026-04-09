# Package 14: platform-remaining-high

## Metadata
Status: PENDING
Estimated Tokens: 28K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [PLAT-HIGH-007, PLAT-HIGH-008, PLAT-HIGH-009, PLAT-HIGH-010, PLAT-HIGH-011, PLAT-HIGH-012]
Source-Reviews:
  - docs/reviews/platform-services/2026-04-05-s2-high-findings.md

## Context
Remaining platform-services HIGH findings: (1) event-store guard never applied, (2) config getAll() returns decrypted secrets in bulk, (3) hydroponics MODULE_USER can delete any config, (4) notification retry no jitter, (5) security events log raw PII, (6) unbounded type label, traceId not W3C hex, health check DB-only, PID pH bounds too wide. Grouped by platform services scope.

## Findings

**PLAT-HIGH-007** (platform-services, HIGH)
File: apps/notification-service/src/notification/services/notification-dispatcher.service.ts
Notification retry backoff has no jitter. All failed notifications retry simultaneously causing downstream webhook endpoint overload.

**PLAT-HIGH-008** (platform-services, HIGH)
File: apps/event-store-service/src/guards/internal-api-key.guard.ts
InternalApiKeyGuard defined but never registered as APP_GUARD or applied to any controller. All event-store endpoints are unguarded when INTERNAL_API_KEY is not set.

**PLAT-HIGH-009** (platform-services, HIGH)
File: apps/config-service/src/configuration/services/configuration.service.ts (lines 89-133)
getAll() returns decrypted secret values in bulk. Any internal service calling getAll() that logs, caches in Redis, or includes in error response leaks secrets.

**PLAT-HIGH-010** (platform-services, HIGH)
Security audit events log raw PII (email, IP, user agent) without masking. Structured logging requirement per CLAUDE.md: PII must be hashed or masked.

**PLAT-HIGH-011** (platform-services, HIGH)
File: apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts (lines 144-154)
MODULE_USER role permits deletion of any HydroponicsConfig within tenant. No ownership validation -- any module user can destroy configs created by administrators.

**PLAT-HIGH-012** (platform-services, HIGH)
Observability gaps: traceId not W3C trace-context hex format, unbounded type labels on metrics, health check is DB-only (no NATS/Redis), PID controller pH bounds too wide (allows 0-14 full range when aquaculture requires 6.0-9.0).

## Affected Files
- apps/notification-service/src/notification/services/notification-dispatcher.service.ts
- apps/event-store-service/src/guards/internal-api-key.guard.ts
- apps/event-store-service/src/app.module.ts
- apps/config-service/src/configuration/services/configuration.service.ts
- apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts
- apps/observability-service/src/ (traceId, health check)
- apps/alert-engine/src/ (PID pH bounds)

## Dependencies
PLAT-HIGH-008 (event-store guard) overlaps with the tier1-fixes plan package 02-event-store-tenant-auth. If package 02 is already committed, this package only adds the APP_GUARD registration. Otherwise this package covers the full fix.

## Atomic Commit Plan
```
security(platform): register event-store guard, mask secrets in getAll, add retry jitter, mask PII

InternalApiKeyGuard is defined but never applied. getAll() returns decrypted
secrets in bulk. Notification retry has no jitter. Security events log raw PII.
MODULE_USER can delete any hydroponics config. pH bounds too wide for aquaculture.

Register InternalApiKeyGuard as APP_GUARD. Return [ENCRYPTED] for secrets in
getAll(). Add exponential backoff with jitter to notification retries. Hash PII
in security audit events. Add createdBy ownership check to hydroponics delete.
Narrow PID pH bounds to 6.0-9.0.

Plan: docs/plans/2026-04-09-high-fixes/packages/14-platform-remaining-high.md
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#H-03
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#H-07
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#H-05
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#PLAT-HIGH-010
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#PLAT-HIGH-011
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#PLAT-HIGH-012
```

## Test Plan
- Unit test: event-store endpoints return 401 without API key
- Unit test: getAll() returns [ENCRYPTED] for isSecret=true configs
- Unit test: notification retry includes jitter component
- Unit test: security audit log entry has PII hashed
- Unit test: hydroponics delete rejects non-owner MODULE_USER
- Unit test: PID controller rejects pH setpoint outside 6.0-9.0

## Verification Command
`npx tsc --noEmit -p apps/event-store-service/tsconfig.json && npx tsc --noEmit -p apps/config-service/tsconfig.json && npx tsc --noEmit -p apps/notification-service/tsconfig.json && npx jest --testPathPattern="apps/(event-store|config|notification|hydroponics)-service" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
