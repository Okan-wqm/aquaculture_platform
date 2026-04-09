# Package 10: data-layer-event-contracts

## Metadata
Status: PENDING
Estimated Tokens: 20K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [DATA-MEDIUM-006, DATA-MEDIUM-007, DATA-MEDIUM-008, DATA-MEDIUM-009, DATA-MEDIUM-011]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/data-expert/2026-04-05-s2-high-findings.md

## Context
Five data-layer findings concern event contract violations: missing fields, incorrect types, schema evolution gaps, and upcaster registration. These all touch `libs/event-contracts/src/` and the associated publishers. Grouped as one package because event contract changes must be atomic — changing a contract and its publishers/consumers in separate commits creates a window of incompatibility.

## Findings

**DATA-MEDIUM-006 — Event missing aggregateId on 4 event types**
`BatchStatusChangedEvent`, `SensorCalibrationEvent`, `AlertEscalatedEvent`, and `TenantModuleDeactivatedEvent` lack `aggregateId`. BaseEvent requires it for event-sourced replay. Add `aggregateId` to these event interfaces and populate in publishers.

**DATA-MEDIUM-007 — Event version not bumped on schema changes**
Several events have had fields added/removed but `version` remains `1`. Without version bumps, consumers cannot distinguish schema vintages. Bump affected events to `version: 2` and register upcasters for v1->v2.

**DATA-MEDIUM-008 — Upcaster registry has zero registered upcasters**
`EventUpcasterRegistry` exists in `libs/event-contracts/` but no upcasters are registered. The registry is dead code. Register upcasters for all events that have undergone schema changes.

**DATA-MEDIUM-009 — StorageQuotaExceededEvent uses nested metadata object**
`StorageQuotaExceededEvent` contains a `metadata: { quotaBytes, usedBytes, threshold }` nested object, violating the flat-object contract mandated by CLAUDE.md. Flatten to top-level fields.

**DATA-MEDIUM-011 — Event timestamp declared as Date but serialized as string**
Multiple events declare `timestamp: Date` in TypeScript interfaces but JSONB serialization converts to ISO 8601 string. The contract lies about the wire type. Declare as `timestamp: string` (ISO 8601 format), bump version, register upcaster.

## Affected Files
- libs/event-contracts/src/base-event.ts
- libs/event-contracts/src/farm-events.ts
- libs/event-contracts/src/sensor-events.ts
- libs/event-contracts/src/alert-events.ts
- libs/event-contracts/src/tenant-events.ts
- libs/event-contracts/src/storage-events.ts
- libs/event-contracts/src/upcasters/ (new or existing directory)
- apps/farm-service/src/batch/handlers/ (publishers of affected events)
- apps/sensor-service/src/ (publishers of affected events)
- apps/alert-engine/src/ (publishers of affected events)

## Dependencies
None upstream. However, downstream consumers of these events (all services that subscribe) must be aware of the version bump. The BREAKING CHANGE footer signals this.

## Atomic Commit Plan
```
fix(event-contracts): add missing aggregateId, bump versions, register upcasters, flatten StorageQuotaExceeded, fix timestamp type

Five event contract integrity fixes:
- Add aggregateId to BatchStatusChanged, SensorCalibration, AlertEscalated, TenantModuleDeactivated
- Bump affected events to version 2; register v1->v2 upcasters in EventUpcasterRegistry
- Flatten StorageQuotaExceededEvent metadata to top-level fields
- Change timestamp type from Date to string (ISO 8601) in BaseEvent and all descendants

BREAKING CHANGE: BaseEvent.timestamp type changes from Date to string.
StorageQuotaExceededEvent.metadata removed; fields promoted to top level.
Four events gain required aggregateId field.
data-expert review required

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-006
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-007
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-008
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-009
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-MEDIUM-011
Plan: docs/plans/2026-04-09-medium-fixes/packages/10-data-layer-event-contracts.md
```

## Test Plan
- Unit test: all event interfaces include aggregateId as required string
- Unit test: EventUpcasterRegistry has registered upcasters for all v1 events
- Unit test: v1 event upcast to v2 produces correct shape
- Unit test: StorageQuotaExceededEvent has no nested objects
- Unit test: BaseEvent.timestamp is string type, createBaseEvent() returns ISO 8601 string
- Type-check: `npx tsc --noEmit` catches all consumers using Date where string is now required

## Verification Command
`npx tsc --noEmit -p libs/event-contracts/tsconfig.json && npx jest --testPathPattern="libs/event-contracts" --coverage=false`
[Dispatch: test-runner]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
