import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';

import { ContinuousAggregateService } from '../continuous-aggregate.service';

/**
 * The production bootstrap read-only-verifies db-migrate's per-tenant rollups;
 * non-authoritative local development creates the same canonical definition.
 * These tests lock both modes, including ownership/missing-view failures,
 * TimescaleDB presence, advisory locking, search_path cleanup, and complete
 * tenant sweeps.
 */
const TENANT_A = 'tenant_3333333333334333';
const TENANT_B = 'tenant_4444444444444444';

/** A tenant id whose schema name (per getTenantSchemaName) is TENANT_A. */
const TENANT_A_ID = '33333333-3333-4333-8333-333333333333';

interface Harness {
  service: ContinuousAggregateService;
  query: jest.Mock;
  dataSourceQuery: jest.Mock;
  createQueryRunner: jest.Mock;
  release: jest.Mock;
}

function createHarness(
  opts: {
    enabled?: boolean;
    authoritative?: boolean;
    timescale?: boolean;
    lock?: boolean;
    tenants?: string[];
    failFor?: string;
    aggregateRows?: Array<{ view_name: string; view_owner: string }>;
    statsRows?: Array<{ view_name: string; last_run_started_at: Date | null }>;
  } = {},
): Harness {
  const {
    enabled = true,
    authoritative = false,
    timescale = true,
    lock = true,
    tenants = [TENANT_A],
    failFor,
    aggregateRows = [
      { view_name: 'metrics_1min', view_owner: 'sensor_aggregate_owner' },
      { view_name: 'metrics_1hour', view_owner: 'sensor_aggregate_owner' },
      { view_name: 'metrics_1day', view_owner: 'sensor_aggregate_owner' },
    ],
    statsRows = [],
  } = opts;

  // The schema the runner is currently pinned to, so current_schema() answers
  // truthfully and the service's own pin verification is actually exercised.
  let pinned = 'public';

  const query = jest.fn((sql: string): Promise<unknown> => {
    const text = String(sql);
    if (text.includes('pg_extension')) return Promise.resolve([{ exists: timescale }]);
    if (text.includes('timescaledb_information.continuous_aggregates')) {
      return Promise.resolve(aggregateRows);
    }
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
  // listTenantSchemas(), getRefreshStatus() and refresh() read through the
  // DataSource, not the runner.
  const dataSourceQuery = jest.fn((sql: string): Promise<unknown> => {
    const text = String(sql);
    if (text.includes('continuous_aggregate_stats')) return Promise.resolve(statsRows);
    if (text.includes('refresh_continuous_aggregate')) return Promise.resolve(undefined);
    return Promise.resolve(tenants.map((schema_name) => ({ schema_name })));
  });
  const dataSource: Partial<DataSource> = {
    createQueryRunner,
    query: dataSourceQuery as DataSource['query'],
  };

  const get = jest.fn((key: string, def?: unknown): unknown => {
    if (key === 'SENSOR_CONTINUOUS_AGGREGATES_ENABLED') {
      return enabled ? 'true' : 'false';
    }
    if (key === 'DB_MIGRATE_AUTHORITATIVE') {
      return authoritative ? 'true' : 'false';
    }
    if (key === 'NODE_ENV' || key === 'AQUA_ENV') {
      return 'test';
    }
    return def;
  });
  const configService: Partial<ConfigService> = { get: get as ConfigService['get'] };

  const service = new ContinuousAggregateService(
    dataSource as DataSource,
    configService as ConfigService,
  );
  return { service, query, dataSourceQuery, createQueryRunner, release };
}

/** Every SQL string the run issued. */
function issuedSql(query: jest.Mock): string[] {
  return query.mock.calls.map((c) => String(c[0]));
}

describe('ContinuousAggregateService — aggregate authority', () => {
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
      expect(sql.some((s) => s.includes('CREATE MATERIALIZED VIEW') && s.includes(view))).toBe(
        true,
      );
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

  it('verifies db-migrate-owned aggregates without runtime DDL in authoritative mode', async () => {
    const { service, query } = createHarness({ authoritative: true });

    await service.ensureAggregates();

    const sql = issuedSql(query);
    expect(sql.some((statement) => statement.includes('continuous_aggregates'))).toBe(true);
    expect(sql.some((statement) => statement.includes('CREATE MATERIALIZED VIEW'))).toBe(false);
    expect(sql.some((statement) => statement.includes('ALTER MATERIALIZED VIEW'))).toBe(false);
  });

  it('fails boot when an authoritative aggregate is missing or has the wrong owner', async () => {
    const { service } = createHarness({
      authoritative: true,
      aggregateRows: [
        { view_name: 'metrics_1min', view_owner: 'admin_schema_owner' },
        { view_name: 'metrics_1hour', view_owner: 'sensor_aggregate_owner' },
      ],
    });

    await expect(service.ensureAggregates()).rejects.toThrow(
      /metrics_1min owner=admin_schema_owner.*metrics_1day missing/,
    );
  });

  it('onApplicationBootstrap delegates to ensureAggregates', async () => {
    const { service, createQueryRunner } = createHarness();

    await service.onApplicationBootstrap();

    expect(createQueryRunner).toHaveBeenCalledTimes(1);
  });
});

describe('ContinuousAggregateService — tenant-addressed status and refresh', () => {
  afterEach(() => jest.restoreAllMocks());

  it('getRefreshStatus filters the stats view by the tenant schema and reports every rollup', async () => {
    const lastRun = new Date(Date.now() - 90_000);
    const { service, dataSourceQuery } = createHarness({
      statsRows: [{ view_name: 'metrics_1min', last_run_started_at: lastRun }],
    });

    const status = await service.getRefreshStatus(TENANT_A_ID);

    const [sql, params] = dataSourceQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('view_schema = $1');
    expect(params[0]).toBe(TENANT_A);
    expect(params[1]).toEqual(['metrics_1min', 'metrics_1hour', 'metrics_1day']);
    expect(status.map((row) => row.viewName)).toEqual([
      'metrics_1min',
      'metrics_1hour',
      'metrics_1day',
    ]);
    expect(status[0]).toEqual({ viewName: 'metrics_1min', lastRefresh: lastRun, behindBy: '90s' });
    expect(status[1]).toEqual({ viewName: 'metrics_1hour', lastRefresh: null, behindBy: null });
  });

  it('refresh targets the tenant-qualified view', async () => {
    const { service, dataSourceQuery } = createHarness();
    const start = new Date(Date.now() - 3_600_000);
    const end = new Date();

    await service.refresh(TENANT_A_ID, 'metrics_1hour', start, end);

    const [sql, params] = dataSourceQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('CALL refresh_continuous_aggregate');
    expect(params).toEqual([`"${TENANT_A}"."metrics_1hour"`, start, end]);
  });

  it('refresh refuses a window that starts before the lower tier retention horizon', async () => {
    const { service, dataSourceQuery } = createHarness();
    const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3_600_000);

    await expect(
      service.refresh(TENANT_A_ID, 'metrics_1hour', twoYearsAgo, new Date()),
    ).rejects.toThrow(/retention horizon/);
    expect(dataSourceQuery).not.toHaveBeenCalled();
  });

  it('refresh rejects a view name outside the canonical rollup set', async () => {
    const { service, dataSourceQuery } = createHarness();

    await expect(
      service.refresh(TENANT_A_ID, 'metrics_1min; DROP TABLE x', new Date(), new Date()),
    ).rejects.toThrow(/Unknown continuous aggregate/);
    expect(dataSourceQuery).not.toHaveBeenCalled();
  });
});
