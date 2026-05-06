# Tenant Data Migration Fallback Must Not Hide Real Insert Errors

- Date: 2026-04-29
- Affected area: `libs/backend-common/src/database/schema-manager.service.ts`
- Status: Fixed

## Observed Issue

`migrateDataToTenantSchema()` retried every failed `tenant_id` migration query with legacy `"tenantId"`, even when the first failure was not a missing-column error.

## Root Cause

The fallback catch block was too broad. Real DB failures could be converted into a second, unrelated query path and produce misleading errors.

## Architectural Fix

The service now falls back to `"tenantId"` only when PostgreSQL reports undefined column (`42703`) or the equivalent missing `tenant_id` message. Other insert failures are returned directly.

## Verification

- `npx jest --config libs/backend-common/jest.config.ts libs/backend-common/src/database/__tests__/schema-manager.spec.ts --runInBand`
