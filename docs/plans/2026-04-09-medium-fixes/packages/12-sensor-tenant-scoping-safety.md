# Package 12: sensor-tenant-scoping-safety

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [SENSOR-MEDIUM-001, SENSOR-MEDIUM-002, SENSOR-MEDIUM-003, SENSOR-MEDIUM-004, SENSOR-MEDIUM-005]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/sensor-expert/2026-04-05-s2-high-findings.md

## Context
Five sensor domain findings cover tenant isolation in caching, logging security, sentinel values, unqualified table names, and missing safety checks in VFD automation. All files are within `apps/sensor-service/src/`. Grouped for file locality and shared bounded context.

## Findings

**SENSOR-MEDIUM-001 — Cache key not tenant-scoped**
Sensor data cache uses keys like `sensor:{sensorId}:latest` without the tenant prefix. In a multi-tenant deployment, two tenants with sensors that happen to share an ID (e.g., after data migration) would see each other's cached readings. Prefix all cache keys with `tenant:{tenantId}:`.

**SENSOR-MEDIUM-002 — console.warn used for security-relevant logging**
`console.warn` is used in the credential transformer and MQTT authentication paths. Per CLAUDE.md, this must use NestJS `Logger` for structured logging with tenant/request context. `console.warn` also bypasses log aggregation.

**SENSOR-MEDIUM-003 — tenantId: 'system' used as sentinel value**
Several sensor service paths use the string literal `'system'` as a tenantId for system-level operations (calibration defaults, global thresholds). This is fragile — if a tenant named 'system' is created, their data collides. Use a UUID constant (e.g., `SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000'`) or a dedicated `isSystemContext: boolean` flag.

**SENSOR-MEDIUM-004 — Unqualified table name in raw SQL query**
A raw SQL query in the sensor service uses `SELECT ... FROM sensor_reading` without schema qualification. In a multi-tenant schema-per-tenant deployment, this relies on `search_path` being correctly set. Qualify as `{schema}.sensor_reading` or use the ORM's schema-aware query builder.

**SENSOR-MEDIUM-005 — VFD automation rule execution has no risk tier check**
VFD (Variable Frequency Drive) automation rules can change motor speed without checking the current risk tier. If the system is in a `HIGH_RISK` state (e.g., low dissolved oxygen), the automation should be blocked or require explicit override. This is a life-safety concern.

## Affected Files
- apps/sensor-service/src/ingestion/sensor-cache.service.ts (or equivalent)
- apps/sensor-service/src/infrastructure/vault/credential.transformer.ts
- apps/sensor-service/src/automation/automation.service.ts
- apps/sensor-service/src/vfd-programming/ (VFD automation rule execution)
- apps/sensor-service/src/ (raw SQL queries)

## Dependencies
None. Sensor service is self-contained.

## Atomic Commit Plan
```
fix(sensor): scope cache keys to tenant, replace console.warn, eliminate 'system' sentinel, qualify table names, add VFD risk tier check

Five sensor domain fixes:
- Prefix all cache keys with tenant:{tenantId}: for multi-tenant isolation
- Replace console.warn with NestJS Logger in credential transformer and MQTT auth
- Replace tenantId:'system' sentinel with UUID constant SYSTEM_TENANT_ID
- Qualify raw SQL table references with schema name
- Block VFD automation execution in HIGH_RISK state without explicit override

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#SENSOR-MEDIUM-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#SENSOR-MEDIUM-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#SENSOR-MEDIUM-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#SENSOR-MEDIUM-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#SENSOR-MEDIUM-005
Plan: docs/plans/2026-04-09-medium-fixes/packages/12-sensor-tenant-scoping-safety.md
```

## Test Plan
- Unit test: cache key includes tenant prefix
- Unit test: no console.warn calls in sensor-service (grep/lint)
- Unit test: SYSTEM_TENANT_ID is a UUID constant, not string literal 'system'
- Unit test: raw SQL queries include schema qualification
- Unit test: VFD automation blocked when risk tier is HIGH_RISK
- Unit test: VFD automation proceeds when risk tier is NORMAL with explicit override

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
