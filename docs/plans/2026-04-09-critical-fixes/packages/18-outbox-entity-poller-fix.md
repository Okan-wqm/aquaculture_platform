# Package 18: outbox-entity-poller-fix

## Metadata
Status: IMPLEMENTED
Implemented: 2026-04-09
Estimated Tokens: 6K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [MSG-CRITICAL-001, MSG-CRITICAL-002, MSG-CRITICAL-003]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Three compounding outbox infrastructure defects: (1) the outbox entity uses BIGINT for its primary key instead of UUID, creating collision risk across database replicas and making cross-replica deduplication unreliable; (2) the entity is missing critical fields (tenantId for isolation, aggregateId for ordering, next_attempt_at for backoff); (3) the outbox poller uses a plain SELECT without `FOR UPDATE SKIP LOCKED`, causing double-publish when multiple worker replicas select the same rows simultaneously.

## Findings
- **MSG-CRITICAL-001**: Outbox uses BIGINT not UUID -- cross-replica collision
  - File: `apps/messaging-service/src/outbox/messaging-outbox.entity.ts` (~933 chars)
  - BIGINT sequences are per-database; replicas generate conflicting IDs

- **MSG-CRITICAL-002**: Outbox entity missing tenantId, aggregateId, next_attempt_at
  - File: `apps/messaging-service/src/outbox/messaging-outbox.entity.ts`
  - No tenantId (violates tenant isolation), no aggregateId (no ordering guarantee),
    no next_attempt_at (no exponential backoff)

- **MSG-CRITICAL-003**: Outbox poller no SELECT FOR UPDATE SKIP LOCKED
  - File: `apps/messaging-service/src/outbox/outbox-worker.service.ts` (~4K chars)
  - Plain SELECT allows multiple workers to process the same row

## Affected Files
- `/var/aqua-saas/apps/messaging-service/src/outbox/messaging-outbox.entity.ts` (~933 chars)
- `/var/aqua-saas/apps/messaging-service/src/outbox/outbox-worker.service.ts` (~4K chars)

## Dependencies
None.

## Atomic Commit Plan
```
fix(messaging): fix outbox entity PK, add required fields, add row-level locking

1. messaging-outbox.entity.ts: change PK from BIGINT to UUID
   (uuid_generate_v4 default). Add tenantId (indexed), aggregateId,
   and next_attempt_at columns. Add migration for schema change.
2. outbox-worker.service.ts: change SELECT to use FOR UPDATE SKIP
   LOCKED to prevent double-publish across worker replicas. Add
   next_attempt_at filter to only pick up rows ready for retry.

BREAKING CHANGE: Outbox PK type changes from BIGINT to UUID.
Existing rows need migration (generate UUIDs for existing BIGINT PKs).

Closes: docs/reviews/2026-04-09-critical-fixes#MSG-CRITICAL-001
Closes: docs/reviews/2026-04-09-critical-fixes#MSG-CRITICAL-002
Closes: docs/reviews/2026-04-09-critical-fixes#MSG-CRITICAL-003
Plan: docs/plans/2026-04-09-critical-fixes/packages/18-outbox-entity-poller-fix.md
```

## Test Plan
- Unit test: outbox entity PK is UUID type
- Unit test: outbox entity has tenantId, aggregateId, next_attempt_at columns
- Unit test: worker query uses FOR UPDATE SKIP LOCKED
- Integration test: two concurrent workers -- each processes different rows (no overlap)
- Migration test: existing BIGINT rows migrated to UUID PKs

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src/outbox" --coverage=false
```

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
