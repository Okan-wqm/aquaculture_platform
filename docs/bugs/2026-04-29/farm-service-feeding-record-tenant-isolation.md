# Farm Service Feeding Record Tenant Isolation

Date: 2026-04-29

## Problem
Feeding is a high-risk farm-service write path for read-after-write and tenant visibility failures. One command writes a feeding record, updates batch feed totals, deducts feed inventory, and enqueues outbox events. Without a real Postgres tenant contract, a row could exist in the database while tenant-scoped reads, inventory state, or frontend projections remain stale or cross-tenant unsafe.

## Root Cause
The existing coverage did not prove the feeding transaction across schema-per-tenant routing, QueryRunner search_path, inventory deduction, feeding list/summary reads, and transactional outbox enqueue in one real database flow.

## Enterprise Fix
Added `apps/farm-service/src/__tests__/e2e/feeding-record-tenant-isolation.postgres.spec.ts`. The suite creates Tenant A and Tenant B schemas with identical business keys, executes a Tenant A feeding command through the real `CreateFeedingRecordHandler`, and verifies:

- Feeding record rows stay in Tenant A's schema.
- Source `farm` schema receives no tenant-owned feeding rows.
- Tenant B sees zero Tenant A feeding rows.
- Tenant A batch feed totals update immediately.
- Tenant A feed inventory deducts and moves to low stock while Tenant B inventory remains unchanged.
- Tenant A feeding records and summary queries see the committed write immediately.
- Real `OutboxPublisher` writes only Tenant A `FeedingRecorded` and `FeedInventoryLow` rows to `farm.farm_outbox`.

## Why The Test Was Added
This protects the backend path behind mobile feeding buttons and stale frontend complaints. It verifies the complete write/read/event contract instead of only checking a mocked repository call.

## Verification
Passed on 2026-04-29:

```bash
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/feeding-record-tenant-isolation.postgres.spec.ts --runInBand
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/feeding-record-tenant-isolation.postgres.spec.ts apps/farm-service/src/__tests__/e2e/batch-allocation-tenant-isolation.postgres.spec.ts apps/farm-service/src/__tests__/e2e/graphql-loader-tenant-source.architecture.spec.ts apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts --runInBand
```

## Status
Implemented and verified on 2026-04-29.
