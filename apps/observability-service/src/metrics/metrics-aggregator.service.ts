import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PrometheusService } from '../prometheus/prometheus.service';

export interface AggregatedMetrics {
  timestamp: Date;
  status: 'ok' | 'partial' | 'error';
  tenants: TenantMetrics;
  sensors: SensorMetrics;
  alerts: AlertMetrics;
  system: SystemMetrics;
}

export interface TenantMetrics {
  total: number;
  active: number;
  suspended: number;
  byTier: Record<string, number>;
}

export interface SensorMetrics {
  totalSensors: number;
  activeSensors: number;
  readingsLast24h: number;
  readingsPerMinute: number;
  byType: Record<string, number>;
}

export interface AlertMetrics {
  totalAlerts: number;
  triggeredLast24h: number;
  bySeverity: Record<string, number>;
  avgResponseTime: number;
}

export interface SystemMetrics {
  services: ServiceStatus[];
  totalApiCalls24h: number;
  avgLatency: number;
  errorRate: number;
}

export interface ServiceStatus {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  uptime: number;
  lastCheck: Date;
}

/**
 * Safely execute a database query and return a fallback on error.
 * This prevents a single failing query from crashing the entire aggregation cycle.
 */
async function safeQuery<T>(
  dataSource: DataSource,
  query: string,
  params: unknown[],
  fallback: T,
  logger: Logger,
  label: string,
): Promise<T> {
  try {
    return await dataSource.query(query, params);
  } catch (error) {
    logger.warn(`${label} query failed: ${(error as Error).message}`);
    return fallback;
  }
}

