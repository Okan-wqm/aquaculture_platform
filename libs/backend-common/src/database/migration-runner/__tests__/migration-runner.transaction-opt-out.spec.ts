import { stub, stubMember } from '@aquaculture/testing';
import { Logger } from '@nestjs/common';
import { Migration, MigrationExecutor, MigrationInterface, QueryRunner } from 'typeorm';

import { createMigrationRunnerService } from '../migration-runner.service';

/**
 * ORPHAN-CRITICAL-058 parity for the in-process runner.
 *
 * TypeORM's instance-level `transaction = false` is the documented opt-out
 * for DDL that cannot run inside a transaction block (`CREATE INDEX
 * CONCURRENTLY`, consumers of `ALTER TYPE … ADD VALUE`). The db-migrate
 * orchestrator honours it; this runner wrapped every migration
 * unconditionally, so the same migration applied in production and failed
 * in dev / E2E (messaging `AddMessagesContentSearchGinIndex1802300000000`
 * against a partitioned `messages`). The runner must expose the SAME
 * transaction boundary to `up()` as the orchestrator does.
 *
 * The real `MigrationExecutor` is driven with its ledger I/O replaced at
 * the prototype seam: `getPendingMigrations` hands back one fixture
 * migration and `executeMigration` runs its `up()` against the runner's
 * own QueryRunner — the transaction state `up()` observes is exactly what
 * the runner established around the call.
 */

interface TransactionTrace {
  /** `isTransactionActive` as seen inside the migration's `up()`. */
  activeDuringUp: boolean | null;
  startCalls: number;
  commitCalls: number;
  rollbackCalls: number;
}

function buildQueryRunner(trace: TransactionTrace): QueryRunner {
  let pinnedSchema = '';
  let active = false;
  return stub<QueryRunner>({
    connect: (): Promise<void> => Promise.resolve(),
    release: (): Promise<void> => Promise.resolve(),
    // `query` is overloaded on QueryRunner; the double models the
    // single (sql) form the runner and the executor's ledger probe use.
    query: stubMember<QueryRunner['query']>((sql: string): Promise<unknown> => {
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve([{ locked: true }]);
      }
      const pinMatch = /SET search_path TO "([^"]+)"/.exec(sql);
      if (pinMatch?.[1] !== undefined) {
        pinnedSchema = pinMatch[1];
        return Promise.resolve([]);
      }
      if (sql.includes('current_schema()')) {
        return Promise.resolve([{ current_schema: pinnedSchema }]);
      }
      return Promise.resolve([]);
    }),
    hasTable: (): Promise<boolean> => Promise.resolve(false),
    startTransaction: (): Promise<void> => {
      trace.startCalls += 1;
      active = true;
      return Promise.resolve();
    },
    commitTransaction: (): Promise<void> => {
      trace.commitCalls += 1;
      active = false;
      return Promise.resolve();
    },
    rollbackTransaction: (): Promise<void> => {
      trace.rollbackCalls += 1;
      active = false;
      return Promise.resolve();
    },
    get isTransactionActive(): boolean {
      return active;
    },
  });
}

/**
 * The runner factory types its constructor through Nest's `Type<>`, so the
 * DataSource stand-in is the minimal shape the runner and the real
 * MigrationExecutor touch — the same discipline as the sibling factory spec.
 */
function buildDataSource(queryRunner: QueryRunner): {
  options: { migrationsTableName?: string };
  driver: {
    options: { type: string };
    buildTableName: (tableName: string, schema?: string) => string;
  };
  migrations: unknown[];
  createQueryRunner: () => QueryRunner;
  query: () => Promise<unknown>;
} {
  return {
    options: { migrationsTableName: 'migrations' },
    driver: {
      options: { type: 'postgres' },
      buildTableName: (tableName: string, schema?: string): string =>
        schema !== undefined && schema !== '' ? `${schema}.${tableName}` : tableName,
    },
    migrations: [],
    createQueryRunner: (): QueryRunner => queryRunner,
    // No tenant schemas, no observability schema: the expand/contract
    // dependency gate skips cleanly and the fan-out phase finds nothing.
    query: (): Promise<unknown> => Promise.resolve([]),
  };
}

