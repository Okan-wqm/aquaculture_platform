# Package 03: sensor-mqtt-any-types

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 20K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [SENSOR-HIGH-005]
Source-Reviews:
  - docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md

## Context
The MQTT listener hot path uses `any` types at 4 locations, including deviceCache, getCachedDevice return type, and IoTag value field. This is the 3rd audit cycle this finding has appeared unfixed (SYSTEMIC-S2-002). Infinity/-Infinity values pass isNaN() and corrupt TimescaleDB aggregates. The any types silence TypeScript checks on the security-critical tenant validation path.

## Findings

**SENSOR-HIGH-005** (sensor-expert, HIGH)
File: apps/sensor-service/src/ingestion/mqtt-listener.service.ts (lines 134, 1047, 1060, 1149)
4 `any` usages in MQTT listener: (1) deviceCache Map<string, {device: any}>, (2-3) tags Record<string,{value: any}>, (4) getCachedDevice returns Promise<any|null>. Infinity/-Infinity strings pass Number() and isNaN() checks, corrupting TimescaleDB continuous aggregates. 3rd unfixed audit cycle -- SYSTEMIC.

## Affected Files
- apps/sensor-service/src/ingestion/mqtt-listener.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(sensor): type MQTT listener deviceCache and IoTag values, reject Infinity

The MQTT listener uses `any` at 4 locations in the hot path: deviceCache,
getCachedDevice return, and IoTag value fields. This silences TypeScript
on the tenant validation path and allows Infinity/-Infinity strings to
persist into TimescaleDB, corrupting continuous aggregates. 3rd unfixed
audit cycle.

Import EdgeDevice entity, define IoTagData interface, type getCachedDevice
return as Promise<EdgeDevice|null>, add isFinite() guard before persistence.

Plan: docs/plans/2026-04-09-high-fixes/packages/03-sensor-mqtt-any-types.md
Closes: docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md#HIGH-S2-005
```

## Test Plan
- Unit test: Infinity string value is filtered out (not persisted)
- Unit test: -Infinity string value is filtered out
- Unit test: Normal numeric values persist correctly
- Verify TypeScript compilation catches any remaining any-typed access

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src/ingestion" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
