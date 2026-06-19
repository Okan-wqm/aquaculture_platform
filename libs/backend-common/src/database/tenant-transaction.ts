import { DataSource, QueryRunner } from 'typeorm';

import { withTenantContext } from '../context/with-tenant-context';
import { validateTenantSchemaName } from './schema-manager.service';
import { getTenantSchemaName, isValidUUID } from './tenant-schema.utils';

const SOURCE_SCHEMA_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Pin a QueryRunner transaction to one tenant schema.
 *
 * This is the transaction-level counterpart to TenantConnectionBootstrap's
 * pool checkout patch. Checkout routing is necessary but not sufficient for
 * long-lived transaction code: every transactional write should explicitly
 * assert its own `search_path` after `START TRANSACTION`, so a stale pooled
 * session or missing AsyncLocalStorage frame cannot write source-schema data.
 */
export async function pinTenantTransactionSearchPath(
  queryRunner: QueryRunner,
  sourceSchema: string,
  tenantId: string,
): Promise<void> {
  if (!SOURCE_SCHEMA_RE.test(sourceSchema)) {
    throw new Error(
      `pinTenantTransactionSearchPath: invalid source schema "${sourceSchema}"`,
    );
  }
  if (!isValidUUID(tenantId)) {
    throw new Error(
      `pinTenantTransactionSearchPath: invalid tenantId "${tenantId}"`,
    );
  }

  const tenantSchema = getTenantSchemaName(tenantId);
  await pinTenantSchemaTransactionSearchPath(queryRunner, sourceSchema, tenantSchema);
}

export async function pinTenantSchemaTransactionSearchPath(
  queryRunner: QueryRunner,
  sourceSchema: string,
  tenantSchema: string,
): Promise<void> {
  if (!SOURCE_SCHEMA_RE.test(sourceSchema)) {
    throw new Error(
      `pinTenantSchemaTransactionSearchPath: invalid source schema "${sourceSchema}"`,
    );
  }
  validateTenantSchemaName(tenantSchema);

  await queryRunner.query(
    `SELECT pg_catalog.set_config('search_path', $1, true)`,
    [`"${tenantSchema}", "${sourceSchema}", public`],
  );
}

/**
 * Execute a TypeORM QueryRunner transaction inside a fail-closed tenant
 * context and with transaction-local search_path pinning.
 */
export async function runInTenantTransaction<T>(
  dataSource: DataSource,
  sourceSchema: string,
  tenantId: string,
  fn: (queryRunner: QueryRunner) => Promise<T>,
): Promise<T> {
  return withTenantContext(tenantId, async () => {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await pinTenantTransactionSearchPath(queryRunner, sourceSchema, tenantId);
      const result = await fn(queryRunner);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  });
}

/**
 * Execute tenant-scoped reads in an explicit read-only transaction.
 *
 * Request middleware pins pooled sessions, but query handlers also need an
 * explicit boundary so non-HTTP execution paths cannot accidentally read the
 * source schema. A read-only transaction gives `set_config(..., true)` a stable
 * transaction scope and makes accidental writes structurally fail.
 */
export async function runInTenantRead<T>(
  dataSource: DataSource,
  sourceSchema: string,
  tenantId: string,
  fn: (queryRunner: QueryRunner) => Promise<T>,
): Promise<T> {
  return withTenantContext(tenantId, async () => {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      await queryRunner.query('SET TRANSACTION READ ONLY');
      await pinTenantTransactionSearchPath(queryRunner, sourceSchema, tenantId);
      const result = await fn(queryRunner);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  });
}
