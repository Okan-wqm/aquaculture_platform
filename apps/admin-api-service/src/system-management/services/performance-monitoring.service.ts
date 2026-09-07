import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Between } from 'typeorm';
import * as os from 'os';
import * as fs from 'fs';
import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';
import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';

import {
  type ApplicationMetrics,
  type DatabaseMetrics,
  type InfrastructureMetrics,
  PerformanceMetric,
  PerformanceSnapshot,
  MetricType,
  MetricAggregation,
  MetricDimensions,
} from '../entities/performance-metric.entity';

/**
 * The measured shapes live with the entity that persists them — one
 * declaration for the jsonb column and the API response alike. Re-exported so
 * existing importers of this service keep their import path.
 */
export type { ApplicationMetrics, DatabaseMetrics, InfrastructureMetrics };

// ============================================================================
// Interfaces
// ============================================================================

export interface PerformanceDashboard {
  currentSnapshot: PerformanceSnapshot | null;
  trends: {
    responseTime: Array<{ timestamp: Date; value: number }>;
    throughput: Array<{ timestamp: Date; value: number }>;
    errorRate: Array<{ timestamp: Date; value: number }>;
    cpuUsage: Array<{ timestamp: Date; value: number }>;
    memoryUsage: Array<{ timestamp: Date; value: number }>;
  };
  alerts: Array<{
    metric: string;
    threshold: number;
    currentValue: number;
    severity: 'warning' | 'critical';
  }>;
  healthScore: number;
  serviceBreakdown: Array<{
    service: string;
    avgResponseTime: number;
    errorRate: number;
    requestCount: number;
  }>;
}

export interface MetricThreshold {
  metric: MetricType;
  warningThreshold: number;
  criticalThreshold: number;
  comparison: 'gt' | 'lt' | 'gte' | 'lte';
}

// ============================================================================
// Default Thresholds
// ============================================================================

const DEFAULT_THRESHOLDS: MetricThreshold[] = [
  {
    metric: MetricType.RESPONSE_TIME,
    warningThreshold: 500,
    criticalThreshold: 1000,
    comparison: 'gt',
  },
  { metric: MetricType.ERROR_RATE, warningThreshold: 1, criticalThreshold: 5, comparison: 'gt' },
  { metric: MetricType.CPU_USAGE, warningThreshold: 70, criticalThreshold: 90, comparison: 'gt' },
  {
    metric: MetricType.MEMORY_USAGE,
    warningThreshold: 80,
    criticalThreshold: 95,
    comparison: 'gt',
  },
  { metric: MetricType.DISK_USAGE, warningThreshold: 80, criticalThreshold: 95, comparison: 'gt' },
  {
    metric: MetricType.DB_CONNECTION_POOL,
    warningThreshold: 80,
    criticalThreshold: 95,
    comparison: 'gt',
  },
  {
    metric: MetricType.DB_QUERY_TIME,
    warningThreshold: 100,
    criticalThreshold: 500,
    comparison: 'gt',
  },
  {
    metric: MetricType.DB_CACHE_HIT_RATIO,
    warningThreshold: 80,
    criticalThreshold: 60,
    comparison: 'lt',
  },
  { metric: MetricType.APDEX, warningThreshold: 0.85, criticalThreshold: 0.7, comparison: 'lt' },
];

// ============================================================================
// Performance Monitoring Service
// ============================================================================

@Injectable()
export class PerformanceMonitoringService {
  private readonly logger = new Logger(PerformanceMonitoringService.name);
  private metricsBuffer: PerformanceMetric[] = [];
  private readonly BUFFER_SIZE = 100;
  private thresholds: MetricThreshold[] = DEFAULT_THRESHOLDS;

