import { createMockDataSource } from '@platform/testing';

import { DataSourceType, MetricQueryService } from '../metric-query.service';

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
const SENSOR_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const START = new Date('2026-08-25T00:00:00.000Z');

function createService(): MetricQueryService {
  const { mockDataSource } = createMockDataSource();
  return new MetricQueryService(mockDataSource);
}

function executedSql(): string[] {
  return query.mock.calls.map((call) => String(call[0]));
}

describe('MetricQueryService tenant read boundary', () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue([]);
    runTenantRead.mockClear();
  });

  it.each([
    {
      name: 'raw metrics',
      invoke: (service: MetricQueryService) =>
        service.getMetrics({
          tenantId: TENANT_ID,
          startTime: START,
          endTime: new Date('2026-08-25T00:30:00.000Z'),
        }),
      source: DataSourceType.RAW,
    },
    {
      name: 'minute rollup',
      invoke: (service: MetricQueryService) =>
        service.getMetrics({
          tenantId: TENANT_ID,
          startTime: START,
          endTime: new Date('2026-08-25T02:00:00.000Z'),
        }),
      source: DataSourceType.MINUTE,
    },
    {
      name: 'current sensor readings',
      invoke: (service: MetricQueryService) => service.getCurrentReadings(SENSOR_ID, TENANT_ID),
      source: DataSourceType.RAW,
    },
    {
      name: 'current tank readings',
      invoke: (service: MetricQueryService) => service.getTankCurrentReadings(SENSOR_ID, TENANT_ID),
      source: DataSourceType.RAW,
    },
    {
      name: 'last channel readings',
      invoke: (service: MetricQueryService) => service.getLastReadings(CHANNEL_ID, TENANT_ID),
      source: DataSourceType.RAW,
    },
    {
      name: 'raw channel statistics',
      invoke: (service: MetricQueryService) =>
        service.getChannelStatistics(
          CHANNEL_ID,
          TENANT_ID,
          START,
          new Date('2026-08-25T00:30:00.000Z'),
        ),
      source: DataSourceType.RAW,
    },
    {
      name: 'trend rollup',
      invoke: (service: MetricQueryService) =>
        service.getTrendData(CHANNEL_ID, TENANT_ID, START, new Date('2026-08-26T00:00:00.000Z')),
      source: DataSourceType.HOUR,
    },
  ])(
    'routes $name through the tenant transaction and an unqualified $source source',
    async ({ invoke, source }) => {
      await invoke(createService());

      expect(runTenantRead).toHaveBeenCalledTimes(1);
      expect(runTenantRead).toHaveBeenCalledWith(
        expect.anything(),
        'sensor',
        TENANT_ID,
        expect.any(Function),
      );
      expect(executedSql()).toHaveLength(1);
      expect(executedSql()[0]).toContain(`FROM ${source}`);
      expect(executedSql()[0]).not.toMatch(
        /\bsensor\.(?:sensor_metrics|metrics_(?:1min|1hour|1day))\b/,
      );
    },
  );
});
