# Package 22: messaging-outbox-idempotency

## Metadata
Status: PENDING
Estimated Tokens: 30K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [MSG-HIGH-004, MSG-HIGH-005, MSG-HIGH-006, MSG-HIGH-007, MSG-HIGH-010, MSG-HIGH-011]
Source-Reviews:
  - docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
Messaging service outbox and delivery reliability HIGHs: (1) outbox publisher does not set Nats-Msg-Id for deduplication, (2) no exponential backoff on publish retry, (3) no dead-letter metric counter, (4) no backlog gauge for monitoring, (5) message entity missing tenantId field, (6) no partition manager for message sharding.

## Findings

**MSG-HIGH-004** (messaging-expert, HIGH)
Outbox publisher does not set Nats-Msg-Id header. JetStream duplicate_window cannot deduplicate republished messages after worker crash recovery.

**MSG-HIGH-005** (messaging-expert, HIGH)
Outbox worker retry uses fixed delay with no exponential backoff. Failed publishes retry at constant rate, hammering NATS during outages.

**MSG-HIGH-006** (messaging-expert, HIGH)
No dead-letter metric counter. Dead-lettered messages are invisible to monitoring. Prometheus gauge for dead-letter count does not exist.

**MSG-HIGH-007** (messaging-expert, HIGH)
No backlog gauge for outbox pending count. Operators cannot detect outbox growth during publish failures.

**MSG-HIGH-010** (messaging-expert, HIGH)
Message entity missing tenantId field. Multi-tenant message queries require join to conversation entity for tenant filtering. Direct message table queries bypass tenant isolation.

**MSG-HIGH-011** (messaging-expert, HIGH)
No partition manager for high-volume message streams. All messages for all tenants processed through single outbox worker queue.

## Affected Files
- apps/messaging-service/src/outbox/ (publisher, worker)
- apps/messaging-service/src/messaging/entities/message.entity.ts
- libs/outbox/src/outbox-publisher.service.ts
- libs/outbox/src/outbox-worker.service.ts

## Dependencies
MSG-HIGH-010 depends on DB-HIGH-001 from package 21. If package 21 adds tenant_id to messaging tables, this package adds the TypeORM entity mapping and query scoping. Can be executed in parallel if entity change is self-contained.

## Atomic Commit Plan
```
fix(messaging): add Nats-Msg-Id dedup, exponential backoff, dead-letter metrics, message tenantId

Outbox publisher missing Nats-Msg-Id for JetStream deduplication. Fixed retry
delay hammers NATS during outages. No dead-letter or backlog metrics. Message
entity missing tenantId for direct tenant isolation.

Set Nats-Msg-Id from outbox row ID in publisher. Implement exponential backoff
with jitter on retry. Add outbox_dead_letter_total counter and outbox_pending
gauge. Add tenantId column to Message entity. Add partition manager stub for
future horizontal scaling.

Plan: docs/plans/2026-04-09-high-fixes/packages/22-messaging-outbox-idempotency.md
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-006
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-007
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-010
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MSG-HIGH-011
```

## Test Plan
- Unit test: published NATS message includes Nats-Msg-Id header
- Unit test: retry delay doubles on each consecutive failure
- Unit test: dead-letter increment counter fires on dead-letter transition
- Unit test: outbox_pending gauge reflects pending row count
- Unit test: Message entity has tenantId column
- Unit test: message queries include tenantId in WHERE

## Verification Command
`npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx tsc --noEmit -p libs/outbox/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src/(outbox|messaging)" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
