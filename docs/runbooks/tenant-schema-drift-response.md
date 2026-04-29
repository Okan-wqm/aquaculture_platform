# Tenant Schema Drift Response

**Audience:** on-call SRE / platform engineer who sees `Tenant schema drift detected` WARN logs from any service.

**Triggering signal:** `TenantSchemaSyncService` emits a structured WARN line at boot listing missing tables / columns per tenant schema. In strict mode (`STRICT_TENANT_SCHEMA_DRIFT=true`) the same condition fails boot.

## What "drift" means here

A tenant schema (`tenant_<16hex>`) is missing one or more tables or columns that exist on the source schema (`farm`, `sensor`, `hr`, `messaging`, ...). Drift accumulates when:

- A new entity column is added to a service's source-schema entity but no per-tenant migration is authored.
- A new entity table is added to `MODULE_SCHEMAS[<service>].tables` but no per-tenant migration is authored.
- A migration runs against the source schema but the tenant fan-out leg is missed.

## Why the service no longer auto-fixes drift

The pre-2026-04-28 implementation of `TenantSchemaSyncService` ran `CREATE TABLE ... LIKE source INCLUDING ALL` and `ALTER TABLE ... ADD COLUMN ...` from `OnApplicationBootstrap` to silently fix drift. Two architectural defects meant that path is forbidden:

- **ADR-011 + ADR-012 violation** — DDL outside the migration ledger. No version row, no rollback, invisible in `git log` and `pg_migrations`. Same shape as the `synchronize: true` antipattern. (DATA-CRITICAL-002.)
- **Legal-hold registry bypass** — the canonical hold registry was never consulted; tenants under litigation hold could silently get DDL applied. (LEGAL-HIGH-004.)

Removing the auto-fix path closes both findings architecturally — legal hold can never be bypassed by code that does not exist.

## Authoring a per-tenant migration

1. Identify the service that owns the source schema with drift. Source schemas are 1:1 with services: `farm` → `farm-service`, `sensor` → `sensor-service`, etc.
2. Create a migration in the owning service's `apps/<svc>/src/database/migrations/` directory using the standard timestamp prefix.
3. Inside the migration `up()`:
   - Load tenant schemas via the helper:
     ```ts
     import { listTenantSchemas } from '@aquaculture/backend-common/database';
     const tenants = await listTenantSchemas(queryRunner.connection);
     ```
   - Iterate per-tenant inside the same `QueryRunner`. Validate every interpolated identifier with `validateSqlIdentifier()` from the same barrel before injecting into raw SQL.
   - Consult the legal-hold registry per-tenant:
     ```ts
     import { LegalHoldService } from '@aquaculture/backend-common/compliance';
     // skip held tenants — surface an error in the migration log so the
     // operator knows to come back when the hold lifts
     ```
   - Issue the DDL inside `queryRunner.query(...)`. CONCURRENTLY-required indexes need `transaction = 'none'` on the migration class (see `migration-sql-lint` rule R3).
4. `down()` should reverse the per-tenant change in the same fan-out shape.
5. Register the migration class in the owning service's `app.module.ts` `migrations: [...]` array.
6. Run `npm run build:libs && nx test <svc> --testPathPatterns=migrations`.

## When to use STRICT_TENANT_SCHEMA_DRIFT=true

Set this env var on **production** (and any environment where a missed migration would cause a 500 on the tenant request path). It causes any drift detected at boot to fail the service, which:

- Triggers the deploy-asserter rollback path
- Surfaces the missing migration before tenant requests hit the missing column
- Forces operators to author the migration before the next deploy

Leave it OFF in dev/CI so partially-authored migrations don't block local iteration.

## Diagnostic commands

```bash
# What schemas exist on this database?
psql $DATABASE_URL -c "
  SELECT schema_name FROM information_schema.schemata
  WHERE schema_name ~ '^tenant_[a-f0-9]{16}$' ORDER BY schema_name"

# What columns does the source schema have for table X?
psql $DATABASE_URL -c "
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_schema = '<source>' AND table_name = '<table>'"

# What columns does tenant schema Y have for the same table?
psql $DATABASE_URL -c "
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_schema = 'tenant_<16hex>' AND table_name = '<table>'"

# Diff source vs one tenant — operator-friendly EXCEPT query
psql $DATABASE_URL -c "
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='<source>' AND table_name='<table>'
  EXCEPT
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='tenant_<16hex>' AND table_name='<table>'"
```

## Related

- ADR-011 (schema ownership)
- ADR-012 (schema drift prevention)
- `docs/runbooks/schema-drift-response.md` (sibling runbook for source-schema drift)
- DATA-CRITICAL-002, LEGAL-HIGH-004 (closing review findings)
