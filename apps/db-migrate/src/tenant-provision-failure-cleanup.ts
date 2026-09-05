import { TENANT_SCHEMA_NAME_RE, queryRowsNormalized } from '@aquaculture/backend-common/database';

/**
 * Failed-PROVISION schema cleanup (INFRA-HIGH-150).
 *
 * A tenant replay cannot be one transaction — `CREATE INDEX CONCURRENTLY` and
 * the TimescaleDB steps opt out — so `CREATE SCHEMA` runs autocommit and a
 * per-migration rollback cannot reach it. Until now the failure path collected
 * residue and wrote FAILED evidence and left the schema standing: a namespace
 * that looks like a tenant, holds part of one, and is discovered by NAME on the
 * next deploy (INFRA-CRITICAL-149).
 *
 * The provisioner drops only a schema THIS run created. `CREATE SCHEMA IF NOT
 * EXISTS` hides pre-existence and `assertTenantSchemaIdentityAvailable` asks
 * whether another tenant holds the name, not whether the schema is there — so
 * the caller probes `information_schema.schemata` before creating and passes
 * the answer here. A schema left by an earlier attempt (reachable once a retry
 * re-issues the job, ADMIN-HIGH-009) is not dropped: the ledger-driven fan-out
 * resumes it, and the stamping guard keeps a deploy from sealing it.
 *
 * Diagnosis comes first. `collectFailureResidue` runs before this and its
 * table count is what the live gate read four times; the drop outcome is
 * recorded beside it in the same failure evidence.
 */

export interface TenantSchemaCleanupExecutor {
  query(sql: string, parameters?: readonly unknown[]): Promise<unknown>;
}

export interface FailedProvisionCleanup {
  readonly schemaName: string;
  readonly createdByThisRun: boolean;
  readonly dropped: boolean;
  readonly dropError?: string;
}

function assertTenantSchemaName(schemaName: string): void {
  if (!TENANT_SCHEMA_NAME_RE.test(schemaName)) {
    throw new Error(
      `[tenant-schema-provisioner] Refusing to touch a schema outside the tenant namespace: ${schemaName}`,
    );
  }
}

export async function tenantSchemaExists(
  executor: TenantSchemaCleanupExecutor,
  schemaName: string,
): Promise<boolean> {
  assertTenantSchemaName(schemaName);
  const rows = queryRowsNormalized<{ exists: boolean }>(
    await executor.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
       ) AS exists`,
      [schemaName],
    ),
  );
  return rows[0]?.exists === true;
}

/**
 * Drop the schema a failed PROVISION created — and only that. A drop failure
 * is recorded, not thrown: the original provisioning error is the one the job
 * evidence must carry, and a schema that could not be dropped is exactly what
 * the next deploy's stamping guard exists to hold at bay.
 */
export async function dropSchemaCreatedByFailedProvision(
  executor: TenantSchemaCleanupExecutor,
  args: { schemaName: string; createdByThisRun: boolean },
): Promise<FailedProvisionCleanup> {
  const { schemaName, createdByThisRun } = args;
  assertTenantSchemaName(schemaName);
  if (!createdByThisRun) {
    return { schemaName, createdByThisRun, dropped: false };
  }
  try {
    await executor.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    return { schemaName, createdByThisRun, dropped: true };
  } catch (error: unknown) {
    return {
      schemaName,
      createdByThisRun,
      dropped: false,
      dropError: error instanceof Error ? error.message : String(error),
    };
  }
}
