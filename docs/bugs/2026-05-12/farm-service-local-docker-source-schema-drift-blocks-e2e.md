# Farm Service Local Docker Source Schema Drift Blocks E2E

- Date: 2026-05-12
- Status: Fix implemented locally; migrated Postgres E2E verification pending
- Scope: Local Docker Postgres / `farm` source schema

## Problem

Farm E2E now reaches the real AppModule and local Docker Postgres, but the
database source schema does not match the current entity/migration contract.

Historical observed failure:

```text
SchemaDriftValidator[farm] reported 84 violation(s)
QueryFailedError: column "commonName" of relation "species" does not exist
```

The `84` count is a historical local-volume snapshot, not the acceptance
baseline. Each implementation pass must re-run the current drift/migration
checks and close the actual live differences reported at that time.

Representative drift:

```text
farm.species.commonName      entity column missing in DB
farm.species.growthParameters entity column missing in DB
farm.departments.type        entity NOT NULL but DB nullable
farm.equipment.isTank        entity NOT NULL but DB nullable
```

## Impact

- `apps/farm-service/test/*.e2e-spec.ts` cannot seed the reference species.
- Tenant provisioning copies/syncs from a stale source schema, so bypassing the
  source seed would hide the real drift instead of validating the workflow.
- E2E failure is currently environmental/schema state, not the rewritten GraphQL
  contract itself.

## Required Architectural Resolution

- Reconcile the `farm` source schema with the farm-service migration chain
  through forward-only migrations.
- Verify the migration ledger did not mark migrations as applied without the
  matching DDL.
- Run farm E2E only against a migrated source schema, or provision an isolated
  E2E database from migrations before AppModule boot.
- Keep schema drift visible; do not add ad-hoc E2E-only `ALTER TABLE` or
  TypeORM synchronize fallback.
- Make `apps/farm-service/src/database/migrations/manifest.ts` the canonical
  runtime migration list and assert parity with on-disk/db-migrate discovery.
- Keep `SourceSchemaBootstrapService`, `TenantSchemaSyncService`, seed services,
  and E2E helpers free of schema-changing DDL.

## Current Verification Result

```bash
npx nx run farm-service:e2e
```

Result: failed before AppModule boot because this shell does not provide the
explicit `FARM_E2E_DATABASE_*` variables required by the isolated migrated E2E
contract. This is the expected fail-closed behavior; the suite must be run
against a real migrated Postgres database instead of falling back to whatever
state exists in the local Docker volume.

Additional local checks:

```bash
npx tsc -p apps/farm-service/tsconfig.app.json --noEmit
npx tsc -p apps/farm-service/tsconfig.e2e.json --noEmit
npx jest --config tests/invariants/jest.config.ts \
  --runTestsByPath tests/invariants/farm-service-migration-array-completeness.spec.ts \
  --runInBand
```

Result: passed.
