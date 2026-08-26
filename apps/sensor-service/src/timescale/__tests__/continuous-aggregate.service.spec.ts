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
const TENANT_ID_A = '33333333-3333-4333-8333-333333333333';

interface Harness {
  service: ContinuousAggregateService;
  query: jest.Mock;
  createQueryRunner: jest.Mock;
  dataSourceQuery: jest.Mock;
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
  const { enabled = true, timescale = true, lock = true, tenants = [TENANT_A], failFor } = opts;

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
    enabled ? (def ?? 'true') : 'false',
  );
  const configService: Partial<ConfigService> = { get: get as ConfigService['get'] };

  const service = new ContinuousAggregateService(
    dataSource as DataSource,
    configService as ConfigService,
  );
  return { service, query, createQueryRunner, dataSourceQuery, release };
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

  it('onApplicationBootstrap delegates to ensureAggregates', async () => {
    const { service, createQueryRunner } = createHarness();

    await service.onApplicationBootstrap();

    expect(createQueryRunner).toHaveBeenCalledTimes(1);
  });

  it('uses the locked 24h/7d/30d source horizons for refresh policies', async () => {
    const { service, query } = createHarness();

    await service.ensureAggregates();

    const refreshSql = issuedSql(query).filter((sql) =>
      sql.includes('add_continuous_aggregate_policy'),
    );
    expect(refreshSql).toHaveLength(3);
    expect(refreshSql[0]).toContain("start_offset => INTERVAL '24 hours'");
    expect(refreshSql[1]).toContain("start_offset => INTERVAL '7 days'");
    expect(refreshSql[2]).toContain("start_offset => INTERVAL '30 days'");
  });

  it('ensures a newly provisioned tenant without sweeping unrelated schemas', async () => {
    const { service, query } = createHarness({ tenants: [TENANT_A, TENANT_B] });

    await service.ensureTenantAggregates(TENANT_ID_A);

    const sql = issuedSql(query);
    expect(sql.some((statement) => statement.includes(`SET search_path TO "${TENANT_A}"`))).toBe(
      true,
    );
    expect(sql.some((statement) => statement.includes(`SET search_path TO "${TENANT_B}"`))).toBe(
      false,
    );
  });

  it('filters refresh status by the authenticated tenant schema', async () => {
    const { service, dataSourceQuery } = createHarness();
    dataSourceQuery.mockResolvedValueOnce([
      { view_name: 'metrics_1min', last_run_started_at: null },
    ]);

    await service.getRefreshStatus(TENANT_ID_A);

    const [sql, params] = dataSourceQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('view_schema = $1');
    expect(params).toEqual([TENANT_A, ['metrics_1min', 'metrics_1hour', 'metrics_1day']]);
  });

  it('schema-qualifies manual refresh and rejects a window beyond the lower-source horizon', async () => {
    const { service, dataSourceQuery } = createHarness();
    const end = new Date('2026-08-26T00:00:00.000Z');
    const validStart = new Date('2026-08-25T01:00:00.000Z');

    await service.refresh(TENANT_ID_A, 'metrics_1min', validStart, end);

    expect(dataSourceQuery).toHaveBeenCalledWith(`CALL refresh_continuous_aggregate($1, $2, $3)`, [
      `${TENANT_A}.metrics_1min`,
      validStart,
      end,
    ]);

    await expect(
      service.refresh(TENANT_ID_A, 'metrics_1min', new Date('2026-08-24T23:59:59.999Z'), end),
    ).rejects.toThrow(/24 hours/);
  });

  it('reconciles tenant raw COUNT against cagg SUM(sample_count) on closed bucket boundaries', async () => {
    const { service, dataSourceQuery } = createHarness();
    dataSourceQuery.mockResolvedValueOnce([{ raw_count: '120', aggregate_count: '120' }]);
    const start = new Date('2026-08-25T00:00:00.000Z');
    const end = new Date('2026-08-25T01:00:00.000Z');

    const result = await service.reconcileCounts(
      TENANT_ID_A,
      'metrics_1min',
      start,
      end,
      new Date('2026-08-25T01:05:00.000Z'),
    );

    const [sql, params] = dataSourceQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`FROM "${TENANT_A}"."sensor_metrics"`);
    expect(sql).toContain(`FROM "${TENANT_A}"."metrics_1min"`);
    expect(sql).toContain('COUNT(*)::bigint');
    expect(sql).toContain('SUM(sample_count)');
    expect(params).toEqual([start, end]);
    expect(result).toEqual({ rawCount: '120', aggregateCount: '120', matches: true });
  });

  it('rejects reconciliation beyond the late watermark or off bucket boundaries', async () => {
    const { service, dataSourceQuery } = createHarness();

    await expect(
      service.reconcileCounts(
        TENANT_ID_A,
        'metrics_1hour',
        new Date('2026-08-25T00:30:00.000Z'),
        new Date('2026-08-25T02:00:00.000Z'),
        new Date('2026-08-25T03:00:00.000Z'),
      ),
    ).rejects.toThrow(/bucket boundary/i);
    await expect(
      service.reconcileCounts(
        TENANT_ID_A,
        'metrics_1hour',
        new Date('2026-08-25T00:00:00.000Z'),
        new Date('2026-08-25T03:00:00.000Z'),
        new Date('2026-08-25T02:59:59.999Z'),
      ),
    ).rejects.toThrow(/late watermark/i);
    expect(dataSourceQuery).not.toHaveBeenCalled();
  });
});
