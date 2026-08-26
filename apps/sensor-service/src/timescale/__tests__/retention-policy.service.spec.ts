import { DataSource } from 'typeorm';

import { RetentionPolicyService } from '../retention-policy.service';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_SCHEMA = 'tenant_3333333333334333';

describe('RetentionPolicyService — raw telemetry stop-line', () => {
  const query = jest.fn();
  const dataSource: Partial<DataSource> = {
    query: query as DataSource['query'],
  };
  const service = new RetentionPolicyService(dataSource as DataSource);

  beforeEach(() => query.mockReset());

  it('rejects every attempt to install raw sensor_metrics retention pending LEGAL-001', async () => {
    await expect(service.setPolicy(TENANT_ID, 'sensor_metrics', 'P90D')).rejects.toThrow(
      /LEGAL-001/,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects arbitrary targets instead of granting a generic Timescale DDL surface', async () => {
    await expect(service.setPolicy(TENANT_ID, 'other_table', 'P90D')).rejects.toThrow(/allowlist/);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID tenant identity before constructing a relation', async () => {
    await expect(service.setPolicy('3333333333334333', 'metrics_1hour', 'P90D')).rejects.toThrow(
      /tenant id/i,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('schema-qualifies allowlisted cagg policy writes and accepts ISO-8601 periods', async () => {
    query.mockResolvedValue([]);

    await service.setPolicy(TENANT_ID, 'metrics_1hour', 'P5Y');

    expect(query).toHaveBeenNthCalledWith(
      1,
      `SELECT remove_retention_policy($1, if_exists => TRUE)`,
      [`${TENANT_SCHEMA}.metrics_1hour`],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      `SELECT add_retention_policy($1, $2::interval, if_not_exists => TRUE)`,
      [`${TENANT_SCHEMA}.metrics_1hour`, 'P5Y'],
    );
  });

  it('filters policy visibility by tenant schema and cagg name', async () => {
    query.mockResolvedValue([]);

    await service.getPolicy(TENANT_ID, 'metrics_1min');

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('j.hypertable_schema = $1');
    expect(sql).toContain('j.hypertable_name = $2');
    expect(params).toEqual([TENANT_SCHEMA, 'metrics_1min']);
  });

  it('removes every pre-existing raw retention job at bootstrap', async () => {
    query.mockResolvedValueOnce([{ hypertable_schema: TENANT_SCHEMA }]).mockResolvedValueOnce([]);

    await service.onApplicationBootstrap();

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`j.hypertable_name = 'sensor_metrics'`),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      `SELECT remove_retention_policy($1, if_exists => TRUE)`,
      [`${TENANT_SCHEMA}.sensor_metrics`],
    );
  });

  it('fails closed when Timescale reports a non-tenant raw retention target', async () => {
    query.mockResolvedValueOnce([{ hypertable_schema: 'sensor' }]);

    await expect(service.onApplicationBootstrap()).rejects.toThrow(/schema/i);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
