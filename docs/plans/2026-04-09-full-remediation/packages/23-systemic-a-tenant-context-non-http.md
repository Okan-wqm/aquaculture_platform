# Package 23: systemic-a-tenant-context-non-http

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: MEDIUM (escalated from pattern recurrence)
Security-Sensitive: yes
Parallelizable: no
Prerequisites: 01-mqtt-device-event-schema-routing, 06-mqtt-io-config-tenant-scoping, 11-feeding-scheduler-getrepository

## Context
Three independent occurrences across 2 agents reveal a systemic gap: AsyncLocalStorage-based tenant context (set by HTTP middleware) is absent in MQTT handlers, cron jobs, and event handlers. Packages 01, 06, and 11 apply targeted fixes to specific call sites. This package creates the platform-level `withTenantContext()` abstraction in `libs/backend-common` that provides a canonical way to establish tenant context in non-HTTP execution paths, preventing future recurrence.

This is Systemic Pattern A from the context-manager consolidation.

## Findings

**Systemic A [context-manager]: Platform-level withTenantContext() for non-HTTP paths**
- Root cause: AsyncLocalStorage-based tenant context set by HTTP middleware absent in MQTT/cron
- 3 confirmed occurrences:
  1. AUTH-HIGH-001: MQTT handler DeviceEvent (sensor-service) — fixed in package 01
  2. AUTH-HIGH-002: MQTT handler DeviceIoConfig (sensor-service) — fixed in package 06
  3. MEDIUM-008: feeding-scheduler cron job (farm-service) — fixed in package 11
- No platform-level abstraction prevents future occurrences
- Remediation: Create `withTenantContext(tenantId, fn)` in libs/backend-common that wraps AsyncLocalStorage.run() with the tenant context, usable from any execution context

Closing-Findings: [SYSTEMIC-A]
Source-Reviews:
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md
- docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md

## Affected Files
- `/var/aqua-saas/libs/backend-common/src/database/tenant-connection-bootstrap.service.ts` (existing AsyncLocalStorage setup)
- `/var/aqua-saas/libs/backend-common/src/context/` (new directory for withTenantContext utility)
- `/var/aqua-saas/apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (refactor to use new abstraction)
- `/var/aqua-saas/apps/farm-service/src/scheduler/feeding-scheduler.service.ts` (refactor to use new abstraction)

## Dependencies
- **01-mqtt-device-event-schema-routing** (MUST complete first — establishes the specific fix pattern)
- **06-mqtt-io-config-tenant-scoping** (MUST complete first — second MQTT fix)
- **11-feeding-scheduler-getrepository** (MUST complete first — cron job migration)

These three packages fix the immediate symptoms. This package extracts the common pattern into a reusable abstraction and refactors the targeted fixes to use it.

## Atomic Commit Plan
```
feat(backend-common): add withTenantContext() for non-HTTP tenant scoping

Create libs/backend-common/src/context/with-tenant-context.ts that
wraps AsyncLocalStorage.run() with tenant context, providing a
canonical way to establish tenant scope in MQTT handlers, cron jobs,
and event handlers.

Refactor the specific fixes from packages 01, 06, 11 to use this
abstraction instead of ad-hoc SET search_path calls. This prevents
future recurrence of the "tenant context absent in non-HTTP paths"
systemic pattern.

Plan: docs/plans/2026-04-09-full-remediation/packages/23-systemic-a-tenant-context-non-http.md

Closes: docs/reviews/context-manager/2026-04-09-tier1-compaction.md#SYSTEMIC-A
```

[Dispatch: security-reviewer] (tenant context is security boundary)
[data-expert review required] (affects tenant isolation across all services)

## Test Plan
- Unit test withTenantContext: verify AsyncLocalStorage propagation
- Integration test: MQTT handler → withTenantContext → getScopedRepository → correct schema
- Integration test: cron job → withTenantContext → correct tenant isolation
- Verify compilation of backend-common, sensor-service, farm-service
- Run full regression

## Verification Command
`npx tsc --noEmit -p libs/backend-common/tsconfig.json && npx jest --testPathPattern="libs/backend-common" --coverage=false`
[Dispatch: test-runner]
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
