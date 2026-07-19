import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';

import { ContinuousAggregateService } from '../continuous-aggregate.service';

/**
 * SENSOR-MEDIUM-066/068 (OPEN-ADR-030-CAGG): the bootstrap that creates the
 * sensor.metrics_1min/1hour/1day continuous aggregates. These tests lock the
 * guard rails — config switch, TimescaleDB presence, advisory-lock serialization
 * — and that the proven aggregate DDL is issued on the pinned sensor schema.
 * The DDL itself is validated against real TimescaleDB by CI's
 * bootstrap-from-scratch gate; here we assert the control flow around it.
 */
interface Harness {
  service: ContinuousAggregateService;
  query: jest.Mock;
  createQueryRunner: jest.Mock;
  release: jest.Mock;
}

function createHarness(
  opts: { enabled?: boolean; timescale?: boolean; lock?: boolean } = {},
): Harness {
  const { enabled = true, timescale = true, lock = true } = opts;

  const query = jest.fn((sql: string): Promise<unknown> => {
    if (sql.includes('pg_extension')) return Promise.resolve([{ exists: timescale }]);
    if (sql.includes('pg_try_advisory_lock')) return Promise.resolve([{ locked: lock }]);
    if (sql.includes('current_schema')) return Promise.resolve([{ current_schema: 'sensor' }]);
    return Promise.resolve(undefined);
  });
  const release = jest.fn().mockResolvedValue(undefined);
  const queryRunner: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: query as QueryRunner['query'],
    release,
  };
  const createQueryRunner = jest.fn(() => queryRunner as QueryRunner);
  const dataSource: Partial<DataSource> = { createQueryRunner };

  const get = jest.fn((_key: string, def?: unknown): unknown =>
    enabled ? def ?? 'true' : 'false',
  );
  const configService: Partial<ConfigService> = { get: get as ConfigService['get'] };

  const service = new ContinuousAggregateService(
    dataSource as DataSource,
    configService as ConfigService,
  );
  return { service, query, createQueryRunner, release };
}

/** Every SQL string the run issued. */
function issuedSql(query: jest.Mock): string[] {
  return query.mock.calls.map((c) => String(c[0]));
}

describe('ContinuousAggregateService — bootstrap (OPEN-ADR-030-CAGG)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('creates the three aggregates on the pinned sensor schema when enabled + TimescaleDB present', async () => {
    const { service, query, createQueryRunner, release } = createHarness();

    await service.ensureAggregates();

    expect(createQueryRunner).toHaveBeenCalledTimes(1);
    const sql = issuedSql(query);
    // search_path pinned to the sensor schema before any DDL.
    expect(sql.some((s) => s.includes('SET search_path TO "sensor"'))).toBe(true);
    // All three rollup views created.
    for (const view of ['metrics_1min', 'metrics_1hour', 'metrics_1day']) {
      expect(
        sql.some((s) => s.includes('CREATE MATERIALIZED VIEW') && s.includes(view)),
      ).toBe(true);
    }
    // Real-time flag + refresh policy present.
    expect(sql.some((s) => s.includes('timescaledb.materialized_only = false'))).toBe(true);
    expect(sql.some((s) => s.includes('add_continuous_aggregate_policy'))).toBe(true);
    // Lock released and connection returned to the pool.
    expect(sql.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('skips entirely when disabled by config (no connection opened)', async () => {
    const { service, createQueryRunner } = createHarness({ enabled: false });

    await service.ensureAggregates();

    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('skips creation when TimescaleDB is absent, but still releases the runner', async () => {
    const { service, query, release } = createHarness({ timescale: false });

    await service.ensureAggregates();

    const sql = issuedSql(query);
    expect(sql.some((s) => s.includes('CREATE MATERIALIZED VIEW'))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('skips creation when another instance holds the advisory lock', async () => {
    const { service, query, release } = createHarness({ lock: false });

    await service.ensureAggregates();

    const sql = issuedSql(query);
    expect(sql.some((s) => s.includes('CREATE MATERIALIZED VIEW'))).toBe(false);
    // Lock was never acquired → never unlocked.
    expect(sql.some((s) => s.includes('pg_advisory_unlock'))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('onApplicationBootstrap delegates to ensureAggregates', async () => {
    const { service, createQueryRunner } = createHarness();

    await service.onApplicationBootstrap();

    expect(createQueryRunner).toHaveBeenCalledTimes(1);
  });
});
