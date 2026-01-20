import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Between } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  PerformanceMetric,
  PerformanceSnapshot,
  MetricType,
  MetricAggregation,
  MetricDimensions,
} from '../entities/performance-metric.entity';

// ============================================================================
// Interfaces
// ============================================================================

export interface ApplicationMetrics {
  avgResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  throughput: number;
  errorRate: number;
  apdexScore: number;
  activeRequests: number;
  totalRequests: number;
}

export interface DatabaseMetrics {
  activeConnections: number;
  poolSize: number;
  poolUtilization: number;
  avgQueryTime: number;
  slowQueryCount: number;
  cacheHitRatio: number;
  deadlockCount: number;
}

export interface InfrastructureMetrics {
  cpuUsage: number;
  memoryUsage: number;
  memoryTotal: number;
  diskUsage: number;
  diskTotal: number;
  networkLatency: number;
  containerCount: number;
  healthyContainers: number;
  podRestarts: number;
}

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
  { metric: MetricType.RESPONSE_TIME, warningThreshold: 500, criticalThreshold: 1000, comparison: 'gt' },
  { metric: MetricType.ERROR_RATE, warningThreshold: 1, criticalThreshold: 5, comparison: 'gt' },
  { metric: MetricType.CPU_USAGE, warningThreshold: 70, criticalThreshold: 90, comparison: 'gt' },
  { metric: MetricType.MEMORY_USAGE, warningThreshold: 80, criticalThreshold: 95, comparison: 'gt' },
  { metric: MetricType.DISK_USAGE, warningThreshold: 80, criticalThreshold: 95, comparison: 'gt' },
  { metric: MetricType.DB_CONNECTION_POOL, warningThreshold: 80, criticalThreshold: 95, comparison: 'gt' },
  { metric: MetricType.DB_QUERY_TIME, warningThreshold: 100, criticalThreshold: 500, comparison: 'gt' },
  { metric: MetricType.DB_CACHE_HIT_RATIO, warningThreshold: 80, criticalThreshold: 60, comparison: 'lt' },
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

  // In-memory metrics for real-time calculations
  private requestMetrics: Map<string, { count: number; totalTime: number; errors: number }> = new Map();
  private lastFlush: Date = new Date();

  constructor(
    @InjectRepository(PerformanceMetric)
    private readonly metricRepo: Repository<PerformanceMetric>,
    @InjectRepository(PerformanceSnapshot)
    private readonly snapshotRepo: Repository<PerformanceSnapshot>,
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

  async recordRequestMetric(
    service: string,
    endpoint: string,
    method: string,
    durationMs: number,
    isError: boolean,
  ): Promise<void> {
    const key = `${service}:${method}:${endpoint}`;
    const current = this.requestMetrics.get(key) || { count: 0, totalTime: 0, errors: 0 };

    current.count++;
    current.totalTime += durationMs;
    if (isError) current.errors++;

    this.requestMetrics.set(key, current);
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

  async getApplicationMetrics(service?: string, timeRange?: { start?: Date; end?: Date }): Promise<ApplicationMetrics> {
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

    const avgResponseTime = this.calculateAverage(responseTimeMetrics.map((m) => m.value));
    const p95ResponseTime = this.calculatePercentile(responseTimeMetrics.map((m) => m.percentiles?.p95 || m.value), 95);
    const p99ResponseTime = this.calculatePercentile(responseTimeMetrics.map((m) => m.percentiles?.p99 || m.value), 99);
    const errorRate = this.calculateAverage(errorRateMetrics.map((m) => m.value));
    const throughput = this.calculateSum(throughputMetrics.map((m) => m.value));
    const apdexScore = this.calculateAverage(apdexMetrics.map((m) => m.value));

    return {
      avgResponseTime,
      p95ResponseTime,
      p99ResponseTime,
      throughput,
      errorRate,
      apdexScore: apdexScore || 1,
      activeRequests: 0, // Would come from real-time monitoring
      totalRequests: this.calculateSum(metrics.filter((m) => m.metricType === MetricType.REQUEST_COUNT).map((m) => m.value)),
    };
  }

  async calculateApdexScore(
    satisfiedThreshold: number = 500,
    toleratedThreshold: number = 2000,
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

  async getDatabaseMetrics(database?: string, timeRange?: { start?: Date; end?: Date }): Promise<DatabaseMetrics> {
    const end = timeRange?.end || new Date();
    const start = timeRange?.start || new Date(end.getTime() - 5 * 60 * 1000);

    const query = this.metricRepo
      .createQueryBuilder('m')
      .where('m.timestamp BETWEEN :start AND :end', { start, end })
      .andWhere('m.metricType IN (:...types)', {
        types: [
          MetricType.DB_CONNECTION_POOL,
          MetricType.DB_QUERY_TIME,
          MetricType.DB_CACHE_HIT_RATIO,
          MetricType.DB_DEADLOCKS,
          MetricType.DB_ACTIVE_CONNECTIONS,
          MetricType.DB_SLOW_QUERIES,
        ],
      });

    if (database) {
      query.andWhere("m.dimensions->>'database' = :database", { database });
    }

    const metrics = await query.getMany();

    const connectionPoolMetrics = metrics.filter((m) => m.metricType === MetricType.DB_CONNECTION_POOL);
    const queryTimeMetrics = metrics.filter((m) => m.metricType === MetricType.DB_QUERY_TIME);
    const cacheHitMetrics = metrics.filter((m) => m.metricType === MetricType.DB_CACHE_HIT_RATIO);
    const deadlockMetrics = metrics.filter((m) => m.metricType === MetricType.DB_DEADLOCKS);
    const activeConnMetrics = metrics.filter((m) => m.metricType === MetricType.DB_ACTIVE_CONNECTIONS);
    const slowQueryMetrics = metrics.filter((m) => m.metricType === MetricType.DB_SLOW_QUERIES);

    const poolSize = 100; // Would come from actual config
    const activeConnections = this.calculateAverage(activeConnMetrics.map((m) => m.value)) || 0;

    return {
      activeConnections,
      poolSize,
      poolUtilization: (activeConnections / poolSize) * 100,
      avgQueryTime: this.calculateAverage(queryTimeMetrics.map((m) => m.value)) || 0,
      slowQueryCount: this.calculateSum(slowQueryMetrics.map((m) => m.value)),
      cacheHitRatio: this.calculateAverage(cacheHitMetrics.map((m) => m.value)) || 95,
      deadlockCount: this.calculateSum(deadlockMetrics.map((m) => m.value)),
    };
  }

  async getSlowQueries(
    threshold: number = 1000,
    limit: number = 20,
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

  async getInfrastructureMetrics(host?: string, timeRange?: { start?: Date; end?: Date }): Promise<InfrastructureMetrics> {
    const end = timeRange?.end || new Date();
    const start = timeRange?.start || new Date(end.getTime() - 5 * 60 * 1000);

    const query = this.metricRepo
      .createQueryBuilder('m')
      .where('m.timestamp BETWEEN :start AND :end', { start, end })
      .andWhere('m.metricType IN (:...types)', {
        types: [
          MetricType.CPU_USAGE,
          MetricType.MEMORY_USAGE,
          MetricType.DISK_USAGE,
          MetricType.NETWORK_LATENCY,
          MetricType.CONTAINER_HEALTH,
          MetricType.POD_RESTARTS,
        ],
      });

    if (host) {
      query.andWhere("m.dimensions->>'host' = :host", { host });
    }

    const metrics = await query.getMany();

    const cpuMetrics = metrics.filter((m) => m.metricType === MetricType.CPU_USAGE);
    const memoryMetrics = metrics.filter((m) => m.metricType === MetricType.MEMORY_USAGE);
    const diskMetrics = metrics.filter((m) => m.metricType === MetricType.DISK_USAGE);
    const networkMetrics = metrics.filter((m) => m.metricType === MetricType.NETWORK_LATENCY);
    const containerMetrics = metrics.filter((m) => m.metricType === MetricType.CONTAINER_HEALTH);
    const podRestartMetrics = metrics.filter((m) => m.metricType === MetricType.POD_RESTARTS);

    return {
      cpuUsage: this.calculateAverage(cpuMetrics.map((m) => m.value)) || 0,
      memoryUsage: this.calculateAverage(memoryMetrics.map((m) => m.value)) || 0,
      memoryTotal: 16 * 1024 * 1024 * 1024, // Would come from actual config
      diskUsage: this.calculateAverage(diskMetrics.map((m) => m.value)) || 0,
      diskTotal: 500 * 1024 * 1024 * 1024, // Would come from actual config
      networkLatency: this.calculateAverage(networkMetrics.map((m) => m.value)) || 0,
      containerCount: containerMetrics.length > 0 ? containerMetrics[containerMetrics.length - 1]?.sampleCount ?? 0 : 0,
      healthyContainers: containerMetrics.length > 0 ? containerMetrics[containerMetrics.length - 1]?.value ?? 0 : 0,
      podRestarts: this.calculateSum(podRestartMetrics.map((m) => m.value)),
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
  ): Promise<Array<{ service: string; avgResponseTime: number; errorRate: number; requestCount: number }>> {
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

  async checkThresholds(
    service?: string,
  ): Promise<Array<{ metric: string; threshold: number; currentValue: number; severity: 'warning' | 'critical' }>> {
    const alerts: Array<{ metric: string; threshold: number; currentValue: number; severity: 'warning' | 'critical' }> = [];

    const [appMetrics, dbMetrics, infraMetrics] = await Promise.all([
      this.getApplicationMetrics(service),
      this.getDatabaseMetrics(),
      this.getInfrastructureMetrics(),
    ]);

    const metricValues: Record<string, number> = {
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
      if (value === undefined) continue;

      const isCritical = this.compareValue(value, threshold.criticalThreshold, threshold.comparison);
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

  private compareValue(value: number, threshold: number, comparison: 'gt' | 'lt' | 'gte' | 'lte'): boolean {
    switch (comparison) {
      case 'gt': return value > threshold;
      case 'lt': return value < threshold;
      case 'gte': return value >= threshold;
      case 'lte': return value <= threshold;
      default: return false;
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

  @Cron(CronExpression.EVERY_MINUTE)
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
        timestamp: new Date(),
        applicationMetrics: appMetrics,
        databaseMetrics: dbMetrics,
        infrastructureMetrics: infraMetrics,
        alerts,
        overallHealthScore: healthScore,
      });

      await this.snapshotRepo.save(snapshot);

      // Flush any pending metrics
      await this.flushMetrics();

      // Aggregate request metrics
      await this.aggregateRequestMetrics();

      this.logger.debug('Created performance snapshot');
    } catch (error) {
      this.logger.error('Failed to create performance snapshot', error);
    }
  }

  private async aggregateRequestMetrics(): Promise<void> {
    const now = new Date();

    for (const [key, data] of this.requestMetrics.entries()) {
      const [service, method, endpoint] = key.split(':');

      if (data.count > 0) {
        await this.recordMetric({
          metricType: MetricType.RESPONSE_TIME,
          name: 'request_response_time',
          value: data.totalTime / data.count,
          unit: 'ms',
          service,
          dimensions: { method, endpoint },
          sampleCount: data.count,
          timestamp: now,
        });

        await this.recordMetric({
          metricType: MetricType.REQUEST_COUNT,
          name: 'request_count',
          value: data.count,
          aggregation: MetricAggregation.SUM,
          service,
          dimensions: { method, endpoint },
          timestamp: now,
        });

        if (data.errors > 0) {
          await this.recordMetric({
            metricType: MetricType.ERROR_RATE,
            name: 'error_rate',
            value: (data.errors / data.count) * 100,
            unit: 'percent',
            service,
            dimensions: { method, endpoint },
            timestamp: now,
          });
        }
      }
    }

    this.requestMetrics.clear();
    this.lastFlush = now;
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

    // Deduct for poor metrics if snapshot available
    if (snapshot) {
      if (snapshot.applicationMetrics.apdexScore < 0.85) {
        score -= 10;
      }
      if (snapshot.applicationMetrics.errorRate > 1) {
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
  // Cleanup
  // ============================================================================

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanupOldMetrics(): Promise<void> {
    const retentionDays = 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    await this.metricRepo.delete({ timestamp: LessThan(cutoff) });
    await this.snapshotRepo.delete({ timestamp: LessThan(cutoff) });

    this.logger.log(`Cleaned up metrics older than ${retentionDays} days`);
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
