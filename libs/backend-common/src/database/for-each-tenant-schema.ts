import { DataSource, QueryRunner } from 'typeorm';

import {
  listActiveTenantSchemaIdentities,
  listRetainedTenantSchemaIdentities,
  listTenantSchemas,
  type TenantSchemaIdentity,
} from './tenant-schema.utils';

/**
 * Fair, bounded per-tenant-schema iteration for cron/scheduler fan-out
 * (cron-fairness / FARM-MEDIUM-061).
 *
 * Replaces the hand-rolled `for (const schema of schemas) { await … }` loops
 * every per-tenant cron duplicated, which were strictly serial with no
 * concurrency cap, no database statement bound, and a fixed alphabetical
 * order — so one slow tenant serially stalled every later tenant while the
 * last-sorted tenant was perpetually processed last.
 *
 * This SSoT helper owns the correct shape:
 *  - BOUNDED CONCURRENCY: at most `concurrency` tenants in flight (default 4) —
 *    an in-house worker pool, no new dependency. Each tenant gets its OWN
 *    QueryRunner (never shared), so tenant isolation is preserved.
 *  - PER-TENANT TIMEOUT: a cooperative AbortSignal deadline and a DB-side
 *    `SET LOCAL statement_timeout` bound the tenant's dedicated connection.
 *    Timed-out work is drained before rollback/release so it cannot escape on
 *    a recycled connection. Remote providers must observe the signal or own a
 *    stricter transport timeout.
 *  - ERROR ISOLATION: one tenant throwing never aborts the rest; the outcome is
 *    captured per tenant in the returned results.
 *  - ROTATION: the start offset rotates by `rotateBy`, so the tenant served
 *    last changes each run (no perpetual starvation). Order stays deterministic
 *    within a run.
 *  - LIFECYCLE: connect → transaction → SET LOCAL statement_timeout →
 *    transaction-local search_path → handler → commit/rollback → release.
 *
 * The handler receives the tenant's `schema` and a ready `QueryRunner` whose
 * search_path is already set to `"<schema>", <searchPathSuffix>`.
 */
export interface ForEachTenantSchemaOptions {
  /** Max tenants processed concurrently. Keep <= pool headroom. Default 4. */
  concurrency?: number;
  /**
   * Transaction-local PostgreSQL statement timeout, ms. By default it is the
   * smaller of 60_000 and the enabled per-tenant deadline, so an abort-unaware
   * DB statement cannot outlive the advertised handler deadline.
   */
  statementTimeoutMs?: number;
  /** Cooperative per-tenant handler deadline, ms. Default 60_000; 0 disables. */
  perTenantTimeoutMs?: number;
  /** Schemas appended after the tenant schema in search_path. Default 'public'. */
  searchPathSuffix?: string;
  /** Rotates the start offset so the last-served tenant changes each run. */
  rotateBy?: number;
  /** Optional logger for per-tenant failures (defaults to silent). */
  logger?: { warn(msg: string): void; error(msg: string): void };
}

export type TenantSchemaOutcome = 'ok' | 'error' | 'timeout';

export interface TenantSchemaResult {
  schema: string;
  outcome: TenantSchemaOutcome;
  error?: Error;
}

/**
 * Canonical identity supplied to cross-tenant work that must bind a physical
 * schema to the full UUID proven by the db-migrate commit ledger.
 */
export interface VerifiedTenantSchemaContext extends TenantSchemaIdentity {
  queryRunner: QueryRunner;
  /** Aborted when the per-tenant deadline expires. */
  signal: AbortSignal;
}

/** Per-tenant outcome retaining the canonical identity used by the handler. */
export interface VerifiedTenantSchemaResult extends TenantSchemaIdentity {
  outcome: TenantSchemaOutcome;
  error?: Error;
}

interface TenantFanoutTarget {
  schemaName: string;
}

interface TenantFanoutExecutionContext {
  queryRunner: QueryRunner;
  /** Aborted when the per-tenant deadline expires. */
  signal: AbortSignal;
}

type TenantFanoutResult<TTarget extends TenantFanoutTarget> = TTarget & {
  outcome: TenantSchemaOutcome;
  error?: Error;
};

/** Thrown internally when a tenant handler exceeds its deadline. */
export class TenantSchemaTimeoutError extends Error {
  constructor(schema: string, ms: number) {
    super(`Tenant schema ${schema} handler exceeded ${ms}ms timeout`);
    this.name = 'TenantSchemaTimeoutError';
  }
}

function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [];
  const offset = ((by % items.length) + items.length) % items.length;
  return offset === 0 ? [...items] : [...items.slice(offset), ...items.slice(0, offset)];
}

function assertSafeSearchPathSuffix(searchPathSuffix: string): string {
  const parts = searchPathSuffix.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error(`Unsafe search_path suffix: ${searchPathSuffix}`);
  }
  return parts.join(', ');
}

export async function forEachTenantSchema(
  dataSource: DataSource,
  handler: (ctx: {
    schema: string;
    queryRunner: QueryRunner;
    signal: AbortSignal;
  }) => Promise<void>,
  options: ForEachTenantSchemaOptions = {},
): Promise<TenantSchemaResult[]> {
  const targets = (await listTenantSchemas(dataSource)).map((schemaName) => ({ schemaName }));
  const results = await runTenantFanout(
    dataSource,
    targets,
    ({ schemaName, queryRunner, signal }) => handler({ schema: schemaName, queryRunner, signal }),
    options,
  );
  return results.map(({ schemaName, outcome, error }) => ({
    schema: schemaName,
    outcome,
    ...(error === undefined ? {} : { error }),
  }));
}

