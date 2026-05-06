# Messaging Outbox Source Write Guard Contract

Date: 2026-05-02

## Problem

After channel domain writes were moved into tenant-pinned transactions, E2E exposed the next blocked write: `messaging.messaging_outbox`. The outbox entity is intentionally source-schema pinned and the worker reads it as a service infrastructure queue, but `SourceSchemaWriteGuardService` protected it like tenant business data because `MODULE_SCHEMAS.messaging.tables` listed it as a normal tenant table.

That made the declared architecture contradictory: source-owned outbox entity plus source-write guard that forbids source writes.

## Enterprise Fix

`messaging_outbox` and `embeddings_metadata` are now declared as `infrastructureTables` for the messaging module. `SourceSchemaWriteGuardService` excludes both reference and infrastructure tables from tenant-business source-write triggers.

Tenant business tables remain protected; infrastructure tables are explicitly declared instead of bypassed ad hoc.

## Validation

E2E must prove `createChannel` can persist its domain row and enqueue its outbox event atomically without writing tenant business tables into the source schema.
