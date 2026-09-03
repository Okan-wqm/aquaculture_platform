import { ensureTenantSensorContinuousAggregateAuthority } from '../tenant-sensor-continuous-aggregate-authority';

const TENANT_SCHEMA = 'tenant_7f6b08ab90e246d3';

interface IssuedQuery {
  sql: string;
  parameters?: readonly unknown[];
}

function createExecutor(
  options: { deadlockOnceOnOwner?: boolean; failOnCreate?: boolean; timescale?: boolean } = {},
): {
  executor: { query(sql: string, parameters?: readonly unknown[]): Promise<unknown> };
  queries: IssuedQuery[];
} {
  const queries: IssuedQuery[] = [];
  const executor = {
    query(sql: string, parameters?: readonly unknown[]): Promise<unknown> {
      queries.push({ sql, parameters });
      if (sql.includes('FROM pg_extension')) {
        return Promise.resolve([{ exists: options.timescale ?? true }]);
      }
      if (sql.includes('SELECT current_schema()')) {
        return Promise.resolve([{ current_schema: TENANT_SCHEMA }]);
      }
      if (options.failOnCreate === true && sql.includes('CREATE MATERIALIZED VIEW')) {
        return Promise.reject(new Error('aggregate DDL failed'));
      }
      if (
        options.deadlockOnceOnOwner === true &&
        sql.includes('ALTER MATERIALIZED VIEW') &&
        sql.includes('OWNER TO') &&
        queries.filter((query) => query.sql.includes('OWNER TO')).length === 1
      ) {
        return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
      }
      return Promise.resolve([]);
    },
  };
  return { executor, queries };
}

describe('tenant sensor continuous-aggregate authority', () => {
  it('creates all rollups under the DDL authority and aligns owner plus runtime read access', async () => {
    const { executor, queries } = createExecutor();

    const result = await ensureTenantSensorContinuousAggregateAuthority(executor, TENANT_SCHEMA);

    expect(result).toEqual({
      tenantSchema: TENANT_SCHEMA,
      timescalePresent: true,
      ownerRole: 'sensor_schema_owner',
      runtimeRole: 'sensor_service',
      aggregates: ['metrics_1min', 'metrics_1hour', 'metrics_1day'],
    });
    const sql = queries.map((query) => query.sql);
    expect(sql.filter((statement) => statement.includes('CREATE MATERIALIZED VIEW'))).toHaveLength(
      3,
    );
    for (const aggregate of ['metrics_1min', 'metrics_1hour', 'metrics_1day']) {
      expect(sql).toContain(
        `ALTER MATERIALIZED VIEW "${TENANT_SCHEMA}"."${aggregate}" OWNER TO sensor_schema_owner`,
      );
    }
    expect(
      sql.some(
        (statement) =>
          statement.includes(`GRANT SELECT ON TABLE "${TENANT_SCHEMA}"."metrics_1min"`) &&
          statement.includes('TO sensor_service'),
      ),
    ).toBe(true);
    const finalOwnerAlignment = Math.max(
      ...sql.map((statement, index) => (statement.includes('OWNER TO') ? index : -1)),
    );
    const firstPolicyCreation = sql.findIndex((statement) =>
      statement.includes('add_continuous_aggregate_policy'),
    );
    expect(finalOwnerAlignment).toBeLessThan(firstPolicyCreation);
    expect(sql.some((statement) => statement.includes('pg_advisory_unlock'))).toBe(true);
    expect(sql).toContain('SET search_path TO "$user", public');
  });

  it('retries an ownership deadlock before maintenance jobs are created', async () => {
    const { executor, queries } = createExecutor({ deadlockOnceOnOwner: true });

    await expect(
      ensureTenantSensorContinuousAggregateAuthority(executor, TENANT_SCHEMA),
    ).resolves.toMatchObject({ timescalePresent: true });

    expect(queries.filter((query) => query.sql.includes('OWNER TO'))).toHaveLength(4);
  });

  it('skips aggregate DDL when TimescaleDB is not installed', async () => {
    const { executor, queries } = createExecutor({ timescale: false });

    const result = await ensureTenantSensorContinuousAggregateAuthority(executor, TENANT_SCHEMA);

    expect(result.timescalePresent).toBe(false);
    expect(queries.some((query) => query.sql.includes('CREATE MATERIALIZED VIEW'))).toBe(false);
    expect(queries.some((query) => query.sql.includes('pg_advisory_lock'))).toBe(false);
  });

  it('refuses an unsafe schema before issuing SQL', async () => {
    const { executor, queries } = createExecutor();

    await expect(
      ensureTenantSensorContinuousAggregateAuthority(executor, 'sensor'),
    ).rejects.toThrow(/Invalid schema name/);

    expect(queries).toHaveLength(0);

    const publicHarness = createExecutor();
    await expect(
      ensureTenantSensorContinuousAggregateAuthority(publicHarness.executor, 'public'),
    ).rejects.toThrow(/Invalid tenant schema name/);
    expect(publicHarness.queries).toHaveLength(0);
  });

  it('unlocks and clears search_path when aggregate DDL fails', async () => {
    const { executor, queries } = createExecutor({ failOnCreate: true });

    await expect(
      ensureTenantSensorContinuousAggregateAuthority(executor, TENANT_SCHEMA),
    ).rejects.toThrow('aggregate DDL failed');

    const sql = queries.map((query) => query.sql);
    expect(sql.some((statement) => statement.includes('pg_advisory_unlock'))).toBe(true);
    expect(sql).toContain('SET search_path TO "$user", public');
  });
});
