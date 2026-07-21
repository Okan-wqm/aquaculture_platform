import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { FindManyOptions, FindOperator, FindOptionsWhere } from 'typeorm';

import {
  DatabaseMetric,
  SlowQueryLog,
  TenantSchema,
} from '../entities/database-management.entity';
import { DatabaseMonitoringService } from '../services/database-monitoring.service';

/**
 * APA-319 — the "Slow Queries" health check counts queries recorded WITHIN the
 * last hour (recency), not queries OLDER than an hour. The shipped bug used
 * `LessThan(now - 1h)` under a `// Last hour` comment, silently counting the
 * inverse set. These assertions pin the predicate DIRECTION (`moreThanOrEqual`)
 * and the window boundary, so a re-inversion fails RED.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * A `queryRunner` whose `query()` returns healthy connection/cache rows, so the
 * only score movement in `getDatabaseHealthStatus` comes from the slow-query
 * count under test.
 */
function makeHealthyQueryRunner(): {
  connect: jest.Mock;
  release: jest.Mock;
  query: jest.Mock;
} {
  return {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string) => {
      if (/pg_stat_activity/.test(sql)) {
        return [{ total: '1', active: '1', idle: '0', waiting: '0' }];
      }
      if (/max_connections/.test(sql)) {
        return [{ max_connections: '100' }];
      }
      if (/pg_statio_user_tables/.test(sql)) {
        return [{ ratio: '0.99' }];
      }
      return [];
    }),
  };
}

/** Pull the `recordedAt` FindOperator out of the recorded `count` call. */
function recordedAtOperatorOf(
  countMock: jest.Mock,
): FindOperator<Date> {
  const call = countMock.mock.calls[0] as [FindManyOptions<SlowQueryLog>?] | undefined;
  const where = call?.[0]?.where as FindOptionsWhere<SlowQueryLog> | undefined;
  const recordedAt = where?.recordedAt;
  if (!(recordedAt instanceof FindOperator)) {
    throw new Error('slowQueryRepository.count was not called with a recordedAt FindOperator');
  }
  return recordedAt;
}

describe('DatabaseMonitoringService.getDatabaseHealthStatus (APA-319)', () => {
  let service: DatabaseMonitoringService;
  let slowQueryCount: jest.Mock;

  beforeEach(async () => {
    slowQueryCount = jest.fn();
    const mockSlowQueryRepository = { count: slowQueryCount, delete: jest.fn() };
    const mockSchemaRepository = { find: jest.fn(), findOne: jest.fn() };
    const mockMetricRepository = { find: jest.fn(), delete: jest.fn() };
    const mockDataSource = {
      createQueryRunner: jest.fn(() => makeHealthyQueryRunner()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseMonitoringService,
        { provide: getRepositoryToken(TenantSchema), useValue: mockSchemaRepository },
        { provide: getRepositoryToken(DatabaseMetric), useValue: mockMetricRepository },
        { provide: getRepositoryToken(SlowQueryLog), useValue: mockSlowQueryRepository },
        { provide: getDataSourceToken(), useValue: mockDataSource },
      ],
    }).compile();

    service = module.get(DatabaseMonitoringService);
  });

  it('counts slow queries with a recency (moreThanOrEqual) window at now - 1h', async () => {
    slowQueryCount.mockResolvedValue(0);
    const before = Date.now();
    await service.getDatabaseHealthStatus();
    const after = Date.now();

    const op = recordedAtOperatorOf(slowQueryCount);
    // The bug shipped `lessThan` (retention). Recency requires moreThanOrEqual.
    expect(op.type).toBe('moreThanOrEqual');
    const boundary = op.value.getTime();
    expect(boundary).toBeGreaterThanOrEqual(before - HOUR_MS);
    expect(boundary).toBeLessThanOrEqual(after - HOUR_MS);
  });

  it('reports Slow Queries "pass" with no score penalty when the count is 0', async () => {
    slowQueryCount.mockResolvedValue(0);
    const health = await service.getDatabaseHealthStatus();
    const check = health.checks.find((c) => c.name === 'Slow Queries');
    expect(check?.status).toBe('pass');
    expect(health.score).toBe(100);
  });

  it('reports Slow Queries "warn" and deducts 5 when the count exceeds 20', async () => {
    slowQueryCount.mockResolvedValue(21);
    const health = await service.getDatabaseHealthStatus();
    const check = health.checks.find((c) => c.name === 'Slow Queries');
    expect(check?.status).toBe('warn');
    expect(health.score).toBe(95);
  });

  it('reports Slow Queries "fail" and deducts 20 when the count exceeds 100', async () => {
    slowQueryCount.mockResolvedValue(101);
    const health = await service.getDatabaseHealthStatus();
    const check = health.checks.find((c) => c.name === 'Slow Queries');
    expect(check?.status).toBe('fail');
    expect(health.score).toBe(80);
  });
});