function buildConfigService(): { get: (key: string, def?: string) => string | undefined } {
  return {
    get: (key: string, def?: string): string | undefined =>
      key === 'DATABASE_MIGRATIONS_RUN' ? 'true' : def,
  };
}

class TransactionalFixture1800000000001 implements MigrationInterface {
  name = 'TransactionalFixture1800000000001';
  constructor(private readonly trace: TransactionTrace) {}
  public up(queryRunner: QueryRunner): Promise<void> {
    this.trace.activeDuringUp = queryRunner.isTransactionActive;
    return Promise.resolve();
  }
  public down(): Promise<void> {
    return Promise.resolve();
  }
}

class ConcurrentFixture1800000000002 implements MigrationInterface {
  name = 'ConcurrentFixture1800000000002';
  transaction = false;
  constructor(private readonly trace: TransactionTrace) {}
  public up(queryRunner: QueryRunner): Promise<void> {
    this.trace.activeDuringUp = queryRunner.isTransactionActive;
    return Promise.resolve();
  }
  public down(): Promise<void> {
    return Promise.resolve();
  }
}

class FailingConcurrentFixture1800000000003 implements MigrationInterface {
  name = 'FailingConcurrentFixture1800000000003';
  transaction = false;
  public up(): Promise<void> {
    return Promise.reject(new Error('CONCURRENTLY build lost its lock'));
  }
  public down(): Promise<void> {
    return Promise.resolve();
  }
}

async function runOnce(
  instance: MigrationInterface,
  trace: TransactionTrace,
): Promise<{ error: unknown }> {
  const queryRunner = buildQueryRunner(trace);
  const migration = new Migration(undefined, 1800000000001, instance.name ?? 'fixture', instance);
  jest.spyOn(MigrationExecutor.prototype, 'getPendingMigrations').mockResolvedValue([migration]);
  jest
    .spyOn(MigrationExecutor.prototype, 'executeMigration')
    .mockImplementation(async (pending: Migration): Promise<Migration> => {
      // The real executor runs up() on the runner's QueryRunner and then
      // inserts the ledger row; the ledger write is the only part elided.
      await pending.instance?.up(queryRunner);
      return pending;
    });

  const Runner = createMigrationRunnerService('billing');
  const runner = new Runner(buildDataSource(queryRunner), buildConfigService());
  try {
    await runner.onApplicationBootstrap();
    return { error: undefined };
  } catch (error: unknown) {
    return { error };
  }
}

function freshTrace(): TransactionTrace {
  return { activeDuringUp: null, startCalls: 0, commitCalls: 0, rollbackCalls: 0 };
}

beforeAll(() => {
  Logger.overrideLogger([]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createMigrationRunnerService — instance-level transaction opt-out (ORPHAN-CRITICAL-058 parity)', () => {
  it('wraps a default migration in the per-migration transaction', async () => {
    const trace = freshTrace();
    const { error } = await runOnce(new TransactionalFixture1800000000001(trace), trace);

    expect(error).toBeUndefined();
    expect(trace.activeDuringUp).toBe(true);
    expect(trace.startCalls).toBe(1);
    expect(trace.commitCalls).toBe(1);
    expect(trace.rollbackCalls).toBe(0);
  });

  it('runs a `transaction = false` migration with NO transaction open around up()', async () => {
    const trace = freshTrace();
    const { error } = await runOnce(new ConcurrentFixture1800000000002(trace), trace);

    expect(error).toBeUndefined();
    expect(trace.activeDuringUp).toBe(false);
    expect(trace.startCalls).toBe(0);
    expect(trace.commitCalls).toBe(0);
    expect(trace.rollbackCalls).toBe(0);
  });

  it('propagates a failed `transaction = false` migration without issuing a ROLLBACK it never began', async () => {
    const trace = freshTrace();
    const { error } = await runOnce(new FailingConcurrentFixture1800000000003(), trace);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('CONCURRENTLY build lost its lock');
    expect(trace.startCalls).toBe(0);
    expect(trace.rollbackCalls).toBe(0);
  });
});
