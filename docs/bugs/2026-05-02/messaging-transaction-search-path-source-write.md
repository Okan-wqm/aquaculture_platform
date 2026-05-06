# Messaging Transaction Search Path Source Write

Date: 2026-05-02

## Problem

Messaging E2E caught `TENANT_ISOLATION_VIOLATION` on `createChannel`: transactional writes used `DataSource.createQueryRunner()` and relied on request/pool-level tenant routing alone. When the transaction connection was not explicitly pinned, PostgreSQL resolved unqualified `channels` writes through the source schema (`messaging.channels`) instead of the tenant schema.

## Enterprise Fix

Added `runInTenantTransaction()` and `pinTenantTransactionSearchPath()` in backend-common. Transactional tenant business writes now assert `search_path = tenant_<uuid>, messaging, public` inside the transaction with parameterized `set_config(..., true)` before any domain write runs.

`CreateChannelHandler` now uses this helper for DIRECT/GROUP/AI channel creation and persists `tenantId` on `channel_members`.

## Validation

Targeted unit and CI E2E validation must prove:

- Tenant transaction helper pins search_path before work.
- Failed transactional work rolls back and releases the connection.
- `createChannel` no longer writes to `messaging.channels`.
