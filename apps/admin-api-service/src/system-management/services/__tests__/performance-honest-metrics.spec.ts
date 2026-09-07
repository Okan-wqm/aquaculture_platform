/**
 * "Unknown" stops being spelled 0 on the performance surface
 * (ADMIN-HIGH-014, OBS-CRITICAL-003).
 *
 * Three fabrications lived here and every one of them read as healthy:
 *
 *   - `getDatabaseMetrics` hard-coded `avgQueryTime: 0` and `slowQueryCount: 0`
 *     in its SUCCESS path, so the panel has always shown a database with no
 *     slow queries and an instant average;
 *   - its catch-all returned zeros for every field plus a made-up pool size of
 *     100, so a database it could not reach rendered as an idle healthy one;
 *   - `getApplicationMetrics` averaged an empty window to 0 and defaulted the
 *     Apdex to `|| 1`, so a service nobody measured scored perfectly — the same
 *     shape as the security health score that returned 100 because it could not
 *     see anything.
 */
import {
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import {
  MetricType,
  PerformanceMetric,
  PerformanceSnapshot,
} from '../../entities/performance-metric.entity';
import { PerformanceMonitoringService } from '../performance-monitoring.service';

const passThroughScheduledJobs: ScheduledJobExecutor = {
  run: async (_job, body) => {
    await body();
    return 'ran';
  },
};

interface Harness {
  service: PerformanceMonitoringService;
  dataSource: { createQueryRunner: jest.Mock; query: jest.Mock };
  metricRepo: { createQueryBuilder: jest.Mock };
  queryRunner: { connect: jest.Mock; query: jest.Mock; release: jest.Mock };
}

/** Rows the live pg_stat_activity / pg_stat_database probes return. */
function catalogueRows(sql: string): unknown[] {
  if (sql.includes("state = 'active'")) return [{ active: '4' }];
  if (sql.includes('max_connections')) return [{ max_connections: '100' }];
  if (sql.includes('blks_hit')) return [{ ratio: '99.20' }];
  if (sql.includes('deadlocks')) return [{ deadlocks: '0' }];
  return [{ total: '11' }];
}

async function build(
  options: { metrics?: PerformanceMetric[]; collected?: unknown[] } = {},
): Promise<Harness> {
  const queryRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn((sql: string) => Promise.resolve(catalogueRows(sql))),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    query: jest.fn().mockResolvedValue(options.collected ?? []),
  };
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(options.metrics ?? []),
  };
  const metricRepo = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PerformanceMonitoringService,
      { provide: ScheduledJobRunner, useValue: passThroughScheduledJobs },
      { provide: getRepositoryToken(PerformanceMetric), useValue: metricRepo },
      { provide: getRepositoryToken(PerformanceSnapshot), useValue: {} },
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: CircuitBreakerService, useValue: { execute: jest.fn() } },
    ],
  }).compile();

  return {
    service: module.get(PerformanceMonitoringService),
    dataSource,
    metricRepo,
    queryRunner,
  };
}

describe('PerformanceMonitoringService reports what it measured', () => {
  it('reads the real query stats the database collector wrote', async () => {
    const { service } = await build({
      collected: [{ metrics: { avgQueryTime: 12.5, slowQueries: 3 } }],
    });

    const metrics = await service.getDatabaseMetrics();

    // Both were hard-coded 0 in the success path.
    expect(metrics.avgQueryTime).toBe(12.5);
    expect(metrics.slowQueryCount).toBe(3);
    // …while the live catalogue probes are still read directly.
    expect(metrics.activeConnections).toBe(4);
    expect(metrics.cacheHitRatio).toBeCloseTo(99.2);
  });

  it('reports the query stats as unknown when the collector has not run recently', async () => {
    const { service } = await build({ collected: [] });

    const metrics = await service.getDatabaseMetrics();

    expect(metrics.avgQueryTime).toBeNull();
    expect(metrics.slowQueryCount).toBeNull();
  });

  it('reports nothing rather than an idle healthy database when it cannot read', async () => {
    const { service, queryRunner } = await build();
    queryRunner.query.mockRejectedValue(new Error('connection refused'));

    const metrics = await service.getDatabaseMetrics();

    expect(metrics).toEqual({
      activeConnections: null,
      poolSize: null,
      poolUtilization: null,
      avgQueryTime: null,
      slowQueryCount: null,
      cacheHitRatio: null,
      deadlockCount: null,
    });
  });

  it('an empty metrics window is unmeasured, not a perfect Apdex', async () => {
    const { service } = await build({ metrics: [] });

    const metrics = await service.getApplicationMetrics();

    // `apdexScore || 1` used to make an empty table score 1.0, which is above
    // every threshold, so nothing ever alerted and the health score stayed 100.
    expect(metrics.apdexScore).toBeNull();
    expect(metrics.avgResponseTime).toBeNull();
    expect(metrics.errorRate).toBeNull();
    expect(metrics.throughput).toBeNull();
    expect(metrics.totalRequests).toBeNull();
  });

  it('computes real aggregates when there are samples', async () => {
    const sample = (metricType: MetricType, value: number): PerformanceMetric =>
      ({ metricType, value }) as PerformanceMetric;
    const { service } = await build({
      metrics: [
        sample(MetricType.RESPONSE_TIME, 100),
        sample(MetricType.RESPONSE_TIME, 300),
        sample(MetricType.APDEX, 0.9),
      ],
    });

    const metrics = await service.getApplicationMetrics();

    expect(metrics.avgResponseTime).toBe(200);
    expect(metrics.apdexScore).toBe(0.9);
    // Still unmeasured — no error-rate samples in the window.
    expect(metrics.errorRate).toBeNull();
  });
});