@Injectable()
export class MetricsAggregatorService {
  private readonly logger = new Logger(MetricsAggregatorService.name);
  private lastAggregation: AggregatedMetrics | null = null;
  private isRunning = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly prometheusService: PrometheusService,
  ) {}

  /**
   * Aggregate metrics every minute with concurrency guard
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async aggregateMetrics(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Skipping aggregation — previous run still in progress');
      return;
    }

    this.isRunning = true;
    let status: 'ok' | 'partial' | 'error' = 'ok';

    try {
      const results = await Promise.allSettled([
        this.aggregateTenantMetrics(),
        this.aggregateSensorMetrics(),
        this.aggregateAlertMetrics(),
        this.aggregateSystemMetrics(),
      ]);

      // Extract values, using defaults for any failed aggregation
      const tenants = results[0].status === 'fulfilled'
        ? results[0].value
        : this.defaultTenantMetrics();
      const sensors = results[1].status === 'fulfilled'
        ? results[1].value
        : this.defaultSensorMetrics();
      const alerts = results[2].status === 'fulfilled'
        ? results[2].value
        : this.defaultAlertMetrics();
      const system = results[3].status === 'fulfilled'
        ? results[3].value
        : this.defaultSystemMetrics();

      // Check if any aggregation failed
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        status = failures.length === results.length ? 'error' : 'partial';
        for (const f of failures) {
          if (f.status === 'rejected') {
            this.logger.warn(`Aggregation sub-task failed: ${f.reason}`);
          }
        }
      }

      this.lastAggregation = {
        timestamp: new Date(),
        status,
        tenants,
        sensors,
        alerts,
        system,
      };

      // Update Prometheus metrics
      this.updatePrometheusMetrics(this.lastAggregation);

      this.logger.debug(`Metrics aggregation completed (status=${status})`);
    } catch (error) {
      this.logger.error(
        `Metrics aggregation failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get latest aggregated metrics
   */
  getAggregatedMetrics(): AggregatedMetrics | null {
    return this.lastAggregation;
  }

  /**
   * Get metrics for a specific tenant
   */
  async getTenantMetrics(tenantId: string): Promise<{
    status: 'ok' | 'error';
    users: number;
    farms: number;
    sensors: number;
    alertRules: number;
    apiCalls24h: number;
    storageUsed: number;
  }> {
    try {
      // Query user count from tenant's schema
      const userResult = await safeQuery<{ count: string }[]>(
        this.dataSource,
        `SELECT count(*)::text as count FROM auth.users WHERE "tenantId" = $1`,
        [tenantId],
        [{ count: '0' }],
        this.logger,
        'tenant-users',
      );

      // Query farm count
      const farmResult = await safeQuery<{ count: string }[]>(
        this.dataSource,
        `SELECT count(*)::text as count FROM farm.farms WHERE "tenantId" = $1`,
        [tenantId],
        [{ count: '0' }],
        this.logger,
        'tenant-farms',
      );

      // Query sensor count from tenant-specific schema
      const sensorResult = await safeQuery<{ count: string }[]>(
        this.dataSource,
        `SELECT count(*)::text as count FROM sensor.sensors WHERE tenant_id = $1`,
        [tenantId],
        [{ count: '0' }],
        this.logger,
        'tenant-sensors',
      );

      return {
        status: 'ok',
        users: parseInt(userResult[0]?.count || '0', 10),
        farms: parseInt(farmResult[0]?.count || '0', 10),
        sensors: parseInt(sensorResult[0]?.count || '0', 10),
        alertRules: 0, // Alert rules table may not be directly accessible
        apiCalls24h: 0, // Would require request logging infrastructure
        storageUsed: 0, // Would require MinIO API integration
      };
    } catch (error) {
      this.logger.warn(
        `Failed to get tenant metrics for ${tenantId}: ${(error as Error).message}`,
      );
      return {
        status: 'error',
        users: 0,
        farms: 0,
        sensors: 0,
        alertRules: 0,
        apiCalls24h: 0,
        storageUsed: 0,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Aggregation methods — each queries the DB with safe fallbacks
  // ---------------------------------------------------------------------------

  private async aggregateTenantMetrics(): Promise<TenantMetrics> {
    // Query tenant counts by status from auth schema
    const statusRows = await safeQuery<{ status: string; count: string }[]>(
      this.dataSource,
      `SELECT status, count(*)::text as count
       FROM auth.tenants
       GROUP BY status`,
      [],
      [],
      this.logger,
      'tenant-status',
    );

    let total = 0;
    let active = 0;
    let suspended = 0;

    for (const row of statusRows) {
      const count = parseInt(row.count, 10);
      total += count;
      if (row.status === 'ACTIVE') active = count;
      if (row.status === 'SUSPENDED') suspended = count;
    }

    // Query tenant counts by tier/plan
    const tierRows = await safeQuery<{ tier: string; count: string }[]>(
      this.dataSource,
      `SELECT COALESCE(plan, 'free') as tier, count(*)::text as count
       FROM auth.tenants
       WHERE status = 'ACTIVE'
       GROUP BY plan`,
      [],
      [],
      this.logger,
      'tenant-tier',
    );

    const byTier: Record<string, number> = {};
    for (const row of tierRows) {
      byTier[row.tier] = parseInt(row.count, 10);
    }

    return { total, active, suspended, byTier };
  }

  private async aggregateSensorMetrics(): Promise<SensorMetrics> {
    // Total sensors across all tenants
    const totalResult = await safeQuery<{ count: string }[]>(
      this.dataSource,
      `SELECT count(*)::text as count FROM sensor.sensors`,
      [],
      [{ count: '0' }],
      this.logger,
      'sensor-total',
    );

    // Active sensors (had a reading in last hour)
    const activeResult = await safeQuery<{ count: string }[]>(
      this.dataSource,
      `SELECT count(DISTINCT sensor_id)::text as count
       FROM sensor.sensor_readings
       WHERE created_at > NOW() - INTERVAL '1 hour'`,
      [],
      [{ count: '0' }],
      this.logger,
      'sensor-active',
    );

    // Readings in last 24h
    const readingsResult = await safeQuery<{ count: string }[]>(
      this.dataSource,
      `SELECT count(*)::text as count
       FROM sensor.sensor_readings
       WHERE created_at > NOW() - INTERVAL '24 hours'`,
      [],
      [{ count: '0' }],
      this.logger,
      'sensor-readings-24h',
    );

    // Readings per minute (last 5 minutes average)
    const rpmResult = await safeQuery<{ rpm: string }[]>(
      this.dataSource,
      `SELECT COALESCE(count(*)::float / GREATEST(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 60, 1), 0)::text as rpm
       FROM sensor.sensor_readings
       WHERE created_at > NOW() - INTERVAL '5 minutes'`,
      [],
      [{ rpm: '0' }],
      this.logger,
      'sensor-rpm',
    );

    // Sensors by type
    const typeRows = await safeQuery<{ type: string; count: string }[]>(
      this.dataSource,
      `SELECT COALESCE(type, 'unknown') as type, count(*)::text as count
       FROM sensor.sensors
       GROUP BY type`,
      [],
      [],
      this.logger,
      'sensor-by-type',
    );

    const byType: Record<string, number> = {};
    for (const row of typeRows) {
      byType[row.type] = parseInt(row.count, 10);
    }

    return {
      totalSensors: parseInt(totalResult[0]?.count || '0', 10),
      activeSensors: parseInt(activeResult[0]?.count || '0', 10),
      readingsLast24h: parseInt(readingsResult[0]?.count || '0', 10),
      readingsPerMinute: parseFloat(rpmResult[0]?.rpm || '0'),
      byType,
    };
  }

  private async aggregateAlertMetrics(): Promise<AlertMetrics> {
    // Total alert rules
    const totalResult = await safeQuery<{ count: string }[]>(
      this.dataSource,
      `SELECT count(*)::text as count
       FROM alert.alert_rules`,
      [],
      [{ count: '0' }],
      this.logger,
      'alert-total',
    );

    // Alerts triggered in last 24h
    const triggeredResult = await safeQuery<{ count: string }[]>(
      this.dataSource,
      `SELECT count(*)::text as count
       FROM alert.alert_incidents
       WHERE created_at > NOW() - INTERVAL '24 hours'`,
      [],
      [{ count: '0' }],
      this.logger,
      'alert-triggered-24h',
    );

    // Alerts by severity
    const severityRows = await safeQuery<{ severity: string; count: string }[]>(
      this.dataSource,
      `SELECT COALESCE(severity, 'unknown') as severity, count(*)::text as count
       FROM alert.alert_incidents
       WHERE created_at > NOW() - INTERVAL '24 hours'
       GROUP BY severity`,
      [],
      [],
      this.logger,
      'alert-by-severity',
    );

    const bySeverity: Record<string, number> = {};
    for (const row of severityRows) {
      bySeverity[row.severity] = parseInt(row.count, 10);
    }

    return {
      totalAlerts: parseInt(totalResult[0]?.count || '0', 10),
      triggeredLast24h: parseInt(triggeredResult[0]?.count || '0', 10),
      bySeverity,
      avgResponseTime: 0, // Would require acknowledgedAt - createdAt tracking
    };
  }

  private async aggregateSystemMetrics(): Promise<SystemMetrics> {
    // Check service health by attempting lightweight HTTP calls
    const serviceNames = [
      'gateway-api',
      'auth-service',
      'farm-service',
      'sensor-service',
      'alert-engine',
      'notification-service',
      'billing-service',
      'config-service',
      'admin-api-service',
    ];

    // Map service names to their Docker network hostnames
    const serviceHosts: Record<string, string> = {
      'gateway-api': 'gateway-api',
      'auth-service': 'auth-service',
      'farm-service': 'farm-service',
      'sensor-service': 'sensor-service',
      'alert-engine': 'alert-engine',
      'notification-service': 'notification-service',
      'billing-service': 'billing-service',
      'config-service': 'config-service',
      'admin-api-service': 'admin-api-service',
    };

    const services: ServiceStatus[] = await Promise.all(
      serviceNames.map(async (name) => {
        const host = serviceHosts[name] || name;
        const healthUrl = `http://${host}:3000/health/live`;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);

          const startTime = Date.now();
          const response = await fetch(healthUrl, {
            method: 'GET',
            signal: controller.signal,
          });
          clearTimeout(timeout);

          const responseTime = Date.now() - startTime;
          const isHealthy = response.ok;

          return {
            name,
            status: isHealthy
              ? (responseTime > 2000 ? 'degraded' as const : 'healthy' as const)
              : ('unhealthy' as const),
            uptime: 0, // Would need per-service tracking
            lastCheck: new Date(),
          };
        } catch {
          return {
            name,
            status: 'unknown' as const,
            uptime: 0,
            lastCheck: new Date(),
          };
        }
      }),
    );

    return {
      services,
      totalApiCalls24h: 0, // Would require centralized request logging
      avgLatency: 0,
      errorRate: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Default (fallback) values for when a sub-aggregation fails
  // ---------------------------------------------------------------------------

  private defaultTenantMetrics(): TenantMetrics {
    return { total: 0, active: 0, suspended: 0, byTier: {} };
  }

  private defaultSensorMetrics(): SensorMetrics {
    return {
      totalSensors: 0,
      activeSensors: 0,
      readingsLast24h: 0,
      readingsPerMinute: 0,
      byType: {},
    };
  }

  private defaultAlertMetrics(): AlertMetrics {
    return {
      totalAlerts: 0,
      triggeredLast24h: 0,
      bySeverity: {},
      avgResponseTime: 0,
    };
  }

  private defaultSystemMetrics(): SystemMetrics {
    return {
      services: [],
      totalApiCalls24h: 0,
      avgLatency: 0,
      errorRate: 0,
    };
  }

  private updatePrometheusMetrics(metrics: AggregatedMetrics): void {
    // Update tenant metrics per status, then per tier within active status
    this.prometheusService.setTenantCount('active', 'all', metrics.tenants.active);
    this.prometheusService.setTenantCount('suspended', 'all', metrics.tenants.suspended);

    Object.entries(metrics.tenants.byTier).forEach(([tier, count]) => {
      this.prometheusService.setTenantCount('active', tier, count);
    });

    // Update sensor metrics by type
    Object.entries(metrics.sensors.byType).forEach(([sensorType, count]) => {
      if (count > 0) {
        this.prometheusService.recordSensorReading(sensorType);
      }
    });
  }
}
