import { createMockDataSource } from '@platform/testing';

import { TimeBucketGranularity, TimeBucketService } from '../time-bucket.service';

const query = jest.fn().mockResolvedValue([]);
const runTenantRead = jest.fn(
  (
    _dataSource: unknown,
    _sourceSchema: string,
    _tenantId: string,
    work: (queryRunner: { query: jest.Mock }) => unknown,
  ) => work({ query }),
);

jest.mock('@aquaculture/backend-common/database', () => {
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  return {
    ...actual,
    runInTenantRead: (...args: Parameters<typeof runTenantRead>) => runTenantRead(...args),
  };
});

const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';
const START = new Date('2026-08-25T00:00:00.000Z');

function createService(): TimeBucketService {
  const { mockDataSource } = createMockDataSource();
  return new TimeBucketService(mockDataSource);
}

describe('TimeBucketService tenant read boundary', () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue([]);
    runTenantRead.mockClear();
  });

  it.each([
    {
      name: 'raw metrics',
      endTime: new Date('2026-08-25T01:00:00.000Z'),
      source: TimeBucketGranularity.RAW,
    },
    {
      name: 'minute rollup',
      endTime: new Date('2026-08-26T00:00:00.000Z'),
      source: TimeBucketGranularity.MIN_1,
    },
  ])(
    'routes $name through the tenant transaction and an unqualified source',
    async ({ endTime, source }) => {
      await createService().query({ tenantId: TENANT_ID, startTime: START, endTime });

      expect(runTenantRead).toHaveBeenCalledTimes(1);
      expect(runTenantRead).toHaveBeenCalledWith(
        expect.anything(),
        'sensor',
        TENANT_ID,
        expect.any(Function),
      );
      expect(query).toHaveBeenCalledTimes(1);
      const sql = String(query.mock.calls[0]?.[0]);
      expect(sql).toContain(`FROM ${source}`);
      expect(sql).not.toMatch(/\bsensor\.(?:sensor_metrics|metrics_(?:1min|1hour|1day))\b/);
    },
  );
});