  // ADMIN-HIGH-014: the in-memory `requestMetrics` map and its
  // `aggregateRequestMetrics` drain are gone. `recordRequestMetric` — the only
  // thing that ever wrote to the map — had zero callers, so a per-minute
  // scheduled job iterated a permanently empty Map and wrote nothing, and
  // `getApplicationMetrics` then read the RESPONSE_TIME / REQUEST_COUNT /
  // ERROR_RATE rows it would have produced. The RED data it duplicated is
  // already in Prometheus (`http_requests_total`,
  // `http_request_duration_seconds`), emitted by the shared metrics middleware
  // on every route of every service.

  constructor(
    @InjectRepository(PerformanceMetric)
    private readonly metricRepo: Repository<PerformanceMetric>,
    @InjectRepository(PerformanceSnapshot)
    private readonly snapshotRepo: Repository<PerformanceSnapshot>,
    private readonly dataSource: DataSource,
    /**
     * CIRCUIT-LOW-001 cure (sibling site): cross-service health
     * probes wrap in the canonical breaker. fail-OPEN-degraded so
     * one slow downstream service doesn't slow the whole performance
     * snapshot.
     */
    private readonly circuitBreaker: CircuitBreakerService,
    @Inject(ScheduledJobRunner) readonly scheduledJobs: ScheduledJobExecutor,
  ) {}

  // ============================================================================
  // Metric Recording
  // ============================================================================

  async recordMetric(data: {
    metricType: MetricType;
    name: string;
    value: number;
    unit?: string;
    aggregation?: MetricAggregation;
    service?: string;
    dimensions?: MetricDimensions;
    percentiles?: { p50?: number; p90?: number; p95?: number; p99?: number };
    sampleCount?: number;
    timestamp?: Date;
  }): Promise<void> {
    const metric = this.metricRepo.create({
      ...data,
      aggregation: data.aggregation || MetricAggregation.AVG,
      timestamp: data.timestamp || new Date(),
      intervalSeconds: 60,
    });

    this.metricsBuffer.push(metric);

    if (this.metricsBuffer.length >= this.BUFFER_SIZE) {
      await this.flushMetrics();
    }
  }

  async flushMetrics(): Promise<void> {
    if (this.metricsBuffer.length === 0) return;

    const metrics = [...this.metricsBuffer];
    this.metricsBuffer = [];

    try {
      await this.metricRepo.save(metrics);
      this.logger.debug(`Flushed ${metrics.length} metrics`);
    } catch (error) {
      this.logger.error('Failed to flush metrics', error);
      // Re-add to buffer on failure
      this.metricsBuffer.push(...metrics);
    }
  }

  // ============================================================================
  // Application Performance
  // ============================================================================

  async getApplicationMetrics(
    service?: string,
    timeRange?: { start?: Date; end?: Date },
  ): Promise<ApplicationMetrics> {
    const end = timeRange?.end || new Date();
    const start = timeRange?.start || new Date(end.getTime() - 5 * 60 * 1000); // Last 5 minutes

    const query = this.metricRepo
      .createQueryBuilder('m')
      .where('m.timestamp BETWEEN :start AND :end', { start, end })
      .andWhere('m.metricType IN (:...types)', {
        types: [
          MetricType.RESPONSE_TIME,
          MetricType.THROUGHPUT,
          MetricType.ERROR_RATE,
          MetricType.APDEX,
          MetricType.REQUEST_COUNT,
        ],
      });

    if (service) {
      query.andWhere('m.service = :service', { service });
    }

    const metrics = await query.getMany();

    // Calculate aggregates
    const responseTimeMetrics = metrics.filter((m) => m.metricType === MetricType.RESPONSE_TIME);
    const errorRateMetrics = metrics.filter((m) => m.metricType === MetricType.ERROR_RATE);
    const throughputMetrics = metrics.filter((m) => m.metricType === MetricType.THROUGHPUT);
    const apdexMetrics = metrics.filter((m) => m.metricType === MetricType.APDEX);

    const requestCountMetrics = metrics.filter((m) => m.metricType === MetricType.REQUEST_COUNT);

    // A window with no samples is UNMEASURED, not "0 ms, 0% errors, Apdex 1.0".
    // `calculateAverage([])` returned 0 and `apdexScore || 1` turned an empty
    // table into a perfect score — the same shape as the security health score
    // that returned 100 because it could not see anything.
    return {
      avgResponseTime: this.averageOrNull(responseTimeMetrics.map((m) => m.value)),
      p95ResponseTime: this.percentileOrNull(
        responseTimeMetrics.map((m) => m.percentiles?.p95 ?? m.value),
        95,
      ),
      p99ResponseTime: this.percentileOrNull(
        responseTimeMetrics.map((m) => m.percentiles?.p99 ?? m.value),
        99,
      ),
      throughput:
        throughputMetrics.length > 0
          ? this.calculateSum(throughputMetrics.map((m) => m.value))
          : null,
      errorRate: this.averageOrNull(errorRateMetrics.map((m) => m.value)),
      apdexScore: this.averageOrNull(apdexMetrics.map((m) => m.value)),
      // No producer feeds an in-flight counter; a stored 0 would be a claim.
      activeRequests: null,
      totalRequests:
        requestCountMetrics.length > 0
          ? this.calculateSum(requestCountMetrics.map((m) => m.value))
          : null,
    };
  }

