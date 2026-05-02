# Farm Service Cull Legacy Tank Lookup

Date: 2026-04-29

## Problem
`RecordCullHandler` rejected valid tank IDs for tenants whose production tanks still exist in the legacy `tanks` table. Mortality already supported both `equipment` and `tanks`, but cull only queried `equipment`.

## Root Cause
The handler performed a direct `Equipment` lookup inside the transaction. That created an inconsistent stock-operation model: mortality could update legacy tenant tanks, while cull failed with `Tank ... bulunamadı` for the same tenant/tank shape. This is an enterprise data visibility risk because existing tenant data may be physically correct in its tenant schema but unreachable by one operation path.

## Enterprise Fix
Updated `apps/farm-service/src/batch/handlers/record-cull.handler.ts` to use the same unified tank/equipment lookup as mortality. The handler now:

- Resolves tank IDs through `findTankOrEquipmentWithManager`.
- Supports both new `equipment` rows and legacy `tanks` rows.
- Persists count/biomass updates back to the physical table where the tank was found.
- Uses transaction-scoped `pessimistic_write` locking for the resolved tank/equipment row.
- Keeps the existing transaction and outbox semantics.

## Why The Code Was Written
This is not a compatibility patch around the test. The platform currently has both `equipment` and legacy `tanks` table paths, and stock operations must be consistent until the domain model is fully converged. A cull operation cannot use a narrower tank source than mortality.

## Verification
Passed on 2026-04-29:

```bash
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/batch/__tests__/handlers/record-cull.handler.spec.ts apps/farm-service/src/__tests__/e2e/mortality-cull-harvest-tenant-isolation.postgres.spec.ts --runInBand
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/mortality-cull-harvest-tenant-isolation.postgres.spec.ts --runInBand
```

## Status
Implemented and verified on 2026-04-29.
