import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PrometheusService } from '../prometheus/prometheus.service';

export interface AggregatedMetrics {
  timestamp: Date;
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
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  lastCheck: Date;
}

@Injectable()
export class MetricsAggregatorService implements OnModuleInit {
  private readonly logger = new Logger(MetricsAggregatorService.name);
  private lastAggregation: AggregatedMetrics | null = null;

  constructor(
    @InjectDataSource()
    _dataSource: DataSource,
    private readonly prometheusService: PrometheusService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Initial aggregation
    await this.aggregateMetrics();
  }

  /**
   * Aggregate metrics every minute
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async aggregateMetrics(): Promise<void> {
    try {
      const [tenants, sensors, alerts, system] = await Promise.all([
        this.aggregateTenantMetrics(),
        this.aggregateSensorMetrics(),
        this.aggregateAlertMetrics(),
        this.aggregateSystemMetrics(),
      ]);

      this.lastAggregation = {
        timestamp: new Date(),
        tenants,
        sensors,
        alerts,
        system,
      };

      // Update Prometheus metrics
      this.updatePrometheusMetrics(this.lastAggregation);

      this.logger.debug('Metrics aggregation completed');
    } catch (error) {
      this.logger.error(
        `Metrics aggregation failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
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
  async getTenantMetrics(_tenantId: string): Promise<{
    users: number;
    farms: number;
    sensors: number;
    alertRules: number;
    apiCalls24h: number;
    storageUsed: number;
  }> {
    // In real implementation, query actual tables
    return {
      users: 0,
      farms: 0,
      sensors: 0,
      alertRules: 0,
      apiCalls24h: 0,
      storageUsed: 0,
    };
  }

  private async aggregateTenantMetrics(): Promise<TenantMetrics> {
    try {
      // Query tenant counts from admin database
      // In real implementation, this would query the tenants table
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
    } catch {
      return {
        total: 0,
        active: 0,
        suspended: 0,
        byTier: {},
      };
    }
  }

  private async aggregateSensorMetrics(): Promise<SensorMetrics> {
    try {
      // Query sensor metrics
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
    } catch {
      return {
        totalSensors: 0,
        activeSensors: 0,
        readingsLast24h: 0,
        readingsPerMinute: 0,
        byType: {},
      };
    }
  }

  private async aggregateAlertMetrics(): Promise<AlertMetrics> {
    try {
      // Query alert metrics
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
    } catch {
      return {
        totalAlerts: 0,
        triggeredLast24h: 0,
        bySeverity: {},
        avgResponseTime: 0,
      };
    }
  }

  private async aggregateSystemMetrics(): Promise<SystemMetrics> {
    const services: ServiceStatus[] = [
      { name: 'gateway-api', status: 'healthy', uptime: 99.9, lastCheck: new Date() },
      { name: 'auth-service', status: 'healthy', uptime: 99.9, lastCheck: new Date() },
      { name: 'farm-service', status: 'healthy', uptime: 99.9, lastCheck: new Date() },
      { name: 'sensor-service', status: 'healthy', uptime: 99.9, lastCheck: new Date() },
      { name: 'alert-engine', status: 'healthy', uptime: 99.9, lastCheck: new Date() },
      { name: 'notification-service', status: 'healthy', uptime: 99.9, lastCheck: new Date() },
      { name: 'billing-service', status: 'healthy', uptime: 99.9, lastCheck: new Date() },
      { name: 'config-service', status: 'healthy', uptime: 99.9, lastCheck: new Date() },
      { name: 'admin-api-service', status: 'healthy', uptime: 99.9, lastCheck: new Date() },
    ];

    return {
      services,
      totalApiCalls24h: 0,
      avgLatency: 0,
      errorRate: 0,
    };
  }

  private updatePrometheusMetrics(metrics: AggregatedMetrics): void {
    // Update tenant metrics
    Object.entries(metrics.tenants.byTier).forEach(([tier, count]) => {
      this.prometheusService.setTenantCount('active', tier, count);
    });

    // Update sensor metrics
    Object.entries(metrics.sensors.byType).forEach(([_type, _count]) => {
      // Would update per-type metrics in real implementation
    });
  }
}
