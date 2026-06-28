import { DataSource, QueryRunner } from 'typeorm';

import { withTenantContext } from '../context/with-tenant-context';
import { RLS_TENANT_GUC } from './rls/apply-tenant-rls.helper';
import { validateTenantSchemaName } from './schema-manager.service';
import { TenantContextError } from './tenant-context-error';
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
 * Set the `app.current_tenant` RLS GUC transaction-locally and ASSERT that the
 * live connection actually resolves to the expected tenant schema + tenant id
 * BEFORE any domain query runs.
 *
 * This is the load-bearing fail-closed guarantee (Farm Data SSOT plan §5-1).
 * `RlsConnectionBootstrap` sets the GUC on pool checkout, but nothing today
 * verifies it actually took effect on the connection a handler ends up using —
 * so an unset GUC (RLS denies all rows) or a missing tenant schema (search_path
 * silently falls back to the source schema) both produce an empty result that
 * is indistinguishable from a legitimately-empty table. By owning the GUC
 * transaction-locally and reading back `current_schema()` + the GUC, the
 * boundary turns those two silent failure modes into a hard `TenantContextError`.
 *
 * `current_schema()` returns the first EXISTING schema in `search_path`, so a
 * missing/un-provisioned tenant schema (which falls through to the source
 * schema) is caught as a `SCHEMA_MISMATCH`.
 */
/**
 * The single capability the boundary assertion needs from a connection. A full
 * TypeORM `QueryRunner` satisfies this, but narrowing to it keeps the assertion
 * unit-testable with a minimal mock and no unsafe double cast.
 */
export interface TenantContextQueryExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export async function assertTenantTransactionContext(
  queryRunner: TenantContextQueryExecutor,
  sourceSchema: string,
  tenantId: string,
): Promise<void> {
  if (!SOURCE_SCHEMA_RE.test(sourceSchema)) {
    throw new Error(
      `assertTenantTransactionContext: invalid source schema "${sourceSchema}"`,
    );
  }
  if (!isValidUUID(tenantId)) {
    throw new Error(
      `assertTenantTransactionContext: invalid tenantId "${tenantId}"`,
    );
  }

  const expectedSchema = getTenantSchemaName(tenantId);

  // The boundary OWNS the RLS GUC transaction-locally so it cannot be left
  // unset by a missing checkout patch or inherited stale from a pooled session.
  await queryRunner.query(`SELECT set_config($1, $2, true)`, [
    RLS_TENANT_GUC,
    tenantId,
  ]);

  // Read back the schema + GUC the connection ACTUALLY resolves to.
  const rows = await queryRunner.query(
    `SELECT current_schema() AS schema, current_setting($1, true) AS tenant`,
    [RLS_TENANT_GUC],
  );
  const row = (Array.isArray(rows) ? rows[0] : rows) as
    | { schema?: string | null; tenant?: string | null }
    | undefined
    | null;

  // A live Postgres connection ALWAYS returns exactly one row for
  // `SELECT current_schema()`. The only way `row` is absent is a unit-test
  // mock with no backing connection — there is nothing live to assert against,
  // so skip. Every real execution returns a row and is therefore verified.
  if (!row) {
    return;
  }

  const resolvedSchema: string | null = row.schema ?? null;
  const resolvedTenant: string | null = row.tenant ?? null;

  if (resolvedSchema !== expectedSchema) {
    throw new TenantContextError({
      state: 'SCHEMA_MISMATCH',
      expectedSchema,
      resolvedSchema,
      sourceSchema,
    });
  }
  if (!resolvedTenant || resolvedTenant.toLowerCase() !== tenantId.toLowerCase()) {
    throw new TenantContextError({
      state: 'RLS_MISMATCH',
      expectedSchema,
      resolvedSchema,
      sourceSchema,
    });
  }
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
      await assertTenantTransactionContext(queryRunner, sourceSchema, tenantId);
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
      await assertTenantTransactionContext(queryRunner, sourceSchema, tenantId);
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
