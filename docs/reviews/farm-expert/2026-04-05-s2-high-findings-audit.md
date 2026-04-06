# Review Report -- Farm Expert: S2 High Findings Audit
**Date:** 2026-04-05
**Scope:** Remaining HIGH findings in `apps/farm-service/src/` and `web/modules/farm-module/src/` after S1 fixes.
**Reviewer:** farm-expert
**Prior Review:** `docs/reviews/farm-expert/2026-04-04-full-codebase-audit.md`

---

## S1 Fix Verification

The following items were listed as fixed. Their current state is confirmed below.

| Fix | Status | Evidence |
|-----|--------|----------|
| CloseBatchHandler: transaction + BatchClosed event | CONFIRMED | Lines 98-133: QueryRunner transaction + `eventPublisher.publish()` after `commitTransaction()` |
| TransferBatchHandler: BatchTransferred event | CONFIRMED | Lines 322-343: `eventPublisher.publish()` after `commitTransaction()` |
| AllocateToTankHandler: BatchAllocatedToTank event | CONFIRMED | Lines 231-247: `eventPublisher.publish()` after `commitTransaction()` |
| RecordMortalityHandler: DomainEventPublisher | CONFIRMED | `DomainEventPublisher` injected and used |
| BatchDocumentDataLoader: N+1 fix | CONFIRMED | Lines 925-938: `batchDocumentDataLoader.loadAll()` / `loadByType()` |
| gql-auth.guard: algorithms HS256 | CONFIRMED | Line 129: `getJwtVerifyOptions()` enforces `algorithms:['HS256']` |
| skipCapacityCheck: false | CONFIRMED | Frontend fix applied |
| FeedingScheduler tenantId | NOT FULLY VERIFIED -- see HIGH-005 below |

---

## Summary

| Severity | Count |
|----------|-------|
| HIGH     | 5     |
| MEDIUM   | 0 (scope limited to HIGH per task) |

---

## Findings

---

### [HIGH-001] UpdateBatchStatusHandler: Event Published Before Transaction Guarantee

**File:** `apps/farm-service/src/batch/handlers/update-batch-status.handler.ts`
**Lines:** 78, 83-97
**Category:** Architecture / CQRS Compliance

**Description:**
The handler calls `this.batchRepository.save(batch)` at line 78 as a bare ORM save (no QueryRunner, no explicit transaction). The `DomainEventPublisher.publish()` call at line 83 follows immediately after. This is a CQRS violation for two distinct reasons.

First, the save at line 78 is NOT wrapped in a `DataSource.createQueryRunner()` transaction. If the underlying database encounters an optimistic lock conflict (the entity has a `@VersionColumn()`), TypeORM will throw AFTER the batch state has been mutated in memory. A caller that catches and retries will publish a `BatchStatusChanged` event that reflects the intended new state, but the database row may not have committed that state yet.

Second, the sequence `save → publish event` means the NATS message is sent while the database write is still on the same connection — not yet durable. If the database node crashes between `save` returning and the transaction implicit-committing, the event escapes but the state is lost.

The `DomainEventPublisher` does handle event publish errors with structured logging (confirmed), so the second half of the original HIGH-004 concern (silent error swallow) is resolved. The violation here is specifically the missing QueryRunner transaction wrapping the `save` call.

**Correct Pattern (reference: CloseBatchHandler lines 98-113):**
```
const queryRunner = this.dataSource.createQueryRunner();
await queryRunner.connect();
await queryRunner.startTransaction();
try {
  savedBatch = await queryRunner.manager.save(Batch, batch);
  await queryRunner.commitTransaction();
} catch (error) {
  await queryRunner.rollbackTransaction();
  throw error;
} finally {
  await queryRunner.release();
}
// THEN publish event
await this.eventPublisher.publish(...)
```

**Impact:** Under concurrent status transitions or database instability, a `BatchStatusChanged` event can be published whose state was never committed to the database. Downstream consumers (analytics, notifications) will act on phantom state transitions.

**Recommendation:** See REC-001 in recommendations file.

---

### [HIGH-002] CreateHarvestRecordHandler: generateCode() Uses Injected Repository Outside QueryRunner Transaction

**File:** `apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts`
**Lines:** 31-32, 102-103, 253-276
**Category:** Architecture / Data Integrity (Duplicate Key / Race Condition)

**Description:**
The handler correctly opens a `QueryRunner` transaction at line 56. However, `generateCode()` at line 253 executes its sequence query against `this.harvestRepository` (the constructor-injected TypeORM repository), NOT against `queryRunner.manager`. This means the sequence query runs on a separate, independent database connection that is OUTSIDE the transaction.

The consequence is a classic sequence generation race condition:

1. Two concurrent `createHarvestRecord` calls both call `generateCode()`.
2. Both read `lastRecord` on their own connections and both calculate `sequence = 42`.
3. Both proceed to generate `HR-2026-00042`.
4. Both save their `HarvestRecord` inside their respective transactions.
5. Whichever commits second will violate the unique constraint on `recordCode` or produce a duplicate lot number.

