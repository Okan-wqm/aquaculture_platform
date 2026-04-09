# Package 07: farm-domain-integrity

## Metadata
Status: PENDING
Estimated Tokens: 25K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [FARM-MEDIUM-001, FARM-MEDIUM-002, FARM-MEDIUM-003, FARM-MEDIUM-004, FARM-MEDIUM-005, FARM-MEDIUM-006, FARM-MEDIUM-007, FARM-MEDIUM-008]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/farm-expert/2026-04-04-full-codebase-audit.md

## Context
Eight farm domain findings cover transactional integrity, data correctness, performance, and security. They span batch management handlers, resolvers, and the frontend CullModal. Grouped because they all live within the farm-service bounded context and share file locality in `apps/farm-service/src/batch/`.

## Findings

**FARM-MEDIUM-001 — Batch code generation outside transaction**
`create-batch.handler.ts` generates the batch number (via query) before starting the transaction. Two concurrent requests can receive the same batch number. Move `generateBatchNumber()` inside the transaction or use a DB sequence.

**FARM-MEDIUM-002 — Initial batch locations missing maxDensity**
When creating initial locations for a new batch, `maxDensity` is not set on the batch-location entity. Downstream density calculations divide by `maxDensity`, resulting in NaN or Infinity. Default to the tank's configured max density.

**FARM-MEDIUM-003 — Transfer handler allows negative fish count**
`transfer-batch.handler.ts` does not use `Math.max(0, remaining)` after subtracting transferred quantity. If the subtraction underflows (stale count), the source location ends up with negative fish — a domain invariant violation.

**FARM-MEDIUM-004 — Transfer handler re-reads batch without pessimistic lock**
After starting the transaction, `transfer-batch.handler.ts` re-reads the source batch/location without `lock: { mode: 'pessimistic_write' }`. A concurrent transfer can read the same stale count, causing double-counting.

**FARM-MEDIUM-005 — Batch resolver uses no DataLoader**
`batch.resolver.ts` resolves `batch.locations` and `batch.feedAssignments` via individual queries per batch in a list query. N+1 query pattern. Add DataLoader for `BatchLocation` and `BatchFeedAssignment`.

**FARM-MEDIUM-006 — Worker entity stores PII in plaintext**
The farm worker/employee reference entity stores names and potentially national IDs in plaintext columns. CLAUDE.md requires PII masking. Add column-level encryption or store only the employee reference ID and resolve names from HR service.

**FARM-MEDIUM-007 — CullModal allows future date selection**
The frontend CullModal date picker does not restrict `max` to today. A user can record a cull with a future date, which is semantically invalid (you cannot cull fish that haven't been culled yet).

**FARM-MEDIUM-008 — Pond/tank index not tenant-scoped**
The unique index on pond/tank identifiers (e.g., tank number within a site) does not include `tenant_id`. Two tenants sharing the same database (multi-tenant schema) could collide on tank numbers. Add `tenant_id` to the unique index.

## Affected Files
- apps/farm-service/src/batch/handlers/create-batch.handler.ts
- apps/farm-service/src/batch/handlers/transfer-batch.handler.ts
- apps/farm-service/src/batch/entities/batch-location.entity.ts
- apps/farm-service/src/batch/batch.resolver.ts
- apps/farm-service/src/batch/dataloaders/ (new or existing DataLoader files)
- apps/farm-service/src/common/entities/worker.entity.ts (or equivalent)
- apps/farm-service/src/pond/entities/pond.entity.ts (or tank entity)
- web/modules/farm-module/src/pages/production/components/CullModal.tsx

## Dependencies
None. Farm service is self-contained.

## Atomic Commit Plan
```
fix(farm): move code-gen into TX, add maxDensity default, guard negative transfer, lock re-read, add DataLoader, mask PII, cap cull date, scope pond index

Eight farm domain integrity fixes:
- Move batch number generation inside transaction (sequence or FOR UPDATE)
- Default maxDensity from tank config on location creation
- Guard against negative fish count with Math.max(0, remaining)
- Add pessimistic_write lock on transfer source re-read
- Add DataLoader for batch.locations and batch.feedAssignments (N+1)
- Remove plaintext PII from worker entity; store employee ref ID only
- Add max={today} to CullModal date picker
- Add tenant_id to pond/tank unique index

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-MEDIUM-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-MEDIUM-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-MEDIUM-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-MEDIUM-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-MEDIUM-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-MEDIUM-006
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-MEDIUM-007
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FARM-MEDIUM-008
Plan: docs/plans/2026-04-09-medium-fixes/packages/07-farm-domain-integrity.md
```

## Test Plan
- Unit test: concurrent batch creation produces unique batch numbers (DB sequence)
- Unit test: new batch location has maxDensity > 0
- Unit test: transfer with quantity > source count results in 0 remaining, not negative
- Unit test: transfer acquires pessimistic_write lock (mock verifies lock mode)
- Unit test: batch list query uses DataLoader (verify single query for N batches)
- Unit test: worker entity does not expose plaintext name/nationalId
- Unit test: CullModal date picker max is <= today
- Migration test: pond unique index includes tenant_id

## Verification Command
`npx tsc --noEmit -p apps/farm-service/tsconfig.json && npx jest --testPathPattern="apps/farm-service/src/batch" --coverage=false && npx vitest run web/modules/farm-module`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
