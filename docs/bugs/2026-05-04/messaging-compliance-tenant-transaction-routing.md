# Messaging Compliance Tenant Transaction Routing

Date: 2026-05-04

## Problem

GitHub Actions `E2E Messaging` caught direct writes to the source `messaging` schema:

```text
TENANT_ISOLATION_VIOLATION: Direct write to source schema messaging.retention_policies blocked.
TENANT_ISOLATION_VIOLATION: Direct write to source schema messaging.legal_holds blocked.
```

The failing paths were compliance mutations:

- `setRetentionPolicy`
- `toggleLegalHold`

## Root Cause

The command handlers used plain `dataSource.transaction(...)`. That created an atomic transaction, but it did not pin the transaction-local PostgreSQL `search_path` to the tenant schema. The services then wrote `retention_policies` and `legal_holds` through the transaction manager while the connection was still routed to the source `messaging` schema.

## Enterprise Fix

The compliance command handlers now use `runInTenantTransaction(dataSource, 'messaging', tenantId, ...)`, which:

- creates an explicit `QueryRunner` transaction,
- pins `search_path` to the tenant schema for the transaction,
- executes policy/hold, audit, and outbox writes in the same tenant-pinned boundary.

Compliance read models for retention policies and legal holds now also read through tenant-pinned transactions where a production `DataSource` is available.

## Why This Is Not a Patch

The fix does not disable `SourceSchemaWriteGuard`, relax tenant isolation, add test-only bypasses, or broaden tenant admin privileges. It aligns compliance code with the same tenant transaction primitive used by messaging command/query paths.

## Validation

- Messaging production typecheck
- Messaging spec typecheck
- Messaging tenant-routing gate
- GitHub Actions `E2E Messaging`

## Follow-Up Watchpoint

The retention cleanup cron still has broader cross-tenant semantics and must continue to be treated as a system worker path: it cannot rely on source-schema repository scans for tenant business rows. Any future retention cleanup work must iterate tenant schemas explicitly through the governed tenant transaction primitive.
