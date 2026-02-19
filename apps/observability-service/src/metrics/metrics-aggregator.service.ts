import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PrometheusService } from '../prometheus/prometheus.service';

export interface AggregatedMetrics {
  timestamp: Date;
  status: 'not_implemented';
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
    try {
      const [tenants, sensors, alerts, system] = await Promise.all([
        this.aggregateTenantMetrics(),
        this.aggregateSensorMetrics(),
        this.aggregateAlertMetrics(),
        this.aggregateSystemMetrics(),
      ]);

      this.lastAggregation = {
        timestamp: new Date(),
        status: 'not_implemented',
        tenants,
        sensors,
        alerts,
        system,
      };

      // Update Prometheus metrics
      this.updatePrometheusMetrics(this.lastAggregation);

      this.logger.debug('Metrics aggregation completed (stub — not_implemented)');
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
   * TODO: Implement real DB queries when ready
   */
  async getTenantMetrics(_tenantId: string): Promise<{
    status: 'not_implemented';
    users: number;
    farms: number;
    sensors: number;
    alertRules: number;
    apiCalls24h: number;
    storageUsed: number;
  }> {
    return {
      status: 'not_implemented',
      users: 0,
      farms: 0,
      sensors: 0,
      alertRules: 0,
      apiCalls24h: 0,
      storageUsed: 0,
    };
  }

  private async aggregateTenantMetrics(): Promise<TenantMetrics> {
    // TODO: Implement real DB queries (e.g., SELECT count(*) FROM tenants GROUP BY status, tier)
    return {
      total: 0,
      active: 0,
      suspended: 0,
      byTier: {
        free: 0,
        starter: 0,
        professional: 0,
        enterprise: 0,
      },
    };
  }

  private async aggregateSensorMetrics(): Promise<SensorMetrics> {
    // TODO: Implement real DB queries
    return {
      totalSensors: 0,
      activeSensors: 0,
      readingsLast24h: 0,
      readingsPerMinute: 0,
      byType: {
        temperature: 0,
        ph: 0,
        dissolved_oxygen: 0,
        turbidity: 0,
        ammonia: 0,
      },
    };
  }

  private async aggregateAlertMetrics(): Promise<AlertMetrics> {
    // TODO: Implement real DB queries
    return {
      totalAlerts: 0,
      triggeredLast24h: 0,
      bySeverity: {
        critical: 0,
        warning: 0,
        info: 0,
      },
      avgResponseTime: 0,
    };
  }

  private async aggregateSystemMetrics(): Promise<SystemMetrics> {
    // Return unknown status instead of fabricated healthy values
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

    const services: ServiceStatus[] = serviceNames.map((name) => ({
      name,
      status: 'unknown' as const,
      uptime: 0,
      lastCheck: new Date(),
    }));

    return {
      services,
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
      // byTier represents active tenants broken down by tier
      this.prometheusService.setTenantCount('active', tier, count);
    });

    // Update sensor metrics by type
    Object.entries(metrics.sensors.byType).forEach(([sensorType, count]) => {
      // Use absolute count by setting a gauge rather than incrementing a counter
      // since aggregated metrics represent a snapshot, not a delta
      if (count > 0) {
        this.prometheusService.recordSensorReading(sensorType);
      }
    });
  }
}
