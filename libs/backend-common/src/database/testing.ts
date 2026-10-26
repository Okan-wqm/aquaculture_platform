/**
 * Test-only stage helpers for real-Postgres specs that must run under the
 * production row security (`@aquaculture/backend-common/database/testing`).
 *
 * WHY one home: every service's `*.rls.postgres.spec.ts` stage needs the same
 * two production behaviours — FORCE RLS armed by the platform helper under
 * db-migrate's DDL authority, and the least-privilege tenant↔schema mapping the
 * cross-tenant workers read. Each service harness used to carry its own copy,
 * and each copy was a place for the stage to drift from the provisioner.
 * Specs that only need a stage import these; production code never does.
 */
import type { DataSource } from 'typeorm';

import { applyTenantRlsToSchema } from './rls/apply-tenant-rls.helper';
import { getTenantSchemaName } from './tenant-schema.utils';

/** Arm FORCE RLS with the platform helper under db-migrate's DDL authority. */
export async function armTenantRls(
  admin: DataSource,
  options: { schemaOverride: string; includeTables?: readonly string[] },
): Promise<void> {
  const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
  process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
  const qr = admin.createQueryRunner();
  try {
    await applyTenantRlsToSchema(qr, options);
  } finally {
    await qr.release();
    if (previousDdlAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
    else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
  }
}

/**
 * (Re)define the mapping behind one of the two platform ledger functions.
 * `retained` lists every tenant that still holds data (suspended, migrating,
 * pending deletion included); `active` only the tenants the platform serves.
 */
async function publishTenantMappings(
  executor: Pick<DataSource, 'query'>,
  fn: 'list_active_tenant_schema_mappings' | 'list_retained_tenant_schema_mappings',
  tenants: readonly string[],
): Promise<void> {
  const rows = tenants.map(
    (tenantId) =>
      `SELECT '${getTenantSchemaName(tenantId)}'::text, '${tenantId}'::uuid, true, true`,
  );
  // No tenant is an empty result, not an empty VALUES list.
  const body =
    rows.length > 0
      ? rows.join('\n      UNION ALL ')
      : 'SELECT NULL::text, NULL::uuid, true, true WHERE false';
  await executor.query(`
    CREATE OR REPLACE FUNCTION platform.${fn}()
    RETURNS TABLE (schema_name text, tenant_id uuid, schema_exists boolean, committed_proof boolean)
    LANGUAGE sql STABLE AS $fn$
      ${body}
    $fn$`);
}

/**
 * (Re)define the active tenant↔schema mapping a stage serves. In production the
 * function reads the admin.tenant_schemas ledger; here it lists the active
 * tenants directly, and CREATE OR REPLACE keeps a runtime role's EXECUTE grant
 * across a redefinition. The `platform` schema must exist.
 */
export async function publishActiveTenantMappings(
  executor: Pick<DataSource, 'query'>,
  tenants: readonly string[],
): Promise<void> {
  await publishTenantMappings(executor, 'list_active_tenant_schema_mappings', tenants);
}

/** The retained ledger: the same shape as the active one, for retention/erasure work. */
export async function publishRetainedTenantMappings(
  executor: Pick<DataSource, 'query'>,
  tenants: readonly string[],
): Promise<void> {
  await publishTenantMappings(executor, 'list_retained_tenant_schema_mappings', tenants);
}