The comment at line 101 says "inside transaction to prevent duplicate codes" but this claim is false -- the `generateCode()` method uses the injected repository, not `queryRunner.manager`, so it is NOT inside the transaction.

**Root Cause:** The `generateCode()` method at line 257 calls `this.harvestRepository.createQueryBuilder(...)`. Since `this.harvestRepository` is bound to the module's shared connection pool, this query executes outside the `QueryRunner` context, defeating the serialization guarantee.

**Impact:** Under concurrent harvest creation, duplicate `recordCode` or `lotNumber` values can be generated, violating lot traceability requirements. This is a regulatory concern in aquaculture (lot numbers are used for product recall traceability).

**Correct Fix:** Pass `queryRunner.manager` into `generateCode()` and rewrite the method to use `manager.createQueryBuilder(HarvestRecord, 'hr')...`.

**Recommendation:** See REC-002 in recommendations file.

---

### [HIGH-003] UpdateHarvestRecordHandler: No Transaction, No Pessimistic Lock, No Audit Trail

**File:** `apps/farm-service/src/harvest/handlers/update-harvest-record.handler.ts`
**Lines:** 23-81
**Category:** Architecture / CQRS Compliance / Data Integrity

**Description:**
`UpdateHarvestRecordHandler` has three separate violations that collectively constitute a HIGH finding:

**Violation A -- No transaction:** The `findOne` (line 27) and `save` (line 80) are two separate operations with no wrapping transaction. If the save fails (optimistic lock, network blip), the in-memory object is mutated but the database row is not. The handler returns the in-memory object to the resolver, which then returns it to the client as if the update succeeded.

**Violation B -- No pessimistic lock:** The `findOne` at line 27 has no `lock: { mode: 'pessimistic_write' }`. Under concurrent update requests for the same harvest record (e.g., two operators updating status simultaneously), both will read the same version, both will mutate fields, and the last writer will silently overwrite the first writer's changes. Unlike `CreateHarvestRecordHandler` which uses pessimistic locks correctly, `UpdateHarvestRecordHandler` has none.

**Violation C -- No audit trail field:** The command receives `updatedBy` (line 24 destructures it from the command), but the handler never writes it to the entity. The `HarvestRecord` entity presumably has an `updatedBy` or `supervisorId` field (the create handler sets `supervisorId: recordedBy` at line 141 of the create handler). Audit trail completeness is a regulatory requirement in aquaculture harvest documentation.

**Impact:**
- Concurrent updates corrupt harvest records with last-write-wins semantics and no conflict detection.
- A failed save returns stale data to the client with no error, causing the UI to show "success" while the database has the old value.
- Audit trail is incomplete: who updated the harvest record is not recorded.

**Recommendation:** See REC-003 in recommendations file.

---

### [HIGH-004] CreateHarvestRecordHandler: No BatchHarvested NATS Event Published

**File:** `apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts`
**Lines:** 235-247 (end of try block, after commitTransaction)
**Category:** Architecture / CQRS Compliance / Event Contract Violation

**Description:**
The `BatchHarvestedEvent` is defined in `libs/event-contracts/src/farm-events.ts` at line 61 and is listed in the `FarmEvent` union at line 403. This event is the primary mechanism by which downstream services (notification service, analytics, regulatory reporting) learn that a harvest occurred.

The `CreateHarvestRecordHandler` does not inject `DomainEventPublisher`, does not have `@Optional() @Inject('EVENT_BUS')`, and does not call any event publication mechanism anywhere in the file. After `queryRunner.commitTransaction()` at line 236, the handler returns the record with no event published.

All other critical batch lifecycle handlers that were fixed in S1 now publish their events. The harvest creation handler is the only remaining command handler in the batch lifecycle that produces a persistent state change without publishing a corresponding domain event.

This is confirmed by searching all files in `apps/farm-service/src/harvest/handlers/` for `publish`, `eventBus`, `EVENT_BUS`, and `DomainEventPublisher` -- zero matches.

**The `BatchHarvestedEvent` contract requires:**
```typescript
{
  eventType: 'BatchHarvested',
  batchId: string,
  harvestedQuantity: number,
  harvestedAt: Date,
  averageWeight?: number,
  totalWeight?: number,
  tenantId: string,
}
```

All required fields are available inside the handler at the point of commit.

**Impact:** Downstream consumers expecting `BatchHarvested` events (notification service for harvest alerts, analytics for production reporting, regulatory compliance module) receive nothing when a harvest is recorded. This is a CQRS architecture violation: the command side commits state without notifying the event bus.

**Recommendation:** See REC-004 in recommendations file.

---

### [HIGH-005] FeedingSchedulerService IDOR: Partial Fix -- cleanupOldExecutions Tenant Isolation Gap

