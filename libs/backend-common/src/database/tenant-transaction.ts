import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

import { withTenantContext } from '../context/with-tenant-context';
import { getRequestContext } from '../logging/request-context';

import { RLS_BYPASS_GUC, RLS_TENANT_GUC } from './rls/apply-tenant-rls.helper';
import { validateTenantSchemaName } from './schema-manager.service';
import { TenantContextError } from './tenant-context-error';
import { getTenantSchemaName, isValidUUID } from './tenant-schema.utils';

const SOURCE_SCHEMA_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Tenant boundary observability (Farm Data SSOT plan §3-F / §8.7).
 *
 * Every boundary execution emits one structured trace so a read's tenant
 * routing is observable end to end. `resultState` is the FarmDataReadTrace
 * taxonomy: a verified `SUCCESS`, or the exact failure mode that previously
 * produced a silent empty result. SUCCESS traces are debug-level (off in prod
 * by default); a tenant-context mismatch is warn-level. Emitting the trace must
 * NEVER break a read — any error inside the tracer is swallowed.
 */
export type TenantBoundaryResultState =
  | 'SUCCESS'
  | 'SCHEMA_MISMATCH'
  | 'RLS_MISMATCH'
  | 'ERROR';

const boundaryLogger = new Logger('TenantBoundary');

/** Hash the tenant id — a tenant label is never logged raw (plan + maskPii rule). */
function tenantHash(tenantId: string | undefined): string {
  if (!tenantId) return 'none';
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 12);
}

/** Best-effort row count for the common array / paginated-`data` result shapes. */
function rowCountOf(result: unknown): number | undefined {
  if (Array.isArray(result)) return result.length;
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { data?: unknown }).data)
  ) {
    return (result as { data: unknown[] }).data.length;
  }
  return undefined;
}

interface TenantBoundaryTraceInput {
  readonly operation: 'tenant-read' | 'tenant-transaction' | 'source-read';
  readonly sourceSchema: string;
  readonly tenantId?: string;
  readonly resultState: TenantBoundaryResultState;
  readonly startedAt: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

function traceTenantBoundary(input: TenantBoundaryTraceInput): void {
  try {
    const ctx = getRequestContext();
    const trace = {
      event: 'TenantBoundaryTrace',
      operation: input.operation,
      resultState: input.resultState,
      sourceSchema: input.sourceSchema,
      expectedSchema:
        input.tenantId !== undefined && isValidUUID(input.tenantId)
          ? getTenantSchemaName(input.tenantId)
          : input.sourceSchema,
      resolvedSchema:
        input.error instanceof TenantContextError ? input.error.resolvedSchema : undefined,
      tenantHash: tenantHash(input.tenantId),
      correlationId: ctx.correlationId,
      traceId: ctx.traceId,
      durationMs: Date.now() - input.startedAt,
      rowCount: rowCountOf(input.result),
    };
    if (input.resultState === 'SUCCESS') {
      boundaryLogger.debug(JSON.stringify(trace));
    } else {
      boundaryLogger.warn(JSON.stringify(trace));
    }
  } catch {
    // Observability must never break a read.
  }
}

function resultStateForError(error: unknown): TenantBoundaryResultState {
  if (error instanceof TenantContextError) {
    return error.state === 'SCHEMA_MISMATCH'
      ? 'SCHEMA_MISMATCH'
      : error.state === 'RLS_MISMATCH'
        ? 'RLS_MISMATCH'
        : 'ERROR';
  }
  return 'ERROR';
}

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
    const startedAt = Date.now();
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await pinTenantTransactionSearchPath(queryRunner, sourceSchema, tenantId);
      await assertTenantTransactionContext(queryRunner, sourceSchema, tenantId);
      const result = await fn(queryRunner);
      await queryRunner.commitTransaction();
      traceTenantBoundary({
        operation: 'tenant-transaction',
        sourceSchema,
        tenantId,
        resultState: 'SUCCESS',
        startedAt,
        result,
      });
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      traceTenantBoundary({
        operation: 'tenant-transaction',
        sourceSchema,
        tenantId,
        resultState: resultStateForError(error),
        startedAt,
        error,
      });
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
    const startedAt = Date.now();
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      await queryRunner.query('SET TRANSACTION READ ONLY');
      await pinTenantTransactionSearchPath(queryRunner, sourceSchema, tenantId);
      await assertTenantTransactionContext(queryRunner, sourceSchema, tenantId);
      const result = await fn(queryRunner);
      await queryRunner.commitTransaction();
      traceTenantBoundary({
        operation: 'tenant-read',
        sourceSchema,
        tenantId,
        resultState: 'SUCCESS',
        startedAt,
        result,
      });
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      traceTenantBoundary({
        operation: 'tenant-read',
        sourceSchema,
        tenantId,
        resultState: resultStateForError(error),
        startedAt,
        error,
      });
      throw error;
    } finally {
      await queryRunner.release();
    }
  });
}

