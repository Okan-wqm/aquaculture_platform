# Admin Topology RLS Columnstore Deploy Contract

## Failure

Main deploy for merge commit `9ea4f0961552df34e6593b9316fea34514820363`
failed in `deploy / deploy` while running `aqua-db-migrate`.

The failing migration was:

- `apps/admin-api-service/src/migrations/1800500000000-TenantProvisioningTopology.ts`
- Runtime migration name: `TenantProvisioningTopology1800500000000`

PostgreSQL rejected RLS DDL with:

```text
operation not supported on hypertables that have columnstore enabled
```

## Root Cause

`TenantProvisioningTopology1800500000000` had an embedded PL/pgSQL copy of
the platform tenant RLS policy installer. That bypassed the shared
`applyTenantRlsToSchema` contract, so the admin topology migration did not
inherit the TimescaleDB columnstore/compression guard added for tenant schemas.

The failure was architectural drift: the canonical RLS policy existed in one
helper, while admin topology convergence maintained a second implementation.

## Architecture Decision

Admin topology convergence remains responsible for tenant table fan-out,
grants, and auth-role clone cleanup. It no longer owns RLS policy SQL.

After topology convergence, the migration now:

1. Discovers active tenant schemas from `admin.tenant_schemas`.
2. Discovers the curated source topology table set from service schemas.
3. Calls `applyTenantRlsToSchema` with `schemaOverride` and `includeTables`.

This routes tenant RLS through the shared helper so the following contracts are
single-source:

- canonical `tenant_isolation_policy` predicate
- UUID tenant-column validation
- identity primitive skips
- TimescaleDB columnstore/compressed hypertable skip for tenant schemas
- audit-grade logging of applied/skipped tables

## Validation Contract

The migration test asserts that admin topology no longer emits raw
`ENABLE ROW LEVEL SECURITY` or `CREATE POLICY tenant_isolation_policy` SQL, and
that it delegates to `applyTenantRlsToSchema` with an explicit tenant schema and
curated `includeTables` allow-list.

No JavaScript implementation, `any`, lint suppression, or postponed follow-up is
part of this fix.