**File:** `apps/farm-service/src/feeding/services/feeding-cron.service.ts`
**Lines:** 700-735
**Category:** Security / Tenant Isolation

**Description:**
The prior audit (CRITICAL-001 in S1) identified IDOR in `FeedingSchedulerService`. The S1 fix partially addressed this by:

- `generateDailyPlans()`: Fixed -- uses `listTenantSchemas()` + `search_path` isolation (lines 316-335).
- `checkFeedTransitions()`: Fixed -- uses `listTenantSchemas()` + `search_path` isolation (lines 556-567).
- `manualGenerateDailyPlans()`: Fixed -- requires `tenantId` parameter, filters `WHERE tenantId = :tenantId` (lines 851-855).

However, `cleanupOldExecutions()` at line 681 has a tenant isolation gap:

**Line 700-707:** The initial query to find tenants with old data uses `this.executionRepo.createQueryBuilder('e')` with NO `WHERE tenantId` filter. This is a cross-schema ORM query that returns ALL `tenantId` values with old records regardless of search_path. While this is a read-only discovery query (not a data leak), it mixes tenant data in a single query builder result set.

**Line 731 -- Schema name construction is unsafe:**
```typescript
const schemaName = `tenant_${tenantId.replace(/-/g, '').substring(0, 16).toLowerCase()}`;
```
This constructs the schema name by string manipulation of the `tenantId` value that came from the database query at line 700. If the `tenantId` column value in the database is tampered with or contains unexpected characters (e.g., from a SQL injection that managed to write a malicious value), the constructed `schemaName` string is interpolated directly into:
```typescript
await queryRunner.query(`SET search_path TO "${schemaName}", farm, public`);
```
at line 736. The `"${schemaName}"` is inside double-quotes in the SQL string, which is PostgreSQL's identifier quoting. PostgreSQL does allow embedded double-quotes in identifiers if escaped as `""`. A `tenantId` that resolves to a schema name containing `"` would break out of the identifier quoting.

The correct pattern (used by `listTenantSchemas()` from `@aquaculture/backend-common`) is to derive schema names from `information_schema.schemata` where names are already validated, not from user-controllable data.

**Line 740-749:** The batch `DELETE` query at line 740 uses a parameterized `$1` for `tenantId`, so the delete itself is safe from SQL injection. The schema name interpolation at line 736 is the attack surface.

**Impact:**
- If a tenant UUID is corrupted or injected with a crafted value at the database level, the `SET search_path` call could target an unintended schema, causing data from another tenant to be deleted by the cleanup job.
- Severity is elevated from MEDIUM to HIGH because this is a cron job that deletes data (irreversible without backups) and operates across all tenants without rate limiting or per-operation validation.

**Correct Fix:** Use `listTenantSchemas()` (from `@aquaculture/backend-common`) to enumerate schemas with validated names, exactly as `generateDailyPlans()` does. Do not construct schema names by string manipulation of tenant IDs from the database.

**Recommendation:** See REC-005 in recommendations file.

---

## Status Summary Against S1 Scope

| Finding | Original Severity | Current Status |
|---------|-------------------|----------------|
| HIGH-001 (CloseBatchHandler) | HIGH | FIXED in S1 |
| HIGH-002 (TransferBatchHandler event) | HIGH | FIXED in S1 |
| HIGH-003 (AllocateToTankHandler event) | HIGH | FIXED in S1 |
| HIGH-004 (UpdateBatchStatusHandler silent event swallow) | HIGH | PARTIAL -- silent swallow fixed (DomainEventPublisher), but missing QueryRunner transaction (this audit HIGH-001) |
| HIGH-005 (RecordMortalityHandler silent swallow) | HIGH | FIXED in S1 (DomainEventPublisher handles logging) |
| HIGH-006 (BatchResolver N+1) | HIGH | FIXED in S1 (DataLoader) |
| CRITICAL-001 (FeedingScheduler IDOR) | CRITICAL | PARTIAL -- see HIGH-005 this audit |

## New Findings (Not in S1)

| ID | File | Severity |
|----|------|----------|
| HIGH-001 | `update-batch-status.handler.ts:78` | HIGH |
| HIGH-002 | `create-harvest-record.handler.ts:102-103` | HIGH |
| HIGH-003 | `update-harvest-record.handler.ts:23-81` | HIGH |
| HIGH-004 | `create-harvest-record.handler.ts` (no event) | HIGH |
| HIGH-005 | `feeding-cron.service.ts:731` | HIGH |

---

## Cross-Domain Dependencies

- HIGH-004: `BatchHarvestedEvent` consumers in notification-service and analytics/platform-services need to be notified when this event starts publishing. Flag for **platform-services** and **messaging-expert** review.
- HIGH-001: `BatchStatusChangedEvent` already consumed downstream -- the fix adds no new fields, so no schema migration needed.
- HIGH-003: `updatedBy` audit trail may require a migration to add the column to `harvest_records` if not already present. Flag for **data-expert** review.
