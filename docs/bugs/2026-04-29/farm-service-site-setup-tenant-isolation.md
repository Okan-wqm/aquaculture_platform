# Farm Service Site Setup Tenant Isolation

Date: 2026-04-29

## Problem
Site/setup data is tenant-owned business data. Sites, departments, systems, equipment, tank-like equipment, feed setup, feed inventory, water-quality parameter configs, and Sentinel Hub settings must be written to and read from the active tenant's physical schema. If these rows land in the `farm` source schema or another tenant schema, operators can confirm data in PostgreSQL while frontend/mobile list screens do not show the same records.

## Root Cause
The existing Postgres e2e coverage already protected site, system, tank, feed, inventory, and water-quality cache flows, but it did not cover the full setup chain the user described:

- Department create/update/delete-preview/delete through handlers.
- Equipment create/update/delete/list with `equipment_systems` junction rows.
- Sensor-visible equipment list filtering.
- Tank-like equipment created through the equipment API but physically stored in tenant-local `tanks`.
- Sentinel Hub settings stored and updated through the service.
- Shared tenant schema DDL helper usage instead of local duplicated `CREATE TABLE LIKE` setup.

This left a gap for the class of bugs where tenant data exists in the database but get/list/cache/API paths do not immediately see it.

## Enterprise Fix
Extended `apps/farm-service/src/__tests__/e2e/site-tenant-isolation.postgres.spec.ts` instead of creating a duplicate suite.

Why this approach: the file was already the canonical real-Postgres site/setup tenant-isolation contract. Extending it keeps setup behavior in one place and avoids parallel tests with conflicting schema bootstraps.

Implemented coverage:

- Replaced local tenant-schema DDL with `createTenantSchemaFromSource(...)`.
- Added tenant-local tables to the schema contract: `sub_systems`, `equipment`, `equipment_systems`, and `sentinel_hub_settings`.
- Added source-owned reference table setup for `farm.equipment_types`; this is reference/template data, not tenant business data.
- Added Department handler flow coverage for create, update, get, list, delete preview, delete, source-schema absence, and Tenant A/B isolation.
- Added Equipment handler flow coverage for sensor-visible equipment, system junction rows, update read-after-write, system delete preview, soft delete, source-schema absence, and Tenant A/B isolation.
- Added tank-like Equipment flow coverage proving `EquipmentCategory.TANK` creates rows in tenant-local `tanks`, not tenant-local `equipment` and not source `farm`.
- Added Sentinel Hub settings coverage for save, status, credentials, instance update, delete, source-schema absence, and Tenant A/B isolation.
- Changed the e2e harness to use one shared tank code-generator mock for `CreateTankHandler` and tank-like `CreateEquipmentHandler`.
- Added a separate real-Postgres code-generator concurrency contract in `apps/farm-service/src/__tests__/e2e/code-generator-tenant-sequence.postgres.spec.ts` after the harness issue exposed the need to prove production sequence behavior, not only test mock behavior.

## Why The Code Blocks Were Written
The department test block was written to prove the setup hierarchy starts with handler-created tenant-local departments, not repository-only fixtures. It closes the risk that department rows exist in PostgreSQL but handler-backed list/get paths do not see updates immediately.

The equipment test block was written to prove sensor-visible equipment and its `equipment_systems` junction rows are tenant-local and immediately queryable by list filters. It closes the frontend/mobile symptom where equipment exists in DB but does not appear in setup/sensor screens.

The tank-like equipment test block was written because the equipment API intentionally routes tank categories to the `tanks` table. It closes the risk of expecting tank rows in `equipment` while the UI reads the unified equipment list from both tables.

The Sentinel Hub test block was written to prove per-tenant settings are not shared through the source schema and that update/delete is immediately visible through service reads. It closes the risk of cross-tenant credential visibility or stale settings state.

The shared code-generator harness change was written because the test originally used two separate mock counters and produced duplicate tenant tank codes. That was a test-harness modeling problem, not a production tenant-isolation bug. The corrected harness models the architectural invariant that tenant tank code generation must be a single sequence/source for all tank creation paths.

The separate code-generator e2e block was written because a harness issue must not be dismissed if it points at a production invariant. It proves that the real `CodeGeneratorService` produces tenant-local unique tank codes under concurrent first-use calls.

## Verification
Passed on 2026-04-29:

```bash
npx tsc -p apps/farm-service/tsconfig.spec.json --noEmit
npx jest --config apps/farm-service/jest.config.ts apps/farm-service/src/__tests__/e2e/site-tenant-isolation.postgres.spec.ts --runInBand
```

Target e2e result:

```text
Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total
```

## Status
Implemented and verified on 2026-04-29.
