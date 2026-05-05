# Farm Service Code Generator Tenant Sequence Concurrency

Date: 2026-04-29

## Problem
Tank creation can happen through more than one domain path: direct tank creation and tank-like equipment creation. Both paths must draw from the same tenant-local tank code sequence. Duplicate generated tank codes would block creation or, worse, make setup data inconsistent across frontend/backend/database views.

## Root Cause
The site/setup e2e harness initially used two independent mock code-generator counters, one for `CreateTankHandler` and one for tank-like `CreateEquipmentHandler`. That exposed a modeling gap in the test harness.

While investigating the harness issue, the production `CodeGeneratorService.generateCode` also showed a real concurrency weakness: it used `findOne(... pessimistic_write)` and then inserted a new `code_sequences` row when none existed. A pessimistic row lock cannot lock a row that does not exist, so concurrent first-use calls for the same tenant/entity/year could race on insert and surface a unique-constraint failure.

## Enterprise Fix
Changed `CodeGeneratorService.generateCode` to use one atomic PostgreSQL statement:

```sql
INSERT INTO code_sequences (...)
VALUES (...)
ON CONFLICT (tenant, entity, year)
DO UPDATE SET last_sequence = last_sequence + 1
RETURNING last_sequence
```

The implementation derives table/column names from TypeORM metadata, validates tenant UUIDs before deriving schema names, sets `search_path` to the tenant schema inside the transaction, and commits only after the database returns the incremented sequence.

## Why The Code Blocks Were Written
The atomic upsert code block was written because `findOne + insert` is not a safe enterprise sequence generator under concurrent first-use load. It closes the duplicate-code/unique-violation risk across direct tank creation and tank-like equipment creation.

The updated unit tests were written to enforce valid UUID tenant IDs, rollback behavior, entity-specific prefixes, and use of an atomic conflict-handling SQL path.

The new real Postgres e2e test was written because concurrency behavior cannot be proven by mocks alone. It runs 10 concurrent `generateTankCode` calls for the same tenant and verifies unique sequential codes plus physical tenant-schema placement.

## Verification
Passed on 2026-04-29:

```bash
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/database/__tests__/code-generator.service.spec.ts --runInBand
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/code-generator-tenant-sequence.postgres.spec.ts --runInBand
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/site-tenant-isolation.postgres.spec.ts --runInBand
```

Target e2e result:

```text
code-generator-tenant-sequence.postgres.spec.ts: 2 passed
site-tenant-isolation.postgres.spec.ts: 13 passed
```

## Status
Implemented and verified on 2026-04-29.
