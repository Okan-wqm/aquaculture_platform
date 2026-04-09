# Package 04: data-messaging-infra

## Metadata
Status: PENDING
Estimated Tokens: 14K
Priority: LOW
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
Five LOW findings across data infrastructure: upcaster test edge cases missing in event-contracts, outbox bigint typed as string in documentation, a positive finding for migrations using IF NOT EXISTS (document as best practice), bypass RLS service uses main DataSource (document the architectural choice), and messaging partition manager missing DEFAULT partition prevention. These are all documentation, test coverage, and defensive coding improvements.

## Findings

**DATA-LOW-010: upcaster test edge cases**
- Source agent: data-expert
- Severity: LOW
- Files: `libs/event-contracts/src/upcasters/__tests__/upcasters.spec.ts`, `libs/event-contracts/src/upcasters/event-upcaster.ts`, `libs/event-contracts/src/upcasters/alert-triggered.upcaster.ts`, `libs/event-contracts/src/upcasters/sensor-reading.upcaster.ts`
- Description: Upcaster tests cover the happy path but lack edge cases: what happens when an event has an unexpected version number, when required fields are missing after upcasting, or when the upcaster chain is applied to an already-current-version event. Add edge case tests for robustness.

**DATA-LOW-014: outbox bigint typed as string docs**
- Source agent: data-expert
- Severity: LOW
- Files: Outbox-related entities and documentation
- Description: PostgreSQL `bigint` columns in the outbox table are typed as `string` in TypeScript entities (standard TypeORM practice since JS `number` cannot safely represent bigint > 2^53). However, this choice is not documented. Add a `// WHY:` comment explaining the string typing for bigint columns.

**DATA-LOW-019: positive finding -- migrations use IF NOT EXISTS**
- Source agent: data-expert
- Severity: LOW (positive)
- Files: `database/migrations/modules/farm/V005__add_feeder_calibrations.sql`, `database/migrations/modules/hydroponics/V001__hydroponics_initial_schema.sql`, `database/migrations/core/V006__add_tenant_tracking_columns.sql`, `database/migrations/core/V008__add_fingerprint_machineid_index.sql`
- Description: Positive finding -- existing migrations correctly use `IF NOT EXISTS` for idempotency. No code change needed. Acknowledge and close. If a documentation standard exists for migration best practices, reference this pattern there.

**DATA-LOW-025: bypass RLS uses main DataSource**
- Source agent: data-expert
- Severity: LOW
- File: `libs/backend-common/src/database/rls/bypass-rls.service.ts`
- Description: `BypassRlsService.withBypass()` uses AsyncLocalStorage to set `bypassRls: true` in the request context, which is then read by `RlsConnectionBootstrap` on connection checkout. This uses the main DataSource (not a separate admin DataSource). The current design is actually correct -- bypass is scoped per-callback via AsyncLocalStorage, not per-connection. Document this architectural choice with a `// WHY:` comment explaining why a separate DataSource is unnecessary.

**MSG-LOW-014: no DEFAULT partition prevention**
- Source agent: messaging-expert
- Severity: LOW
- File: `apps/messaging-service/src/partition/partition-queries.ts`, `apps/messaging-service/src/partition/partition-manager.service.ts`
- Description: The partition manager creates monthly partitions but does not create or explicitly prevent a DEFAULT partition. Without a DEFAULT partition, inserts with timestamps outside any defined partition range will fail with a PostgreSQL error. This is actually safe behavior (fail-fast rather than silently routing to a catch-all), but should be documented. Add a `// WHY: no DEFAULT partition -- fail-fast on out-of-range timestamps` comment.

Closing-Findings: [DATA-LOW-010, DATA-LOW-014, DATA-LOW-019, DATA-LOW-025, MSG-LOW-014]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Affected Files
- `/var/aqua-saas/libs/event-contracts/src/upcasters/__tests__/upcasters.spec.ts`
- `/var/aqua-saas/libs/event-contracts/src/upcasters/event-upcaster.ts`
- `/var/aqua-saas/libs/event-contracts/src/upcasters/alert-triggered.upcaster.ts`
- `/var/aqua-saas/libs/event-contracts/src/upcasters/sensor-reading.upcaster.ts`
- `/var/aqua-saas/libs/backend-common/src/database/rls/bypass-rls.service.ts`
- `/var/aqua-saas/apps/messaging-service/src/partition/partition-queries.ts`
- `/var/aqua-saas/apps/messaging-service/src/partition/partition-manager.service.ts`

## Dependencies
None. All findings are documentation, test coverage, or defensive coding.

Note: This package touches `libs/event-contracts` (upcaster tests) and `libs/backend-common` (bypass-rls docs). Since changes are limited to comments and test additions (no interface/export changes), downstream consumers are not affected.

## Atomic Commit Plan
```
chore(event-contracts,backend-common,messaging): address 5 LOW data infra findings

Add documentation and test coverage for data infrastructure:
- Add edge case tests for event upcasters (unexpected version, missing fields)
- Document bigint-as-string typing choice in outbox entities
- Acknowledge IF NOT EXISTS migration pattern as best practice (no change)
- Document BypassRlsService AsyncLocalStorage design choice
- Document no-DEFAULT-partition strategy in messaging partition manager

Plan: docs/plans/2026-04-09-low-fixes/packages/04-data-messaging-infra.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-LOW-010
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-LOW-014
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-LOW-019
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#DATA-LOW-025
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-LOW-014
```

[Dispatch: test-runner]

## Test Plan
- Verify event-contracts compilation and tests: `npx tsc --noEmit -p libs/event-contracts/tsconfig.json && npx jest --testPathPattern="libs/event-contracts/src/upcasters"`
- Verify backend-common compilation: `npx tsc --noEmit -p libs/backend-common/tsconfig.json`
- Verify messaging-service compilation: `npx tsc --noEmit -p apps/messaging-service/tsconfig.json`
- New upcaster edge case tests must pass
- Existing tests must not regress (shared lib changes)

## Verification Command
`npx tsc --noEmit -p libs/event-contracts/tsconfig.json && npx jest --testPathPattern="libs/event-contracts/src/upcasters" && npx tsc --noEmit -p libs/backend-common/tsconfig.json && npx tsc --noEmit -p apps/messaging-service/tsconfig.json`
[Dispatch: test-runner]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