/**
 * Run bounded work only for canonical active `{schemaName, tenantId}`
 * identities proven by the db-migrate ledger.
 *
 * This is the required fan-out for security-sensitive cross-tenant jobs. It
 * never derives ownership from mutable data inside a physical schema and it
 * deliberately does not enumerate unrelated physical schemas: suspended,
 * migrating and pending-deletion tenants legitimately retain a schema but are
 * not runtime targets. Unregistered physical schemas are a provisioning-ledger
 * reconciliation concern and cannot block or enter this canonical fan-out.
 * The narrow platform function validates that every returned active mapping
 * has both a physical schema and committed provisioning proof.
 */
export async function forEachVerifiedTenantSchema(
  dataSource: DataSource,
  handler: (ctx: VerifiedTenantSchemaContext) => Promise<void>,
  options: ForEachTenantSchemaOptions = {},
): Promise<VerifiedTenantSchemaResult[]> {
  const identities = await listActiveTenantSchemaIdentities(dataSource);
  return runTenantFanout(dataSource, identities, handler, options);
}

/**
 * Run bounded lifecycle work for every committed physical schema that still
 * retains tenant data. Unlike the active-only fan-out, this includes
 * suspended, migrating and pending-deletion tenants so secret scrubbing and
 * retention cannot silently stop when a tenant changes lifecycle state.
 */
export async function forEachVerifiedRetainedTenantSchema(
  dataSource: DataSource,
  handler: (ctx: VerifiedTenantSchemaContext) => Promise<void>,
  options: ForEachTenantSchemaOptions = {},
): Promise<VerifiedTenantSchemaResult[]> {
  const identities = await listRetainedTenantSchemaIdentities(dataSource);
  return runTenantFanout(dataSource, identities, handler, options);
}

async function runTenantFanout<TTarget extends TenantFanoutTarget>(
  dataSource: DataSource,
  unrotatedTargets: readonly TTarget[],
  handler: (ctx: TTarget & TenantFanoutExecutionContext) => Promise<void>,
  options: ForEachTenantSchemaOptions,
): Promise<Array<TenantFanoutResult<TTarget>>> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const perTenantTimeoutMs = options.perTenantTimeoutMs ?? 60_000;
  const statementTimeoutMs =
    options.statementTimeoutMs ??
    (perTenantTimeoutMs > 0 ? Math.min(60_000, perTenantTimeoutMs) : 60_000);
  const searchPathSuffix = assertSafeSearchPathSuffix(options.searchPathSuffix ?? 'public');
  const logger = options.logger;

  const targets = rotate(unrotatedTargets, options.rotateBy ?? 0);
  const results: Array<TenantFanoutResult<TTarget> | undefined> = Array.from(
    { length: targets.length },
    () => undefined,
  );

  async function runOne(target: TTarget, index: number): Promise<void> {
    const schemaName = target.schemaName;
    const queryRunner = dataSource.createQueryRunner();
    const abortController = new AbortController();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      if (statementTimeoutMs > 0) {
        // DB-side kill switch on this tenant's dedicated connection.
        await queryRunner.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      }
      await queryRunner.query(`SELECT pg_catalog.set_config('search_path', $1, true)`, [
        `"${schemaName}", ${searchPathSuffix}`,
      ]);

      let timer: ReturnType<typeof setTimeout> | undefined;
      let deadlineExceeded = false;
      const work = handler({ ...target, queryRunner, signal: abortController.signal });
      if (perTenantTimeoutMs > 0) {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            deadlineExceeded = true;
            abortController.abort();
            reject(new TenantSchemaTimeoutError(schemaName, perTenantTimeoutMs));
          }, perTenantTimeoutMs);
        });
        try {
          await Promise.race([work, deadline]);
        } catch (error) {
          if (deadlineExceeded) {
            await work.catch(() => undefined);
            throw error instanceof TenantSchemaTimeoutError
              ? error
              : new TenantSchemaTimeoutError(schemaName, perTenantTimeoutMs);
          }
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        await work;
      }
      await queryRunner.commitTransaction();
      results[index] = { ...target, outcome: 'ok' };
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction().catch(() => undefined);
      }
      const isTimeout = err instanceof TenantSchemaTimeoutError;
      const error = err instanceof Error ? err : new Error(String(err));
      logger?.error(`action=tenant_schema_fanout outcome=${isTimeout ? 'timeout' : 'error'}`);
      results[index] = {
        ...target,
        outcome: isTimeout ? 'timeout' : 'error',
        error,
      };
    } finally {
      try {
        await queryRunner.release();
      } catch {
        // Connection already broken/released — nothing more to do.
      }
    }
  }

  // In-house bounded worker pool: `concurrency` workers pull indices off a
  // shared cursor until the list is drained.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (cursor < targets.length) {
      const index = cursor++;
      const target = targets[index];
      if (target === undefined) continue; // unreachable; satisfies noUncheckedIndexedAccess
      await runOne(target, index);
    }
  });
  await Promise.all(workers);

  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Tenant fan-out produced no result for target index ${index}`);
    }
    return result;
  });
}
