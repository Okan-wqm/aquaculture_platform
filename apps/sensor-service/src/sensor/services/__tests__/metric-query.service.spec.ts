import { DataSource } from 'typeorm';

import { MetricQueryService } from '../metric-query.service';

/**
 * CRITICAL-003: every query must resolve the validated tenant schema via the
 * platform SSoT — the shared `sensor.` hypertable is NOT the live read path
 * (the writer populates per-tenant schemas only).
 */
const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const TENANT_SCHEMA = 'tenant_123e4567e89b12d3';

function makeService(): { service: MetricQueryService; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue([]);
  const dataSource: Partial<DataSource> = { query };
  const service = new MetricQueryService(dataSource as DataSource);
  return { service, query };
}

describe('MetricQueryService tenant-schema routing (CRITICAL-003)', () => {
  it('queries raw metrics from the tenant schema, never the shared sensor schema', async () => {
    const { service, query } = makeService();
    const now = new Date('2026-08-24T12:00:00Z');

    await service.getMetrics({
      tenantId: TENANT_ID,
      startTime: new Date(now.getTime() - 30 * 60 * 1000),
      endTime: now,
    });

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain(`FROM "${TENANT_SCHEMA}".sensor_metrics`);
    expect(sql).not.toMatch(/sensor\.sensor_metrics/);
    expect(sql).not.toMatch(/FROM sensor\./);
  });

  it('queries aggregate tiers from the tenant schema', async () => {
    const { service, query } = makeService();
    const now = new Date('2026-08-24T12:00:00Z');

    await service.getMetrics({
      tenantId: TENANT_ID,
      startTime: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000),
      endTime: now,
    });

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain(`FROM "${TENANT_SCHEMA}".metrics_1hour`);
    expect(sql).not.toMatch(/sensor\.metrics_/);
  });

  it('joins channel definitions inside the same tenant schema', async () => {
    const { service, query } = makeService();

    await service.getCurrentReadings('sensor-uuid', TENANT_ID);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain(`FROM "${TENANT_SCHEMA}".sensor_metrics m`);
    expect(sql).toContain(`JOIN "${TENANT_SCHEMA}".sensor_data_channels c`);
  });
});
