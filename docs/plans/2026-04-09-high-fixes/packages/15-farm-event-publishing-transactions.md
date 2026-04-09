# Package 15: farm-event-publishing-transactions

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 30K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Closing-Findings: [FARM-HIGH-001, FARM-HIGH-002, FARM-HIGH-003, FARM-HIGH-004]
Source-Reviews:
  - docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md

## Context
Farm-service has four CQRS/data-integrity HIGHs: (1) UpdateBatchStatusHandler publishes event without QueryRunner transaction, (2) CreateHarvestRecordHandler's generateCode() uses injected repo outside transaction causing duplicate lot numbers, (3) UpdateHarvestRecordHandler has no transaction/lock/audit trail, (4) CreateHarvestRecordHandler does not publish BatchHarvestedEvent at all. These are all in the farm domain's critical batch lifecycle path.

## Findings

**FARM-HIGH-001** (farm-expert, HIGH)
File: apps/farm-service/src/batch/handlers/update-batch-status.handler.ts (lines 78, 83-97)
batchRepository.save() without QueryRunner transaction. Event published while DB write not yet durable. Concurrent status transitions produce phantom events.

**FARM-HIGH-002** (farm-expert, HIGH)
File: apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts (lines 31-32, 102-103, 253-276)
generateCode() uses this.harvestRepository (constructor-injected, outside transaction) despite comment claiming "inside transaction." Concurrent harvest creation produces duplicate recordCode/lotNumber -- regulatory violation for lot traceability.

**FARM-HIGH-003** (farm-expert, HIGH)
File: apps/farm-service/src/harvest/handlers/update-harvest-record.handler.ts (lines 23-81)
No transaction (findOne + save are separate operations). No pessimistic lock (concurrent updates = last-write-wins). updatedBy never written to entity (audit trail incomplete).

**FARM-HIGH-004** (farm-expert, HIGH)
File: apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts (lines 235-247)
No DomainEventPublisher injected. No event publication after commitTransaction(). BatchHarvestedEvent contract exists but is never published. Downstream consumers (notifications, analytics, regulatory) never learn about harvests.

## Affected Files
- apps/farm-service/src/batch/handlers/update-batch-status.handler.ts
- apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts
- apps/farm-service/src/harvest/handlers/update-harvest-record.handler.ts

## Dependencies
None. All handlers are within farm-service.

## Atomic Commit Plan
```
fix(farm): wrap batch/harvest handlers in QueryRunner transactions, publish BatchHarvestedEvent

UpdateBatchStatusHandler publishes event without transaction guarantee.
CreateHarvestRecordHandler's generateCode() runs outside transaction causing
duplicate lot numbers. UpdateHarvestRecordHandler has no transaction or lock.
BatchHarvestedEvent is never published despite contract existing.

Wrap UpdateBatchStatusHandler in QueryRunner transaction. Move generateCode()
to use queryRunner.manager. Add QueryRunner + pessimistic_write lock to
UpdateHarvestRecordHandler. Inject DomainEventPublisher in CreateHarvestRecord
and publish BatchHarvestedEvent after commit. Write updatedBy to entity.

Plan: docs/plans/2026-04-09-high-fixes/packages/15-farm-event-publishing-transactions.md
Closes: docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md#HIGH-001
Closes: docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md#HIGH-002
Closes: docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md#HIGH-003
Closes: docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md#HIGH-004
```

## Test Plan
- Unit test: UpdateBatchStatusHandler uses QueryRunner
- Unit test: generateCode() uses queryRunner.manager not injected repo
- Unit test: concurrent generateCode() produces unique codes (serialized)
- Unit test: UpdateHarvestRecord acquires pessimistic_write lock
- Unit test: UpdateHarvestRecord writes updatedBy to entity
- Unit test: CreateHarvestRecord publishes BatchHarvestedEvent after commit
- Integration test: BatchHarvestedEvent received by mock consumer

## Verification Command
`npx tsc --noEmit -p apps/farm-service/tsconfig.json && npx jest --testPathPattern="apps/farm-service/src/(batch|harvest)" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