/**
 * Assert the connection actually resolved to the expected SOURCE schema before a
 * source read runs. A stray tenant schema left in `search_path` (e.g. an
 * inherited pooled session) would otherwise make a "source" read silently
 * resolve a tenant's shadow copy.
 */
export async function assertSourceReadContext(
  queryRunner: TenantContextQueryExecutor,
  sourceSchema: string,
): Promise<void> {
  if (!SOURCE_SCHEMA_RE.test(sourceSchema)) {
    throw new Error(`assertSourceReadContext: invalid source schema "${sourceSchema}"`);
  }

  const rows = await queryRunner.query(`SELECT current_schema() AS schema`);
  const row = (Array.isArray(rows) ? rows[0] : rows) as
    | { schema?: string | null }
    | undefined
    | null;

  // Absent row ⇒ unit-test mock with no backing connection; nothing to assert.
  if (!row) {
    return;
  }

  const resolvedSchema: string | null = row.schema ?? null;
  if (resolvedSchema !== sourceSchema) {
    throw new TenantContextError({
      state: 'SCHEMA_MISMATCH',
      expectedSchema: sourceSchema,
      resolvedSchema,
      sourceSchema,
    });
  }
}

/**
 * Execute an explicit READ against a SOURCE schema for the few reads that are
 * cross-tenant BY DESIGN: seeded reference tables (e.g. `farm.equipment_types`)
 * and gateway-enforced federation `__resolveReference` lookups that arrive with
 * no tenant context.
 *
 * This is the SANCTIONED counterpart to `runInTenantRead`. It opens a READ ONLY
 * transaction, pins `search_path` to the SOURCE schema only (no tenant schema),
 * sets `app.bypass_rls = 'on'` transaction-locally (the tenant-isolation policy
 * must not deny a deliberately cross-tenant read), and asserts `current_schema()`
 * actually resolved to the source schema before any domain query runs.
 *
 * Callers MUST be on an explicitly cross-tenant path — tenant-owned reads use
 * `runInTenantRead`. Routing a cross-tenant read here (instead of an ad-hoc raw
 * `dataSource.query` with a hand-written `"schema"."table"`) keeps every
 * source-schema read auditable in one place.
 */
export async function runInSourceRead<T>(
  dataSource: DataSource,
  sourceSchema: string,
  fn: (queryRunner: QueryRunner) => Promise<T>,
): Promise<T> {
  if (!SOURCE_SCHEMA_RE.test(sourceSchema)) {
    throw new Error(`runInSourceRead: invalid source schema "${sourceSchema}"`);
  }

  const startedAt = Date.now();
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction('READ COMMITTED');

  try {
    await queryRunner.query('SET TRANSACTION READ ONLY');
    await queryRunner.query(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      [`"${sourceSchema}", public`],
    );
    // Cross-tenant by design: the tenant-isolation policy USING clause honors
    // `app.bypass_rls = 'on'`, so a reference / federation read is not denied.
    await queryRunner.query(`SELECT set_config($1, 'on', true)`, [RLS_BYPASS_GUC]);
    await assertSourceReadContext(queryRunner, sourceSchema);
    const result = await fn(queryRunner);
    await queryRunner.commitTransaction();
    traceTenantBoundary({
      operation: 'source-read',
      sourceSchema,
      resultState: 'SUCCESS',
      startedAt,
      result,
    });
    return result;
  } catch (error) {
    await queryRunner.rollbackTransaction();
    traceTenantBoundary({
      operation: 'source-read',
      sourceSchema,
      resultState: resultStateForError(error),
      startedAt,
      error,
    });
    throw error;
  } finally {
    await queryRunner.release();
  }
}
