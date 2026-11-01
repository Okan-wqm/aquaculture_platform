import {
  MODULE_SCHEMAS,
  RLS_TENANT_GUC,
  queryRowsNormalized,
  validateSqlIdentifier,
} from '@aquaculture/backend-common/database';

/**
 * Tenant route purge for the schema delete job (ADR-047, SENSOR-HIGH-175).
 *
 * A module's `tenantRouteTables` (MODULE_SCHEMAS) live once in its source
 * schema and route an outside identifier — an edge device identifier, a
 * provisioning key, a sensor's broker username — to a tenant by `tenant_id`.
 * DROP SCHEMA fires no row trigger, so dropping a tenant's schema alone would
 * leave its routes behind: a sensor's broker principal would still pass
 * CONNECT for a tenant that no longer exists. The delete job calls this in its
 * transaction, before the drop, so the routes and the schema go together or
 * not at all.
 *
 * `app.current_tenant` names the job's tenant while the purge runs, so the
 * tables' FORCE RLS policy admits exactly that tenant's rows whichever role
 * db-migrate connects as; it is cleared again before the job's own writes. A
 * route table this database does not have yet (its module's migration not
 * applied) holds no rows and is skipped.
 */

export interface TenantRoutePurgeExecutor {
  query(sql: string, parameters?: readonly unknown[]): Promise<unknown>;
}

export interface TenantRoutePurge {
  /** Rows deleted per present route table, keyed `<schema>.<table>`. */
  readonly deleted: Readonly<Record<string, number>>;
  readonly total: number;
}

export async function purgeTenantRoutes(
  executor: TenantRoutePurgeExecutor,
  tenantId: string,
): Promise<TenantRoutePurge> {
  const deleted: Record<string, number> = {};
  let total = 0;
  await executor.query(`SELECT pg_catalog.set_config($1, $2, true)`, [RLS_TENANT_GUC, tenantId]);
  for (const entry of MODULE_SCHEMAS) {
    const schema = validateSqlIdentifier(entry.sourceSchema, 'schema');
    for (const table of entry.tenantRouteTables ?? []) {
      const qualified = `"${schema}"."${validateSqlIdentifier(table, 'table')}"`;
      const [present] = queryRowsNormalized<{ present: boolean }>(
        await executor.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [qualified]),
      );
      if (present?.present !== true) {
        continue;
      }
      const [purged] = queryRowsNormalized<{ count: string }>(
        await executor.query(
          `WITH gone AS (DELETE FROM ${qualified} WHERE tenant_id = $1 RETURNING 1)
           SELECT COUNT(*)::text AS count FROM gone`,
          [tenantId],
        ),
      );
      const count = Number.parseInt(purged?.count ?? '0', 10);
      deleted[`${schema}.${table}`] = count;
      total += count;
    }
  }
  await executor.query(`SELECT pg_catalog.set_config($1, '', true)`, [RLS_TENANT_GUC]);
  return { deleted, total };
}
