# Package 01: mqtt-device-event-schema-routing

## Metadata
Status: PENDING
Estimated Tokens: 28K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes (no prerequisites)
Prerequisites: none
Closing-Findings: [AUTH-HIGH-001]
Source-Reviews:
  - docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md
  - docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Context

The MQTT handler `handleEdgeAlarms()` in sensor-service calls `this.dataSource.getRepository(DeviceEvent).save(events)` at line 1246 without tenant schema context. MQTT message handlers run outside HTTP request context, so AsyncLocalStorage has no tenant data and the pool patch defaults to `sensor, public` search_path. Device alarm events may be written to the wrong schema, corrupting tenant data boundaries.

## Findings

**AUTH-HIGH-001 [HIGH] — MQTT handler writes DeviceEvent to wrong schema**
- Source: auth-security-expert
- File: `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1246`
- Evidence: `this.dataSource.getRepository(DeviceEvent).save(events)` in MQTT context -- no AsyncLocalStorage, default search_path = `sensor, public`
- The `tenantId` is available in the handler parameters (passed as argument to `handleEdgeAlarms` at line 1199) but is not used to set search_path before the save
- The file already has a pattern for manual search_path management at lines 1506-1524 (a dedicated QueryRunner with `SET search_path TO "${safeSchemaName}", public`)

## Affected Files
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (73K chars, ~21K tokens)
  - Lines 1199-1251: `handleEdgeAlarms()` method
  - Lines 1506-1524: Existing `withTenantSchemaQueryRunner` pattern to reference
- `libs/backend-common/src/database/tenant-schema.utils.ts` (3K chars, ~1K tokens) -- reference for `withTenantSchema` pattern if available

## Dependencies
None. This package can be executed in parallel with packages 02, 03, 05, and 07.

## Atomic Commit Plan
```
security(sensor): wrap MQTT alarm handler in tenant-scoped schema context

The handleEdgeAlarms() method at line 1246 calls
dataSource.getRepository(DeviceEvent).save() in MQTT handler context
where AsyncLocalStorage has no tenant data. The pool patch defaults to
`sensor, public` search_path, so alarm events may be written to the
source schema instead of the tenant schema.

Fix: Use a dedicated QueryRunner with explicit SET search_path (the
same pattern already used at lines 1506-1524 in this file) to ensure
DeviceEvent.save() targets the correct tenant schema.

Closes: docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md#AUTH-HIGH-001
Plan: docs/plans/2026-04-09-tier1-fixes/packages/01-mqtt-device-event-schema-routing.md
```

## Test Plan
- Existing unit tests for `handleEdgeAlarms` must pass
- Add a test case that verifies `SET search_path` is called with the correct tenant schema before `DeviceEvent.save()`
- Mock the QueryRunner to assert that `queryRunner.query('SET search_path TO ...')` is invoked with the tenantId-derived schema name
- Verify that the `RESET search_path` cleanup runs in the finally block

## Verification Command
```bash
npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src/ingestion" --coverage=false
```
[Dispatch: security-reviewer]

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
