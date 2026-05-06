# Tenant Schema Provisioning Must Not Leave Partial Schemas

- Date: 2026-04-29
- Affected area: `libs/backend-common/src/database/schema-manager.service.ts`
- Status: Fixed

## Observed Issue

`SchemaManagerService.createTenantSchema()` collected table creation, reference data, and migration-history errors but could still leave a partially created tenant schema behind.

## Root Cause

The service treated per-table failures as accumulated errors instead of fatal provisioning failures. That allowed a tenant isolation boundary to exist with missing tables or missing migration history.

## Architectural Fix

Provisioning now fails closed when any table DDL, reference data copy, or migration-history seed step fails. The failure path drops the partial schema and releases the advisory lock.

## Verification

- `npx jest --config libs/backend-common/jest.config.ts libs/backend-common/src/database/__tests__/schema-manager.spec.ts --runInBand`
