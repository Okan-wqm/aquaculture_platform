# Hydroponics Tenant Schema Routing And Delete Contract

- Date: 2026-04-29
- Affected area: `apps/hydroponics-service/src/setup`, `e2e/tests/modules/hydroponics`
- Status: Fixed

## Observed Issue

The hydroponics E2E contract test exposed two problems:

- `HydroponicsConfig` pinned `@Entity('hydroponics_config', { schema: 'hydroponics' })`.
- `deleteHydroponicsConfiguration` returned `NotFoundException` for a missing tenant-scoped row even though the API contract is Boolean/idempotent delete.

## Root Cause

The entity-level schema option bypassed the platform tenant-routing model. The TypeORM factory intentionally does not set a global `schema`; per-request tenant routing is handled through `search_path` and `TenantConnectionBootstrap`. A hardcoded entity schema would force reads/writes into the source module schema instead of the tenant schema.

The delete behavior drifted while ownership checks were added. The new guard path first loaded the row for ownership validation, but the not-found branch changed the public Boolean delete contract.

## Architectural Fix

`HydroponicsConfig` no longer declares a hardcoded schema. It relies on the same tenant search_path routing model as other tenant-owned business entities.

`deleteHydroponicsConfiguration` now remains tenant-scoped and idempotent: missing rows return `false`, while existing rows still enforce manager/admin or creator ownership rules before deletion.

The E2E direct resolver harness now passes a `CurrentUserPayload` to delete calls, matching the production resolver signature instead of bypassing the ownership contract.

## Verification

- `npx tsc -p apps/hydroponics-service/tsconfig.spec.json --noEmit` passes.
- `npx jest --config apps/hydroponics-service/jest.config.ts apps/hydroponics-service/src/setup/entities/__tests__/hydroponics-config.entity.spec.ts apps/hydroponics-service/src/setup/resolvers/__tests__/setup.resolver.spec.ts --runInBand` passes 18 tests.
- `npx jest --config jest.config.ts tests/modules/hydroponics/hydroponics-config.spec.ts --runInBand` from `e2e/` passes 17 tests.
