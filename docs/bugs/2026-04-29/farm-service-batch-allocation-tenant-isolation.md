# Farm Service Batch Allocation Tenant Isolation

Date: 2026-04-29

## Problem
Batch allocation is a high-risk farm-service path because one request writes several tenant-owned tables in a transaction: `batches_v2`, `tank_allocations`, `tank_batches`, and `tank_operations`. If the transactional `QueryRunner` loses the active tenant `search_path`, the database can contain rows that the tenant-scoped API/frontend cannot see, or a different tenant can be affected by matching business keys.

## Root Cause
No new production bug was confirmed in this implementation slice. The risk exists because this path uses direct service methods and `QueryRunner` transactions rather than only simple repository calls, so it needed the same real Postgres tenant-isolation contract as site/system/tank/feed flows.

## Enterprise Fix
Add a real PostgreSQL/Testcontainers contract test for the REST `BatchService` path. The test creates matching business keys in two tenants, runs create/allocation/transfer in Tenant A, keeps Tenant B active with its own matching batch/allocation, and proves all reads and table writes remain tenant-local.

## Why The Test Was Added
The test protects the exact failure mode reported during farm-service review: "the row is in the database, but the frontend/API does not show it." It proves transaction-scoped writes are immediately visible through tenant-scoped get/list/status reads and never land in the source `farm` schema.

## Verification
Run:

```bash
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/batch-allocation-tenant-isolation.postgres.spec.ts --runInBand
```

## Status
Implemented and verified with Docker/Testcontainers on 2026-04-29.
