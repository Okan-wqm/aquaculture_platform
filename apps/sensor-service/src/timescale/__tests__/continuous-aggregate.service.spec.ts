import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';

import { ContinuousAggregateService } from '../continuous-aggregate.service';

/**
 * SENSOR-MEDIUM-066/068 (OPEN-ADR-030-CAGG): the bootstrap that creates the
 * metrics_1min/1hour/1day continuous aggregates. A tenant's telemetry lives in
 * that tenant's own schema, so its rollups must too — the bootstrap SWEEPS the
 * tenant schemas and ensures the three views inside each. These tests lock the
 * guard rails (config switch, TimescaleDB presence, per-tenant advisory lock,
 * search_path pin + verification, no pin leaked back to the pool) and that one
 * tenant's failure neither aborts the sweep nor passes silently. The DDL itself
 * is validated against real TimescaleDB by CI's bootstrap-from-scratch gate.
 */
const TENANT_A = 'tenant_3333333333334333';
const TENANT_B = 'tenant_4444444444444444';

interface Harness {
  service: ContinuousAggregateService;
  query: jest.Mock;
  createQueryRunner: jest.Mock;
  release: jest.Mock;
}

function createHarness(
  opts: {
    enabled?: boolean;
    timescale?: boolean;
    lock?: boolean;
    tenants?: string[];
    failFor?: string;
  } = {},
): Harness {
  const {
    enabled = true,
    timescale = true,
    lock = true,
    tenants = [TENANT_A],
    failFor,
  } = opts;

  // The schema the runner is currently pinned to, so current_schema() answers
  // truthfully and the service's own pin verification is actually exercised.
  let pinned = 'public';

  const query = jest.fn((sql: string): Promise<unknown> => {
    const text = String(sql);
    if (text.includes('pg_extension')) return Promise.resolve([{ exists: timescale }]);
    if (text.includes('pg_try_advisory_lock')) return Promise.resolve([{ locked: lock }]);
    const pin = text.match(/SET search_path TO "([^"]+)"/);
    if (pin) {
      pinned = pin[1]!;
      return Promise.resolve(undefined);
    }
    if (text.includes('current_schema')) return Promise.resolve([{ current_schema: pinned }]);
    if (failFor !== undefined && pinned === failFor && text.includes('CREATE MATERIALIZED VIEW')) {
      return Promise.reject(new Error('boom'));
    }
    return Promise.resolve(undefined);
  });
  const release = jest.fn().mockResolvedValue(undefined);
  const queryRunner: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: query as QueryRunner['query'],
    release,
  };
  const createQueryRunner = jest.fn(() => queryRunner as QueryRunner);
  // listTenantSchemas() reads through the DataSource, not the runner.
  const dataSourceQuery = jest.fn(() =>
    Promise.resolve(tenants.map((schema_name) => ({ schema_name }))),
  );
  const dataSource: Partial<DataSource> = {
    createQueryRunner,
    query: dataSourceQuery as DataSource['query'],
  };

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

  it('creates the three aggregates inside the tenant schema when enabled + TimescaleDB present', async () => {
    const { service, query, createQueryRunner, release } = createHarness();

    await service.ensureAggregates();

    expect(createQueryRunner).toHaveBeenCalledTimes(1);
    const sql = issuedSql(query);
    // search_path pinned to the TENANT schema before any DDL — never `sensor`.
    expect(sql.some((s) => s.includes(`SET search_path TO "${TENANT_A}"`))).toBe(true);
    expect(sql.some((s) => s.includes('SET search_path TO "sensor"'))).toBe(false);
    // All three rollup views created.
    for (const view of ['metrics_1min', 'metrics_1hour', 'metrics_1day']) {
      expect(
        sql.some((s) => s.includes('CREATE MATERIALIZED VIEW') && s.includes(view)),
      ).toBe(true);
    }
    // Real-time flag + refresh policy present.
    expect(sql.some((s) => s.includes('timescaledb.materialized_only = false'))).toBe(true);
    expect(sql.some((s) => s.includes('add_continuous_aggregate_policy'))).toBe(true);
    // Lock released, tenant pin cleared, connection returned to the pool.
    expect(sql.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(sql.some((s) => s.includes('SET search_path TO "$user", public'))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('ensures the rollups in EVERY tenant schema', async () => {
    const { service, query } = createHarness({ tenants: [TENANT_A, TENANT_B] });

    await service.ensureAggregates();

    const sql = issuedSql(query);
    expect(sql.some((s) => s.includes(`SET search_path TO "${TENANT_A}"`))).toBe(true);
    expect(sql.some((s) => s.includes(`SET search_path TO "${TENANT_B}"`))).toBe(true);
    // Three views per tenant.
    expect(sql.filter((s) => s.includes('CREATE MATERIALIZED VIEW')).length).toBe(6);
  });

  it('does not abort the sweep when one tenant fails, but raises the failure', async () => {
    const { service, query } = createHarness({
      tenants: [TENANT_A, TENANT_B],
      failFor: TENANT_A,
    });

    await expect(service.ensureAggregates()).rejects.toThrow(TENANT_A);

    // The healthy tenant was still ensured — one bad tenant does not deny the rest.
    const sql = issuedSql(query);
    expect(sql.some((s) => s.includes(`SET search_path TO "${TENANT_B}"`))).toBe(true);
  });

  it('does nothing when there are no tenant schemas yet', async () => {
    const { service, query } = createHarness({ tenants: [] });

    await service.ensureAggregates();

    expect(issuedSql(query).some((s) => s.includes('CREATE MATERIALIZED VIEW'))).toBe(false);
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