  /**
   * The freshest query stats the database collector wrote, or nulls.
   *
   * `DatabaseMonitoringService.collectMetrics` runs every five minutes and is a
   * live producer; a window of three ticks tolerates one missed run without
   * presenting a stale number as current. Beyond it the honest answer is that
   * nobody has measured recently.
   */
  private async latestCollectedQueryStats(): Promise<{
    avgQueryTime: number | null;
    slowQueryCount: number | null;
  }> {
    const rows = (await this.dataSource.query(
      `SELECT metrics
         FROM "admin"."database_metrics"
        WHERE "metricType" = 'system'
          AND "recordedAt" > now() - interval '15 minutes'
        ORDER BY "recordedAt" DESC
        LIMIT 1`,
    )) as Array<{ metrics: { avgQueryTime?: number; slowQueries?: number } }>;

    const [row] = rows;
    if (!row) {
      return { avgQueryTime: null, slowQueryCount: null };
    }
    return {
      avgQueryTime: row.metrics.avgQueryTime ?? null,
      slowQueryCount: row.metrics.slowQueries ?? null,
    };
  }

  /** An average over no samples is not zero; it does not exist. */
  private averageOrNull(values: number[]): number | null {
    return values.length === 0 ? null : this.calculateAverage(values);
  }

  private percentileOrNull(values: number[], percentile: number): number | null {
    return values.length === 0 ? null : this.calculatePercentile(values, percentile);
  }

  async calculateApdexScore(
    satisfiedThreshold = 500,
    toleratedThreshold = 2000,
    service?: string,
    timeRange?: { start?: Date; end?: Date },
  ): Promise<number> {
    const end = timeRange?.end || new Date();
    const start = timeRange?.start || new Date(end.getTime() - 5 * 60 * 1000);

    const query = this.metricRepo
      .createQueryBuilder('m')
      .where('m.timestamp BETWEEN :start AND :end', { start, end })
      .andWhere('m.metricType = :type', { type: MetricType.RESPONSE_TIME });

    if (service) {
      query.andWhere('m.service = :service', { service });
    }

    const metrics = await query.getMany();

    if (metrics.length === 0) return 1;

    let satisfied = 0;
    let tolerated = 0;
    let total = 0;

    for (const metric of metrics) {
      const count = metric.sampleCount || 1;
      total += count;

      if (metric.value <= satisfiedThreshold) {
        satisfied += count;
      } else if (metric.value <= toleratedThreshold) {
        tolerated += count;
      }
    }

    if (total === 0) return 1;

    return (satisfied + tolerated / 2) / total;
  }

  // ============================================================================
  // Database Performance
  // ============================================================================

