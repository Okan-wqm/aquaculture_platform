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
  snapshotRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  circuitBreaker: { execute: jest.Mock };
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
  options: {
    metrics?: PerformanceMetric[];
    collected?: unknown[];
    snapshot?: PerformanceSnapshot | null;
  } = {},
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
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(options.metrics ?? []),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  const metricRepo = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) };
  const snapshotRepo = {
    findOne: jest.fn().mockResolvedValue(options.snapshot ?? null),
    create: jest.fn((row: unknown) => row),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const circuitBreaker = { execute: jest.fn() };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PerformanceMonitoringService,
      { provide: ScheduledJobRunner, useValue: passThroughScheduledJobs },
      { provide: getRepositoryToken(PerformanceMetric), useValue: metricRepo },
      { provide: getRepositoryToken(PerformanceSnapshot), useValue: snapshotRepo },
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: CircuitBreakerService, useValue: circuitBreaker },
    ],
  }).compile();

  return {
    service: module.get(PerformanceMonitoringService),
    dataSource,
    metricRepo,
    snapshotRepo,
    circuitBreaker,
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

  /**
   * The dashboard's headline figure (ADMIN-HIGH-123).
   *
   * `calculateHealthScore` returned 100 minus the alert deductions whether or
   * not it had a snapshot to score, and the page then applied its own `?? 100`
   * on top. So a platform that had never recorded a single measurement told its
   * operator that system health was perfect.
   */
  it('has no health score when no snapshot has been taken', async () => {
    const { service } = await build({ snapshot: null, metrics: [] });

    const dashboard = await service.getPerformanceDashboard();

    expect(dashboard.currentSnapshot).toBeNull();
    expect(dashboard.healthScore).toBeNull();
  });

  it('scores the snapshot it has, deducting for what the snapshot measured', async () => {
    const snapshotWith = (
      applicationMetrics: { apdexScore: number; errorRate: number },
      infrastructureMetrics: { cpuUsage: number; memoryUsage: number },
    ): PerformanceSnapshot =>
      ({ applicationMetrics, infrastructureMetrics }) as PerformanceSnapshot;

    const healthy = await build({
      snapshot: snapshotWith({ apdexScore: 0.99, errorRate: 0 }, { cpuUsage: 5, memoryUsage: 5 }),
      metrics: [],
    });
    const degraded = await build({
      snapshot: snapshotWith({ apdexScore: 0.5, errorRate: 4 }, { cpuUsage: 95, memoryUsage: 12 }),
      metrics: [],
    });

    const healthyScore = (await healthy.service.getPerformanceDashboard()).healthScore;
    const degradedScore = (await degraded.service.getPerformanceDashboard()).healthScore;

    // The snapshot's own measurements move the score: -10 apdex, -10 error
    // rate, -5 cpu. Asserted as a difference so the alert deductions the
    // dashboard also applies (identical for both) cannot make this brittle.
    expect(healthyScore).not.toBeNull();
    expect((healthyScore ?? 0) - (degradedScore ?? 0)).toBe(25);
  });

  it('scores a new snapshot from the metrics being persisted, not from nothing', async () => {
    const { service, snapshotRepo, queryRunner } = await build({ metrics: [] });
    queryRunner.query.mockRejectedValue(new Error('connection refused'));

    await service.createPerformanceSnapshot();

    // `calculateHealthScore(null, alerts)` used to be called here with the
    // measurements sitting in the same scope, so every stored snapshot carried
    // a score computed from no measurements at all.
    expect(snapshotRepo.save).toHaveBeenCalledTimes(1);
    const [saved] = snapshotRepo.create.mock.calls[0] as [{ overallHealthScore: number | null }];
    expect(saved.overallHealthScore).not.toBeNull();
  });

  it('reports unknown, not zero, for infrastructure it could not probe', async () => {
    const { service, circuitBreaker } = await build();
    circuitBreaker.execute.mockRejectedValue(new Error('probe unavailable'));

    const metrics = await service.getInfrastructureMetrics();

    // Ten endpoints were probed and none answered: "0 of 10" is the
    // measurement. It used to be "0 of 0", which reads as a complete fleet,
    // over a 0 ms latency nobody had timed.
    expect(metrics.containerCount).toBe(10);
    expect(metrics.healthyContainers).toBe(0);
    expect(metrics.networkLatency).toBeNull();
    // Never measured by this service at all — it has no Kubernetes API access.
    expect(metrics.podRestarts).toBeNull();
    // CPU and memory come from `os`, which cannot fail.
    expect(typeof metrics.cpuUsage).toBe('number');
  });

  it('counts the endpoints that answered when the probe fan-out ran', async () => {
    const { service, circuitBreaker } = await build();
    circuitBreaker.execute.mockResolvedValue({ reachable: true, healthy: true, latency: 8 });

    const metrics = await service.getInfrastructureMetrics();

    expect(metrics.containerCount).toBe(10);
    expect(metrics.healthyContainers).toBe(10);
    expect(metrics.networkLatency).toBe(8);
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
