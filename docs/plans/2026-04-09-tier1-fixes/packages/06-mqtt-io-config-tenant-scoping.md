# Package 06: mqtt-io-config-tenant-scoping

## Metadata
Status: PENDING
Estimated Tokens: 28K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: no
Prerequisites: 01-mqtt-device-event-schema-routing
Closing-Findings: [AUTH-HIGH-002]
Source-Reviews:
  - docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md
  - docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Context

The MQTT handler's `getCachedIoConfigs()` method at line 1177 calls `this.dataSource.getRepository(DeviceIoConfig).find({ where: { deviceId, isActive: true } })` without tenant scoping. The `DeviceIoConfig` entity has no `tenantId` column, so the query relies on indirect scoping via `deviceId` (the device is already tenant-validated upstream). While this is not a direct cross-tenant leak, it is fragile: if a `deviceId` collision occurs or the entity is later shared across schemas, the query would return configs from the wrong tenant. This fix should follow package 01 because both modify the same file and 01 establishes the tenant-scoped QueryRunner pattern for MQTT handlers.

## Findings

**AUTH-HIGH-002 [MEDIUM] -- MQTT handler reads DeviceIoConfig without tenant scope**
- Source: auth-security-expert
- File: `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1177`
- Evidence: `this.dataSource.getRepository(DeviceIoConfig).find({ where: { deviceId, isActive: true } })` -- no tenantId column on entity, no request context
- Relies on deviceId indirect scoping
- Risk: fragile if deviceId assumptions change or entity moves to shared schema

## Affected Files
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (73K chars, ~21K tokens)
  - Lines 1170-1182: `getCachedIoConfigs()` method
  - Pattern established by package 01 at lines 1199-1251

## Dependencies
- **01-mqtt-device-event-schema-routing** -- same file. Package 01 establishes the tenant-scoped QueryRunner pattern for MQTT handlers. Package 06 reuses that pattern for the DeviceIoConfig query. Must be committed after 01 to avoid merge conflicts.

## Atomic Commit Plan
```
fix(sensor): scope DeviceIoConfig query to tenant schema in MQTT handler

getCachedIoConfigs() at line 1177 queries DeviceIoConfig without tenant
schema context. In MQTT handler context, AsyncLocalStorage has no tenant
data. The query relies on deviceId indirect scoping, which is fragile.

Fix: Use the same tenant-scoped QueryRunner pattern established in
package 01 to wrap the DeviceIoConfig query with explicit SET
search_path for the tenant schema.

Closes: docs/reviews/auth-security-expert/2026-04-09-getrepository-bypass-validation.md#AUTH-HIGH-002
Plan: docs/plans/2026-04-09-tier1-fixes/packages/06-mqtt-io-config-tenant-scoping.md
```

## Test Plan
- Existing unit tests for `getCachedIoConfigs` must pass
- Add test verifying that `SET search_path` is called with the correct tenant schema before the DeviceIoConfig query
- Verify cache behavior is preserved (cache hit should not trigger a new search_path set)
- Integration: verify MQTT message processing still populates IO configs correctly

## Verification Command
```bash
npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src/ingestion" --coverage=false
```

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
