# Tenant Provisioning Module Resolution Must Fail Closed

Date: 2026-04-29

## Problem

Tenant provisioning could fall back to all default modules when assigned module
resolution failed. That is unsafe at enterprise scale because a tenant whose
module assignment is broken can still receive a broad all-module schema.

## Root Fix

Schema creation now rejects empty or unknown requested module sets before any
DDL lock/schema creation. Tenant provisioning still uses platform defaults only
when no modules were assigned by design; database errors while resolving modules
now fail the provisioning saga instead of silently widening scope.

Create-tenant module assignment also throws on failed module assignment rather
than logging and continuing.

## Verification

- `libs/backend-common/src/database/__tests__/schema-manager.spec.ts`
- `apps/admin-api-service/src/tenant/__tests__/tenant-provisioning.service.spec.ts`
- `e2e/tests/integration/schema-provisioning.spec.ts`
