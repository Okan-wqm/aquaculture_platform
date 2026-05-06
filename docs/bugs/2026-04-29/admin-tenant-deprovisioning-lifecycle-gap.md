# Admin Tenant Deprovisioning Had Backup And Resource Cleanup Stubs

- Date: 2026-04-29
- Affected area: `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts`
- Status: Fixed

## Observed Issue

`deprovisionTenant()` allowed suspended/deactivated tenants to enter the deprovisioning flow, but `backupTenantData()` and `removeTenantResources()` threw `NotImplementedException`.

## Root Cause

The tenant lifecycle service had validation and orchestration, but the backup/resource cleanup steps were placeholders instead of integrated production dependencies.

## Architectural Fix

The service now depends on `BackupRestoreService` and requires a completed full tenant backup before removing auth/admin resources. Business data removal remains schema-owned through `cleanupTenantSchema()`, which drops the tenant schema and updates `admin.tenant_schemas`.

## Verification

- `npx jest --config apps/admin-api-service/jest.config.ts apps/admin-api-service/src/tenant/__tests__/tenant-provisioning.service.spec.ts --runInBand`
