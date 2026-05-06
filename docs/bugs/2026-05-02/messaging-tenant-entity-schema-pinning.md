# Messaging tenant entity schema pinning

Date: 2026-05-02

## Problem

Messaging E2E failed with `TENANT_ISOLATION_VIOLATION` on direct writes to
`messaging.channels` and `messaging.compliance_audit_log`.

## Impact

Tenant business writes could be routed to the messaging source schema instead
of the physical tenant schema. That violates the platform invariant that tenant
business data lives inside the tenant's own schema and is immediately readable
through the same tenant-scoped service path.

## Root Cause

Tenant business entities declared `@Entity(..., { schema: 'messaging' })`.
That explicit schema qualification bypassed the service's intended
`TenantConnectionBootstrap` routing, where every request checkout pins
`search_path` to `tenant_<id>, messaging, public`.

## Fix

Tenant business entities now omit entity-level schema. TypeORM emits
unqualified table names, so PostgreSQL resolves reads and writes through the
tenant-scoped `search_path`.

Only source-owned infrastructure/reference tables remain schema-pinned:

- `messaging_outbox`
- `embeddings_metadata`

A CI gate now scans messaging entity files and fails if another tenant
business entity pins `schema: 'messaging'`.

## Verification

Run `npm run gates:messaging-tenant-routing`. Messaging E2E should no longer
fail on source-schema write guard violations for channel/compliance tenant
business writes.
