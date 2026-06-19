import { DataSource, QueryRunner } from 'typeorm';

import { listTenantSchemas } from './tenant-schema.utils';

/**
 * Fair, bounded per-tenant-schema iteration for cron/scheduler fan-out
 * (cron-fairness / FARM-MEDIUM-061).
 *
 * Replaces the hand-rolled `for (const schema of schemas) { await … }` loops
 * every per-tenant cron duplicated, which were strictly serial with no
 * concurrency cap, no per-tenant timeout, and a fixed alphabetical order — so
 * one slow/hanging tenant serially stalled every later tenant (and the whole
 * job could overrun its interval), while the last-sorted tenant was perpetually
 * processed last.
 *
 * This SSoT helper owns the correct shape:
 *  - BOUNDED CONCURRENCY: at most `concurrency` tenants in flight (default 4) —
 *    an in-house worker pool, no new dependency. Each tenant gets its OWN
 *    QueryRunner (never shared), so tenant isolation is preserved.
 *  - PER-TENANT TIMEOUT: a Node-side deadline (`Promise.race`) AND a DB-side
 *    `SET statement_timeout` on the tenant's dedicated connection, so a hung
 *    query is killed at the database, not merely abandoned in Node.
 *  - ERROR ISOLATION: one tenant throwing/timing out never aborts the rest; the
 *    outcome is captured per tenant in the returned results.
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
  /** Per-tenant deadline (Node race + DB statement_timeout), ms. Default 60_000. */
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
  if (
    parts.length === 0 ||
    parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
  ) {
    throw new Error(`Unsafe search_path suffix: ${searchPathSuffix}`);
  }
  return parts.join(', ');
}

export async function forEachTenantSchema(
  dataSource: DataSource,
  handler: (ctx: { schema: string; queryRunner: QueryRunner }) => Promise<void>,
  options: ForEachTenantSchemaOptions = {},
): Promise<TenantSchemaResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const perTenantTimeoutMs = options.perTenantTimeoutMs ?? 60_000;
  const searchPathSuffix = assertSafeSearchPathSuffix(options.searchPathSuffix ?? 'public');
  const logger = options.logger;

  const schemas = rotate(await listTenantSchemas(dataSource), options.rotateBy ?? 0);
  const results: TenantSchemaResult[] = new Array(schemas.length);

  async function runOne(schema: string, index: number): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      if (perTenantTimeoutMs > 0) {
        // DB-side kill switch on this tenant's dedicated connection.
        await queryRunner.query(`SET LOCAL statement_timeout = ${perTenantTimeoutMs}`);
      }
      await queryRunner.query(
        `SELECT pg_catalog.set_config('search_path', $1, true)`,
        [`"${schema}", ${searchPathSuffix}`],
      );

      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = handler({ schema, queryRunner });
      if (perTenantTimeoutMs > 0) {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new TenantSchemaTimeoutError(schema, perTenantTimeoutMs)),
            perTenantTimeoutMs,
          );
        });
        try {
          await Promise.race([work, deadline]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        await work;
      }
      await queryRunner.commitTransaction();
      results[index] = { schema, outcome: 'ok' };
    } catch (err) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction().catch(() => undefined);
      }
      const isTimeout = err instanceof TenantSchemaTimeoutError;
      const error = err instanceof Error ? err : new Error(String(err));
      logger?.error(
        `forEachTenantSchema: tenant ${schema} ${isTimeout ? 'timed out' : 'failed'} — ${error.message}`,
      );
      results[index] = { schema, outcome: isTimeout ? 'timeout' : 'error', error };
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
  const workers = Array.from(
    { length: Math.min(concurrency, schemas.length) },
    async () => {
      while (cursor < schemas.length) {
        const index = cursor++;
        const schema = schemas[index];
        if (schema === undefined) continue; // unreachable; satisfies noUncheckedIndexedAccess
        await runOne(schema, index);
      }
    },
  );
  await Promise.all(workers);

  return results;
}
