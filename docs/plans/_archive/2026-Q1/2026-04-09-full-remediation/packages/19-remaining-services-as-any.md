# Package 19: remaining-services-as-any

## Metadata
Status: PENDING
Estimated Tokens: 16K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
After farm-service (pkg 17) and sensor-service (pkg 18), the remaining `as any` and `as unknown as` casts are distributed across gateway-api (7 `as unknown as`), auth-service (4 `as any`, 2 `as unknown as`), hr-service (2 `as any`, 2 `as unknown as`), event-store-service (2 `as any`, 1 `as unknown as`), notification-service (2 `as any`, 5 `as unknown as`), and backend-common (3 `as any`, 6 `as unknown as`). These are grouped into a single package because the per-service count is small.

## Findings

**MEDIUM-004 [security-reviewer] (remaining services subset): `as any` in gateway, auth, hr, event-store, notification, backend-common**
- gateway-api: 0 production `as any` (12 in tests only)
- auth-service: 4 production `as any`
- hr-service: 2 production `as any`
- event-store-service: 2 production `as any`
- notification-service: 2 production `as any`
- backend-common: 3 production `as any`

**MEDIUM-016 [multi-tenant-saas-expert] (remaining services subset): `as unknown as` in same services**
- gateway-api: 7 (nats-bridge, redis-io adapter, compression middleware, mock-types)
- auth-service: 2
- hr-service: 2
- event-store-service: 1
- notification-service: 5
- backend-common: 6 (metrics, session-manager)

Closing-Findings: [MEDIUM-004-remaining, MEDIUM-016-remaining]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Affected Files (production code only)
### auth-service
- `/var/aqua-saas/apps/auth-service/src/modules/messaging/services/messaging.service.ts`
- `/var/aqua-saas/apps/auth-service/src/modules/authentication/resolvers/webauthn.resolver.ts`
- `/var/aqua-saas/apps/auth-service/src/modules/authentication/services/webauthn.service.ts`
- `/var/aqua-saas/apps/auth-service/src/privacy/gdpr-compliance.service.ts`

### gateway-api
- `/var/aqua-saas/apps/gateway-api/src/websocket/nats-bridge.service.ts`
- `/var/aqua-saas/apps/gateway-api/src/websocket/adapters/redis-io.adapter.ts`
- `/var/aqua-saas/apps/gateway-api/src/middleware/compression.middleware.ts`

### hr-service, event-store-service, notification-service
- Executor: run `grep -rl "as any\|as unknown as" apps/{hr-service,event-store-service,notification-service}/src/ | grep -v .spec.ts | grep -v .test.ts` to get exact file list

### backend-common
- `/var/aqua-saas/libs/backend-common/src/metrics/metrics.service.ts`
- `/var/aqua-saas/libs/backend-common/src/metrics/metrics.middleware.ts`
- `/var/aqua-saas/libs/backend-common/src/security/session-manager/session-manager.service.ts`

## Dependencies
None.

## Atomic Commit Plan
```
refactor(platform): remove as any and as unknown as from gateway, auth, hr, event-store, notification, backend-common

Clear remaining type-unsafe casts across 6 codebases. Total: ~13
as any and ~23 as unknown as in production code. Each cast bypasses
compile-time type checking.

Plan: docs/plans/2026-04-09-full-remediation/packages/19-remaining-services-as-any.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-016
```

[Dispatch: test-runner] (touches shared lib backend-common)

## Test Plan
- Verify compilation across all affected services
- Run unit tests for each affected service
- Verify zero `as any` / `as unknown as` in production code across all services

## Verification Command
`npx tsc --noEmit -p apps/gateway-api/tsconfig.json && npx tsc --noEmit -p apps/auth-service/tsconfig.json && npx tsc --noEmit -p libs/backend-common/tsconfig.json`
[Dispatch: test-runner]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
