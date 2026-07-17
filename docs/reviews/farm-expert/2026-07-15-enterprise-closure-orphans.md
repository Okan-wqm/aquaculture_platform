# Farm/feed enterprise-closure orphan review — 2026-07-15

Scope: the storage-ledger and feeding cutover on `origin/main` after the registry truth freeze.
The evidence was re-run against `db43c40d` on 2026-07-17 before any remediation. These are
reproduced findings, not candidates. This finding-only wave changes no farm runtime or migration.

## FARM-CRITICAL-237

**Post-cutover FeedingLedger treats depleted feed as untracked and commits feeding without a
stock movement.** State: IN-PROGRESS. Owner: `farm-expert`. Deadline: 2026-07-18.

Evidence:

- `apps/farm-service/src/storage/services/stock-movement.service.ts:32-36` declares the storage
  ledger to be the single stock truth.
- `apps/farm-service/src/storage/services/stock-movement.service.ts:358-366` equates storage
  presence with the existence of a current projection row.
- `apps/farm-service/src/storage/services/stock-movement.service.ts:669-673` deletes that row when
  its balance reaches zero.
- `apps/farm-service/src/feeding/services/feeding-ledger.service.ts:155-164` persists the feeding
  record and batch totals.
- `apps/farm-service/src/feeding/services/feeding-ledger.service.ts:205-217` treats the now-absent
  row as a Phase-A tenant, warns, and skips the immutable OUT movement.

Root cause: a temporary dual-ledger compatibility signal survived the single-ledger cutover and is
derived from mutable projection presence. Depletion therefore changes authority mode. A subsequent
feeding can commit while producing no stock movement. This is a post-cutover recurrence of the
exception documented by resolved `FARM-HIGH-058`; broad SSoT finding `FARM-HIGH-218` does not record
this concrete fail-open chain.

Closure evidence must prove that missing usable stock fails closed after cutover, depletion remains
represented unambiguously, and the FeedingRecord, batch aggregate, projection, and immutable
movement commit or roll back as one tenant-pinned transaction.

## FARM-CRITICAL-238

**Migration 180610 skips every legacy balance for dual-present feeds and overwrites the roll-up
without reconciliation provenance.** State: IN-PROGRESS. Owner: `data-expert`. Deadline:
2026-07-18.

Evidence:

- `apps/farm-service/src/database/migrations/1806100000000-BackfillFeedInventoryToStorageLedger.ts:26-32`
  explicitly declines to merge dual-present data.
- The same migration at `:70-75` and `:97-106` lets any storage row for a feed suppress every
  legacy site/lot row for that feed.
- The same migration at `:132-151` overwrites `feeds.quantity` from the storage-only aggregate.

Root cause: the migration makes a feed-level existence decision for row-level facts, then destroys
the comparison value without recording whether each source row was migrated, already represented,
or conflicting. The concrete loss mode is not covered by the broad `FARM-HIGH-218` entry.

Closure evidence must classify every legacy row as `MIGRATED`, `ALREADY_REPRESENTED`, or `CONFLICT`,
fail closed on unresolved conflicts, preserve provenance durably, and pass PostgreSQL backfill,
rerun, rollback, and bidirectional-parity tests.

## FARM-HIGH-239

**Inventory-count approval and stock transfer bypass the canonical inventory mutation sink.**
State: IN-PROGRESS. Owner: `farm-expert`. Deadline: 2026-07-22.

Evidence:

- `apps/farm-service/src/storage/services/stock-movement.service.ts:142-155` and `:261-285` define
  the canonical mutation sequence and its audit/roll-up behavior.
- `apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts:66-100` and `:102-140`
  write movement and projection state directly.
- `apps/farm-service/src/storage/handlers/transfer-stock.handler.ts:92-160` and `:165-185` directly
  write both projection legs and the movement rows.

Root cause: the platform has a nominal mutation sink but does not make bypass structurally
impossible. Writer-specific copies can diverge on idempotency, lot bookkeeping, roll-up, alarm,
outbox, authorization, and concurrency rules. `FARM-HIGH-215` covers only purchase-order receipt;
it does not cover these two writers.

Closure evidence must route count approval and both transfer legs through one tenant-pinned
`InventoryMutationKernel`/canonical sink, with idempotent replay, transactional outbox/audit,
tenant-negative, concurrent-writer, and deadlock tests.

## FARM-CRITICAL-240

**Concurrent NULL-lot receipts can create duplicate storage projections and leave Feed.quantity
stale.** State: IN-PROGRESS. Owner: `data-expert`. Deadline: 2026-07-18.

Evidence:

- `apps/farm-service/src/storage/dto/receive-delivery.input.ts:16-24` makes lot identity optional.
- `apps/farm-service/src/storage/entities/storage-inventory.entity.ts:28-30` and `:55-56` put a
  conventional unique index over a nullable lot column.
- `apps/farm-service/src/database/migrations/1800000000000-Baseline.ts:169` does not use
  `NULLS NOT DISTINCT` or an equivalent canonical key.
- `apps/farm-service/src/storage/services/stock-movement.service.ts:684-720` performs an unlocked
  check-then-insert.
- The same service at `:729-751` computes and writes the feed roll-up after that race window.

Root cause: PostgreSQL considers NULL values distinct in the current index. Two transactions can
both miss the projection, insert separate rows for the same physical stock, and compute a roll-up
that cannot see the peer's uncommitted row.

Closure evidence must make the physical-stock key unique at the database boundary including no-lot
stock, use an atomic upsert/lock strategy, reconcile existing duplicates without blind aggregation,
and prove concurrent receipt, rerun, deadlock, and roll-up parity behavior on PostgreSQL.

## FARM-CRITICAL-241

**Migration 180660 rollback cannot distinguish backfilled records from live drain writes and
deletes both.** State: IN-PROGRESS. Owner: `data-expert`. Deadline: 2026-07-18.

Evidence:

- `apps/farm-service/src/feeding/services/daily-feeding-execution.service.ts:731-768` creates live
  drain records carrying `sourceExecutionId` without a meal association.
- `apps/farm-service/src/feeding/services/feeding-ledger.service.ts:149-152` persists that source
  execution identifier onto the live FeedingRecord.
- `apps/farm-service/src/database/migrations/1806600000000-BackfillExecutionsToFeedingRecords.ts:133-159`
  deletes every row matching `sourceExecutionId IS NOT NULL AND mealId IS NULL` and decrements
  aggregates, explicitly accepting the ambiguity.

Root cause: migration-created rows have no migration-owned provenance. The rollback predicate is
also a valid live-writer shape, so rollback erases facts it did not create and cannot reconstruct.

Closure evidence must mark backfilled rows with durable migration provenance, restrict rollback to
that provenance, preserve concurrent live writes, and pass PostgreSQL up/rerun/down plus live-write
interleaving tests with aggregate and checksum parity.
