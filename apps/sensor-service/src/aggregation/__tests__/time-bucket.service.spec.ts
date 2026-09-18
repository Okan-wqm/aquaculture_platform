import { DataSource } from 'typeorm';

import { TimeBucketService } from '../time-bucket.service';

/**
 * CRITICAL-003: bucketed reads must target the tenant schema the writer
 * populates; the shared `sensor.` hypertable is not the live read path.
 */
const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const TENANT_SCHEMA = 'tenant_123e4567e89b12d3';

function makeService(): { service: TimeBucketService; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue([]);
  const dataSource: Partial<DataSource> = { query };
  const service = new TimeBucketService(dataSource as DataSource);
  return { service, query };
}

describe('TimeBucketService tenant-schema routing (CRITICAL-003)', () => {
  it('queries the raw tier from the tenant schema', async () => {
    const { service, query } = makeService();
    const now = new Date('2026-08-24T12:00:00Z');

    await service.query({
      tenantId: TENANT_ID,
      startTime: new Date(now.getTime() - 60 * 60 * 1000),
      endTime: now,
    });

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain(`FROM "${TENANT_SCHEMA}".sensor_metrics`);
    expect(sql).not.toMatch(/sensor\.sensor_metrics/);
  });

  it('queries aggregate tiers from the tenant schema', async () => {
    const { service, query } = makeService();
    const now = new Date('2026-08-24T12:00:00Z');

    await service.query({
      tenantId: TENANT_ID,
      startTime: new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000),
      endTime: now,
    });

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain(`FROM "${TENANT_SCHEMA}".metrics_1day`);
    expect(sql).not.toMatch(/sensor\.metrics_/);
  });
});
