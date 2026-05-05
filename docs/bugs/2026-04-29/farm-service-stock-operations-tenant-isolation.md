# Farm Service Stock Operations Tenant Isolation

Date: 2026-04-29

## Problem
Mortality, cull, and harvest are tenant-owned business operations. Their rows must live inside the active tenant schema, not in the `farm` source/template schema and not in another tenant schema. If these transactional writes land in the wrong physical schema, operators can see the data directly in the database while frontend/mobile tenant reads cannot see the same data.

## Root Cause
The existing coverage did not prove the full stock-operation contract on real Postgres schemas. Mortality, cull, and harvest update multiple tables in QueryRunner transactions: `batches_v2`, `tank_batches`, `tanks`, `tank_operations`, `mortality_records`, `harvest_records`, plus outbox events. Mock tests could not prove physical schema placement or read-after-write visibility.

## Enterprise Fix
Added `apps/farm-service/src/__tests__/e2e/mortality-cull-harvest-tenant-isolation.postgres.spec.ts` and shared harness helpers in `apps/farm-service/src/__tests__/e2e/helpers/tenant-schema-harness.ts`.

The test creates Tenant A and Tenant B schemas, executes stock operations with matching business shapes, and verifies:

- Tenant business rows exist only in the active tenant schema.
- The `farm` source schema contains no Tenant A business rows for `batches_v2`, `tank_batches`, `tank_operations`, `mortality_records`, or `harvest_records`.
- Tenant B cannot read Tenant A harvest records even when IDs are used as filters.
- Mortality, cull, and harvest changes are immediately visible through tenant-scoped repositories and list queries.
- Batch, tank batch, and tank counts/biomass stay consistent after create and harvest cancel.
- Mortality and cull resolve tank/equipment rows under transaction-scoped write locks.
- Outbox events are tenant-stamped and emitted for the correct tenant.

## Why The Code Was Written
The shared e2e harness exists to avoid duplicate ad-hoc DDL in every Postgres test while preserving the production source-template model. The stock-operation test exists because tenant isolation is a physical schema invariant, not only a `tenantId` filter invariant.

## Verification
Passed on 2026-04-29:

```bash
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/batch/__tests__/handlers/record-cull.handler.spec.ts apps/farm-service/src/__tests__/e2e/mortality-cull-harvest-tenant-isolation.postgres.spec.ts --runInBand
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/mortality-cull-harvest-tenant-isolation.postgres.spec.ts --runInBand
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/mortality-cull-harvest-tenant-isolation.postgres.spec.ts apps/farm-service/src/__tests__/e2e/feeding-record-tenant-isolation.postgres.spec.ts apps/farm-service/src/__tests__/e2e/batch-allocation-tenant-isolation.postgres.spec.ts apps/farm-service/src/__tests__/e2e/graphql-loader-tenant-source.architecture.spec.ts apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts --runInBand
```

## Status
Implemented and verified on 2026-04-29.
