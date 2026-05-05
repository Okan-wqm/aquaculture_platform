# Tenant Schema Sync Strict Gate

Date: 2026-04-29

## Problem

`TenantSchemaSyncService` reported tenant schema sync errors but allowed the
service to boot. In schema-per-tenant architecture, a service that starts after
failed tenant DDL sync can serve stale tenant tables while the source schema is
newer.

## Root Fix

Added `TENANT_SCHEMA_SYNC_STRICT=true` support. In strict mode, sync errors and
unexpected sync exceptions fail application bootstrap instead of being treated as
non-fatal logs.

This keeps local legacy environments observable while giving deployment and E2E
gates a hard fail boundary.

## Verification

- `libs/backend-common/src/database/__tests__/tenant-schema-sync.service.spec.ts`