  async getDatabaseMetrics(
    database?: string,
    timeRange?: { start?: Date; end?: Date },
  ): Promise<DatabaseMetrics> {
    try {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        // Active connections
        const connResult = await queryRunner.query(
          `SELECT count(*) as active FROM pg_stat_activity WHERE state = 'active'`,
        );
        const activeConnections = parseInt(connResult[0]?.active || '0', 10);

        // Max connections (pool size)
        const maxConnResult = await queryRunner.query(`SHOW max_connections`);
        const poolSize = parseInt(maxConnResult[0]?.max_connections || '100', 10);

        // Cache hit ratio
        const cacheResult = await queryRunner.query(`
          SELECT ROUND(100.0 * sum(blks_hit) / NULLIF(sum(blks_hit) + sum(blks_read), 0), 2) as ratio
          FROM pg_stat_database
        `);
        const cacheHitRatio = parseFloat(cacheResult[0]?.ratio || '0');

        // Deadlocks
        const deadlockResult = await queryRunner.query(`
          SELECT COALESCE(sum(deadlocks), 0) as deadlocks FROM pg_stat_database
        `);
        const deadlockCount = parseInt(deadlockResult[0]?.deadlocks || '0', 10);

        // Total connections
        const totalConnResult = await queryRunner.query(
          `SELECT count(*) as total FROM pg_stat_activity`,
        );
        const totalConnections = parseInt(totalConnResult[0]?.total || '0', 10);

        // `avgQueryTime` and `slowQueryCount` were hard-coded 0 in this SUCCESS
        // path — the panel has always shown a database with no slow queries and
        // an instant average. They are not measurable from pg_stat_activity;
        // they come from pg_stat_statements, which
        // `DatabaseMonitoringService.collectMetrics` already reads every five
        // minutes into `admin.database_metrics`. Read that rather than running
        // the same catalogue query from a second place, so the performance panel
        // and the database panel cannot disagree.
        const collected = await this.latestCollectedQueryStats();

        return {
          activeConnections,
          poolSize,
          poolUtilization: Math.round((totalConnections / poolSize) * 10000) / 100,
          avgQueryTime: collected.avgQueryTime,
          slowQueryCount: collected.slowQueryCount,
          cacheHitRatio: cacheHitRatio || 0,
          deadlockCount,
        };
      } finally {
        await queryRunner.release();
      }
    } catch (error) {
      // Every field was a fabricated zero here (and a fabricated pool size of
      // 100), so a database this service could not reach rendered as an idle,
      // healthy one. A reader that cannot read reports that it could not.
      this.logger.error('Failed to get database metrics', error);
      return {
        activeConnections: null,
        poolSize: null,
        poolUtilization: null,
        avgQueryTime: null,
        slowQueryCount: null,
        cacheHitRatio: null,
        deadlockCount: null,
      };
    }
  }

  async getSlowQueries(
    threshold = 1000,
    limit = 20,
    timeRange?: { start?: Date; end?: Date },
  ): Promise<Array<{ query: string; avgTime: number; count: number; maxTime: number }>> {
    const end = timeRange?.end || new Date();
    const start = timeRange?.start || new Date(end.getTime() - 24 * 60 * 60 * 1000); // Last 24 hours

    const result = await this.metricRepo
      .createQueryBuilder('m')
      .select("m.dimensions->>'query'", 'query')
      .addSelect('AVG(m.value)', 'avgTime')
      .addSelect('COUNT(*)', 'count')
      .addSelect('MAX(m.value)', 'maxTime')
      .where('m.timestamp BETWEEN :start AND :end', { start, end })
      .andWhere('m.metricType = :type', { type: MetricType.DB_QUERY_TIME })
      .andWhere('m.value > :threshold', { threshold })
      .groupBy("m.dimensions->>'query'")
      .orderBy('avgTime', 'DESC')
      .limit(limit)
      .getRawMany();

    return result.map((r) => ({
      query: r.query || 'Unknown',
      avgTime: parseFloat(r.avgTime) || 0,
      count: parseInt(r.count, 10) || 0,
      maxTime: parseFloat(r.maxTime) || 0,
    }));
  }

  // ============================================================================
  // Infrastructure Performance
  // ============================================================================

  async getInfrastructureMetrics(
    host?: string,
    timeRange?: { start?: Date; end?: Date },
  ): Promise<InfrastructureMetrics> {
    // Real OS metrics
    const cpus = os.cpus();
    const cpuUsage =
      cpus.reduce((acc, cpu) => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        const idle = cpu.times.idle;
        return acc + ((total - idle) / total) * 100;
      }, 0) / cpus.length;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memoryUsage = ((totalMem - freeMem) / totalMem) * 100;

    let diskUsage = 0;
    let diskTotal = 0;
    try {
      const diskStats = fs.statfsSync('/');
      diskTotal = diskStats.bsize * diskStats.blocks;
      const diskFree = diskStats.bsize * diskStats.bavail;
      diskUsage = ((diskTotal - diskFree) / diskTotal) * 100;
    } catch (e) {
      this.logger.warn('Failed to get disk stats');
    }

    // Container health checks
    let containerCount = 0;
    let healthyContainers = 0;
    let networkLatency = 0;

    try {
      const serviceEndpoints = [
        { name: 'auth-service', url: 'http://aqua-auth:3000/health/live' },
        { name: 'gateway-api', url: 'http://aqua-gateway:3000/health/live' },
        { name: 'farm-service', url: 'http://aqua-farm:3000/health/live' },
        { name: 'sensor-service', url: 'http://aqua-sensor:3000/health/live' },
        { name: 'alert-engine', url: 'http://aqua-alert:3000/health/live' },
        { name: 'notification-service', url: 'http://aqua-notification:3000/health/live' },
        { name: 'billing-service', url: 'http://aqua-billing:3000/health/live' },
        { name: 'config-service', url: 'http://aqua-config:3000/health/live' },
        { name: 'hr-service', url: 'http://aqua-hr:3000/health/live' },
        { name: 'hydroponics-service', url: 'http://aqua-hydroponics:3000/health/live' },
      ];

      const healthResults = await Promise.allSettled(
        serviceEndpoints.map(async (endpoint) => {
          const start = Date.now();
          // CIRCUIT-LOW-001 cure: each per-endpoint fetch runs
          // through its OWN per-service breaker keyed on the
          // endpoint name. A single chronically-down service
          // trips its own breaker without dragging the rest
          // into a degraded latency budget.
          return this.circuitBreaker.execute<{
            reachable: boolean;
            healthy: boolean;
            latency: number;
          }>({
            serviceName: `admin-api-perf-probe:${endpoint.name}`,
            tenantId: '*',
            options: {
              ...DEFAULT_BREAKER_OPTIONS,
              failureMode: 'fail-open-degraded',
            },
            fn: async () => {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 2000);
              try {
                // SECURITY (HIGH-003): cross-service health probes
                // from admin-api scheduler are signed for platform
                // invariant.
                const response = await fetch(endpoint.url, {
                  signal: controller.signal,
                  headers: buildSignedInternalHeaders({
                    serviceName: 'admin-api-service',
                    tenantId: '',
                    method: 'GET',
                    path: new URL(endpoint.url).pathname,
                    audience: endpoint.name,
                    body: '',
                  }),
                });
                const latency = Date.now() - start;
                return {
                  reachable: true,
                  healthy: response.ok,
                  latency,
                };
              } finally {
                clearTimeout(timeout);
              }
            },
            fallback: () => ({
              reachable: false,
              healthy: false,
              latency: Date.now() - start,
            }),
          });
        }),
      );

      const latencies: number[] = [];
      for (const result of healthResults) {
        if (result.status === 'fulfilled' && result.value.reachable) {
          containerCount++;
          if (result.value.healthy) {
            healthyContainers++;
          }
          latencies.push(result.value.latency);
        }
      }

      if (latencies.length > 0) {
        networkLatency =
          Math.round((latencies.reduce((sum, l) => sum + l, 0) / latencies.length) * 100) / 100;
      }
    } catch (error) {
      this.logger.warn('Failed to check container health', error);
      containerCount = 0;
      healthyContainers = 0;
      networkLatency = 0;
    }

    return {
      cpuUsage: Math.round(cpuUsage * 100) / 100,
      memoryUsage: Math.round(memoryUsage * 100) / 100,
      memoryTotal: totalMem,
      diskUsage: Math.round(diskUsage * 100) / 100,
      diskTotal,
      networkLatency,
      containerCount,
      healthyContainers,
      podRestarts: 0, // Requires Kubernetes API access
    };
  }

  // ============================================================================
  // Performance Dashboard
  // ============================================================================

  async getPerformanceDashboard(
    service?: string,
    timeRange?: { start?: Date; end?: Date },
  ): Promise<PerformanceDashboard> {
    const end = timeRange?.end || new Date();
    const start = timeRange?.start || new Date(end.getTime() - 60 * 60 * 1000); // Last hour

    // Get latest snapshot
    const currentSnapshot = await this.snapshotRepo.findOne({
      where: service ? { service } : {},
      order: { timestamp: 'DESC' },
    });

    // Get trends
    const trendMetrics = await this.metricRepo
      .createQueryBuilder('m')
      .where('m.timestamp BETWEEN :start AND :end', { start, end })
      .andWhere('m.metricType IN (:...types)', {
        types: [
          MetricType.RESPONSE_TIME,
          MetricType.THROUGHPUT,
          MetricType.ERROR_RATE,
          MetricType.CPU_USAGE,
          MetricType.MEMORY_USAGE,
        ],
      })
      .orderBy('m.timestamp', 'ASC')
      .getMany();

    const trends = {
      responseTime: trendMetrics
        .filter((m) => m.metricType === MetricType.RESPONSE_TIME)
        .map((m) => ({ timestamp: m.timestamp, value: m.value })),
      throughput: trendMetrics
        .filter((m) => m.metricType === MetricType.THROUGHPUT)
        .map((m) => ({ timestamp: m.timestamp, value: m.value })),
      errorRate: trendMetrics
        .filter((m) => m.metricType === MetricType.ERROR_RATE)
        .map((m) => ({ timestamp: m.timestamp, value: m.value })),
      cpuUsage: trendMetrics
        .filter((m) => m.metricType === MetricType.CPU_USAGE)
        .map((m) => ({ timestamp: m.timestamp, value: m.value })),
      memoryUsage: trendMetrics
        .filter((m) => m.metricType === MetricType.MEMORY_USAGE)
        .map((m) => ({ timestamp: m.timestamp, value: m.value })),
    };

    // Calculate alerts
    const alerts = await this.checkThresholds(service);

    // Calculate health score
    const healthScore = this.calculateHealthScore(currentSnapshot, alerts);

    // Get service breakdown
    const serviceBreakdown = await this.getServiceBreakdown(start, end);

    return {
      currentSnapshot,
      trends,
      alerts,
      healthScore,
      serviceBreakdown,
    };
  }

  async getServiceBreakdown(
    start: Date,
    end: Date,
  ): Promise<
    Array<{ service: string; avgResponseTime: number; errorRate: number; requestCount: number }>
  > {
    const result = await this.metricRepo
      .createQueryBuilder('m')
      .select('m.service', 'service')
      .addSelect('AVG(CASE WHEN m.metricType = :rtType THEN m.value END)', 'avgResponseTime')
      .addSelect('AVG(CASE WHEN m.metricType = :erType THEN m.value END)', 'errorRate')
      .addSelect('SUM(CASE WHEN m.metricType = :rcType THEN m.value ELSE 0 END)', 'requestCount')
      .where('m.timestamp BETWEEN :start AND :end', { start, end })
      .andWhere('m.service IS NOT NULL')
      .setParameter('rtType', MetricType.RESPONSE_TIME)
      .setParameter('erType', MetricType.ERROR_RATE)
      .setParameter('rcType', MetricType.REQUEST_COUNT)
      .groupBy('m.service')
      .orderBy('"requestCount"', 'DESC')
      .limit(10)
      .getRawMany();

    return result.map((r) => ({
      service: r.service,
      avgResponseTime: parseFloat(r.avgResponseTime) || 0,
      errorRate: parseFloat(r.errorRate) || 0,
      requestCount: parseInt(r.requestCount, 10) || 0,
    }));
  }

  // ============================================================================
  // Threshold & Alert Management
  // ============================================================================

  async checkThresholds(service?: string): Promise<
    Array<{
      metric: string;
      threshold: number;
      currentValue: number;
      severity: 'warning' | 'critical';
    }>
  > {
    const alerts: Array<{
      metric: string;
      threshold: number;
      currentValue: number;
      severity: 'warning' | 'critical';
    }> = [];

    const [appMetrics, dbMetrics, infraMetrics] = await Promise.all([
      this.getApplicationMetrics(service),
      this.getDatabaseMetrics(),
      this.getInfrastructureMetrics(),
    ]);

    // A metric that was not measured cannot breach a threshold. It used to
    // arrive as 0 and silently satisfy every "less than" comparison.
    const metricValues: Record<string, number | null> = {
      [MetricType.RESPONSE_TIME]: appMetrics.avgResponseTime,
      [MetricType.ERROR_RATE]: appMetrics.errorRate,
      [MetricType.APDEX]: appMetrics.apdexScore,
      [MetricType.CPU_USAGE]: infraMetrics.cpuUsage,
      [MetricType.MEMORY_USAGE]: infraMetrics.memoryUsage,
      [MetricType.DISK_USAGE]: infraMetrics.diskUsage,
      [MetricType.DB_CONNECTION_POOL]: dbMetrics.poolUtilization,
      [MetricType.DB_QUERY_TIME]: dbMetrics.avgQueryTime,
      [MetricType.DB_CACHE_HIT_RATIO]: dbMetrics.cacheHitRatio,
    };

    for (const threshold of this.thresholds) {
      const value = metricValues[threshold.metric];
      if (value === undefined || value === null) continue;

      const isCritical = this.compareValue(
        value,
        threshold.criticalThreshold,
        threshold.comparison,
      );
      const isWarning = this.compareValue(value, threshold.warningThreshold, threshold.comparison);

      if (isCritical) {
        alerts.push({
          metric: threshold.metric,
          threshold: threshold.criticalThreshold,
          currentValue: value,
          severity: 'critical',
        });
      } else if (isWarning) {
        alerts.push({
          metric: threshold.metric,
          threshold: threshold.warningThreshold,
          currentValue: value,
          severity: 'warning',
        });
      }
    }

    return alerts;
  }

  private compareValue(
    value: number,
    threshold: number,
    comparison: 'gt' | 'lt' | 'gte' | 'lte',
  ): boolean {
    switch (comparison) {
      case 'gt':
        return value > threshold;
      case 'lt':
        return value < threshold;
      case 'gte':
        return value >= threshold;
      case 'lte':
        return value <= threshold;
      default:
        return false;
    }
  }

  updateThresholds(newThresholds: MetricThreshold[]): void {
    this.thresholds = newThresholds;
    this.logger.log('Updated metric thresholds');
  }

  getThresholds(): MetricThreshold[] {
    return [...this.thresholds];
  }

  // ============================================================================
  // Snapshots
  // ============================================================================

  @ScheduledJob({ name: 'performance.snapshot', cron: CronExpression.EVERY_MINUTE })
  async createPerformanceSnapshot(): Promise<void> {
    try {
      const [appMetrics, dbMetrics, infraMetrics, alerts] = await Promise.all([
        this.getApplicationMetrics(),
        this.getDatabaseMetrics(),
        this.getInfrastructureMetrics(),
        this.checkThresholds(),
      ]);

      const healthScore = this.calculateHealthScore(null, alerts);

      const snapshot = this.snapshotRepo.create({
        timestamp: new Date().toISOString(),
        applicationMetrics: appMetrics,
        databaseMetrics: dbMetrics,
        infrastructureMetrics: infraMetrics,
        alerts,
        overallHealthScore: healthScore,
      });

      await this.snapshotRepo.save(snapshot);

      // Flush any pending metrics
      await this.flushMetrics();

      this.logger.debug('Created performance snapshot');
    } catch (error) {
      this.logger.error('Failed to create performance snapshot', error);
    }
  }

  private calculateHealthScore(
    snapshot: PerformanceSnapshot | null,
    alerts: Array<{ severity: 'warning' | 'critical' }>,
  ): number {
    let score = 100;

    // Deduct for alerts
    const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
    const warningCount = alerts.filter((a) => a.severity === 'warning').length;

    score -= criticalCount * 15;
    score -= warningCount * 5;

    // Deduct for poor metrics if snapshot available.
    //
    // A metric that was not measured deducts nothing — but it also must not
    // read as healthy. `apdexScore` used to arrive as a fabricated 1.0 from an
    // empty metrics window, which is above every threshold, so the score said
    // 100 for a service nobody was measuring. Now it arrives as null and is
    // skipped, and the caller sees which inputs were missing.
    if (snapshot) {
      const { apdexScore, errorRate } = snapshot.applicationMetrics;
      if (apdexScore !== null && apdexScore < 0.85) {
        score -= 10;
      }
      if (errorRate !== null && errorRate > 1) {
        score -= 10;
      }
      if (snapshot.infrastructureMetrics.cpuUsage > 80) {
        score -= 5;
      }
      if (snapshot.infrastructureMetrics.memoryUsage > 80) {
        score -= 5;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  // ============================================================================
  // Historical Data
  // ============================================================================

  async getMetricHistory(params: {
    metricType: MetricType;
    service?: string;
    start: Date;
    end: Date;
    aggregation?: MetricAggregation;
    intervalMinutes?: number;
  }): Promise<Array<{ timestamp: Date; value: number; min?: number; max?: number }>> {
    const { metricType, service, start, end, aggregation, intervalMinutes = 5 } = params;

    const query = this.metricRepo
      .createQueryBuilder('m')
      .select(`date_trunc('minute', m.timestamp)`, 'bucket')
      .addSelect('AVG(m.value)', 'value')
      .addSelect('MIN(m.value)', 'min')
      .addSelect('MAX(m.value)', 'max')
      .where('m.timestamp BETWEEN :start AND :end', { start, end })
      .andWhere('m.metricType = :metricType', { metricType });

    if (service) {
      query.andWhere('m.service = :service', { service });
    }

    query.groupBy('bucket').orderBy('bucket', 'ASC');

    const results = await query.getRawMany();

    return results.map((r) => ({
      timestamp: new Date(r.bucket),
      value: parseFloat(r.value) || 0,
      min: parseFloat(r.min),
      max: parseFloat(r.max),
    }));
  }

  async getSnapshots(params: {
    service?: string;
    start?: Date;
    end?: Date;
    limit?: number;
  }): Promise<PerformanceSnapshot[]> {
    const query = this.snapshotRepo.createQueryBuilder('s');

    if (params.service) {
      query.andWhere('s.service = :service', { service: params.service });
    }
    if (params.start) {
      query.andWhere('s.timestamp >= :start', { start: params.start });
    }
    if (params.end) {
      query.andWhere('s.timestamp <= :end', { end: params.end });
    }

    query.orderBy('s.timestamp', 'DESC').limit(params.limit || 100);

    return query.getMany();
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private calculateSum(values: number[]): number {
    return values.reduce((a, b) => a + b, 0);
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)] ?? 0;
  }
}
