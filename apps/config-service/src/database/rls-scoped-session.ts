import { RLS_TENANT_GUC, isValidUUID } from '@aquaculture/backend-common/database';
import { DataSource, EntityManager } from 'typeorm';

/**
 * Transaction-local RLS tenant scoping for config-service.
 *
 * WHY this exists: config-service is a GLOBAL-SCHEMA service — every tenant's
 * configuration rows live in `config.configurations` behind a FORCE
 * row-level-security policy that only exposes rows whose tenant_id matches the
 * `app.current_tenant` GUC. `RlsConnectionBootstrap` pins that GUC on pool
 * checkout from the HTTP request context, but two execution paths cannot rely
 * on checkout pinning:
 *
 *   1. A tenantless platform-admin request: SUPER_ADMIN carries no tenant claim
 *      by design (auth-service token-mint C1 invariant), so the request context
 *      has nothing to pin — checkout clears the GUC and the deny-by-default
 *      policy hides every row, including the SYSTEM-tenant platform settings
 *      the request resolved to.
 *   2. The system-fallback half of an effective-configuration read: platform
 *      defaults live under SYSTEM_TENANT_ID and must be readable on behalf of
 *      ANY tenant, but the checkout GUC exposes only the requesting tenant's
 *      partition.
 *
 * The schema-per-tenant helpers (`runInTenantRead` / `runInTenantTransaction`)
 * are NOT usable here: they pin `search_path` to a `tenant_<uuid>` schema and
 * assert that schema exists — no such schema exists for the SYSTEM tenant in a
 * global-schema service.
 *
 * WHAT these helpers do: own the GUC transaction-locally
 * (`set_config(..., is_local = true)`) for the RESOLVED tenant scope on a
 * dedicated QueryRunner, so RLS visibility always matches the scope the
 * resolver decided — fail-closed (an invalid tenant id throws before any query
 * runs) and leak-free (the GUC dies with the transaction, so the pooled session
 * never carries a stale scope into the next request).
 */

/** Narrow query surface so the pin is unit-testable without a live connection. */
export interface RlsScopeQueryExecutor {
  query(query: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * Set `app.current_tenant` transaction-locally to the resolved tenant scope.
 */
export async function pinRlsTenantScope(
  executor: RlsScopeQueryExecutor,
  tenantId: string,
): Promise<void> {
  if (!isValidUUID(tenantId)) {
    throw new Error(`pinRlsTenantScope: invalid tenantId "${tenantId}"`);
  }
  await executor.query(`SELECT set_config($1, $2, true)`, [RLS_TENANT_GUC, tenantId]);
}

/**
 * Run a read-only unit of work with RLS visibility pinned to `tenantId`.
 *
 * READ ONLY makes an accidental write inside a read boundary structurally
 * fail (tier-1: the database rejects it), mirroring `runInTenantRead`.
 */
export async function runInRlsScopedRead<T>(
  dataSource: DataSource,
  tenantId: string,
  fn: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  if (!isValidUUID(tenantId)) {
    throw new Error(`runInRlsScopedRead: invalid tenantId "${tenantId}"`);
  }

  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction('READ COMMITTED');

  try {
    await queryRunner.query('SET TRANSACTION READ ONLY');
    await pinRlsTenantScope(queryRunner, tenantId);
    const result = await fn(queryRunner.manager);
    await queryRunner.commitTransaction();
    return result;
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

/**
 * Run a multi-scope effective-configuration read in one repeatable-read
 * snapshot.
 *
 * A tenant override and the SYSTEM fallback are hidden behind different FORCE
 * RLS scopes. Reading them in two independent transactions creates a race:
 * an override can be inserted between the reads and the stale fallback can
 * then be cached for that tenant. This boundary keeps both statements in one
 * database snapshot while still changing the transaction-local RLS GUC before
 * each partition is inspected.
 */
export async function runInRlsScopedSnapshotRead<T>(
  dataSource: DataSource,
  initialTenantId: string,
  fn: (manager: EntityManager, pinScope: (tenantId: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!isValidUUID(initialTenantId)) {
    throw new Error(`runInRlsScopedSnapshotRead: invalid tenantId "${initialTenantId}"`);
  }

  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction('REPEATABLE READ');

  try {
    await queryRunner.query('SET TRANSACTION READ ONLY');
    const pinScope = async (tenantId: string): Promise<void> => {
      await pinRlsTenantScope(queryRunner, tenantId);
    };
    await pinScope(initialTenantId);
    const result = await fn(queryRunner.manager, pinScope);
    await queryRunner.commitTransaction();
    return result;
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}
