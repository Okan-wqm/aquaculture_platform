# Package 16: farm-outbox-cron-lifecycle

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 20K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [S2-HIGH-003, S2-HIGH-005]
Source-Reviews:
  - docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md

## Context
Two remaining farm-service HIGH findings: (1) 20+ handlers still use fire-and-forget event publishing without transactional outbox (water quality events are life-safety critical -- missed alert can cause fish mortality), (2) FeedingScheduler cron job does not use withTenantContext pattern (partial fix from S1 left cleanupOldExecutions with schema interpolation vulnerability).

## Findings

**S2-HIGH-003** (farm-expert, HIGH)
File: apps/farm-service/src/water-quality/handlers/*.ts
File: apps/farm-service/src/batch/handlers/ (remaining handlers)
20+ handlers publish events via DomainEventPublisher (fire-and-forget) without transactional outbox. Water quality alert events are life-safety critical -- if NATS is temporarily unavailable, the event is lost silently, no alert fires, and fish mortality risk is undetected.

**S2-HIGH-005** (farm-expert, HIGH)
File: apps/farm-service/src/feeding/services/feeding-cron.service.ts
Cron job does not use withTenantContext. allocateCapacity has no block/lock. FeedingScheduler schema interpolation vulnerability in cleanupOldExecutions.

## Affected Files
- apps/farm-service/src/water-quality/handlers/*.ts
- apps/farm-service/src/feeding/services/feeding-cron.service.ts
- apps/farm-service/src/batch/handlers/ (remaining non-outbox handlers)

## Dependencies
Depends conceptually on the outbox pattern already established in farm-service (libs/outbox). No code dependency on other packages in this plan.

## Atomic Commit Plan
```
fix(farm): migrate water quality handlers to outbox, fix cron tenant context

20+ handlers use fire-and-forget event publishing without transactional outbox.
Water quality events are life-safety critical -- lost events mean missed alerts
and potential fish mortality. FeedingScheduler cron lacks withTenantContext
and has schema interpolation in cleanupOldExecutions.

Migrate critical handlers to OutboxPublisher.enqueue() within QueryRunner
transactions. Apply withTenantContext to FeedingScheduler cron methods.
Replace schema string manipulation with listTenantSchemas().

LIFE-SAFETY: Water quality alert events must be guaranteed-delivery via outbox.

Plan: docs/plans/2026-04-09-high-fixes/packages/16-farm-outbox-cron-lifecycle.md
Closes: docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md#S2-HIGH-003
Closes: docs/reviews/farm-expert/2026-04-05-s2-high-findings-audit.md#S2-HIGH-005
```

## Test Plan
- Unit test: water quality handler enqueues event in outbox within transaction
- Unit test: lost NATS connection does not lose water quality event
- Unit test: cron job uses withTenantContext for each tenant iteration
- Unit test: cleanupOldExecutions uses listTenantSchemas() not string interpolation
- Integration test: outbox worker publishes water quality event to NATS

## Verification Command
`npx tsc --noEmit -p apps/farm-service/tsconfig.json && npx jest --testPathPattern="apps/farm-service/src/(water-quality|feeding)" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
