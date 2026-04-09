# Package 15: event-store-immutability-checkpoint

## Metadata
Status: PENDING
Estimated Tokens: 22K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [PLAT-CRITICAL-004, PLAT-CRITICAL-005]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Two event store integrity defects: (1) the projection checkpoint is not updated atomically with the read-model apply -- if the process crashes between applying the read model and updating the checkpoint, the projection replays the same events on restart, causing duplicate side effects or corrupted state; (2) the event store has no database-level immutability enforcement -- stored events can be modified or deleted by any code path with write access, violating the fundamental event sourcing invariant (events are immutable facts).

## Findings
- **PLAT-CRITICAL-004**: Projection checkpoint not atomic with read-model apply
  - File: `apps/event-store-service/src/projections/projections.service.ts` (~18.4K chars)
  - Checkpoint update is a separate query after the read-model update
  - Root cause: no shared transaction between read-model write and checkpoint update

- **PLAT-CRITICAL-005**: Event store immutability no DB-level enforcement
  - File: `apps/event-store-service/src/event-store/entities/stored-event.entity.ts` (~2.8K chars)
  - File: `apps/event-store-service/src/event-store/services/event-store.service.ts` (~20.4K chars)
  - No DB triggers prevent UPDATE or DELETE on stored_events table

## Affected Files
- `/var/aqua-saas/apps/event-store-service/src/projections/projections.service.ts` (~18.4K chars)
- `/var/aqua-saas/apps/event-store-service/src/projections/entities/projection-checkpoint.entity.ts` (~2.8K chars)
- `/var/aqua-saas/apps/event-store-service/src/event-store/entities/stored-event.entity.ts` (~2.8K chars)
- `/var/aqua-saas/apps/event-store-service/src/event-store/services/event-store.service.ts` (~20.4K chars)

## Dependencies
None.

## Atomic Commit Plan
```
security(event-store): atomic projection checkpoint and event immutability triggers

1. projections.service.ts: wrap read-model apply + checkpoint update
   in a single database transaction. Both succeed or both rollback.
2. stored-event.entity.ts: add migration creating DB triggers:
   - BEFORE UPDATE on stored_events: RAISE EXCEPTION 'events immutable'
   - BEFORE DELETE on stored_events: RAISE EXCEPTION 'events immutable'
   Only the event_archiver_role (future) can bypass via SET ROLE.

Closes: docs/reviews/2026-04-09-critical-fixes#PLAT-CRITICAL-004
Closes: docs/reviews/2026-04-09-critical-fixes#PLAT-CRITICAL-005
Plan: docs/plans/2026-04-09-critical-fixes/packages/15-event-store-immutability-checkpoint.md
```

## Test Plan
- Unit test: projection apply + checkpoint in same transaction
- Unit test: crash after apply but before checkpoint -- on restart, both are rolled back
- Integration test: UPDATE on stored_events triggers exception
- Integration test: DELETE on stored_events triggers exception
- Unit test: normal event append (INSERT) still works

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/event-store-service/tsconfig.json && npx jest --testPathPattern="apps/event-store-service" --coverage=false
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
