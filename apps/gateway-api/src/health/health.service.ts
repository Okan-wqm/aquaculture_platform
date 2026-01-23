import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Health check result for a single service
 */
export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  url: string;
  responseTime?: number;
  error?: string;
  lastChecked: Date;
}

/**
 * Overall health status
 */
export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: Date;
  uptime: number;
  version: string;
  services: ServiceHealth[];
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
}

/**
 * Health Service
 * Monitors health of all downstream services
 * Provides comprehensive health checks for kubernetes probes
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();
  private readonly serviceUrls: Map<string, string>;
  private readonly healthCheckTimeout: number;

  constructor(private readonly configService: ConfigService) {
    this.healthCheckTimeout = this.configService.get<number>(
      'HEALTH_CHECK_TIMEOUT_MS',
      5000,
    );

    this.serviceUrls = new Map([
      [
        'auth',
        this.configService.get(
          'AUTH_SERVICE_URL',
          'http://localhost:3001/graphql',
        ),
      ],
      [
        'farm',
        this.configService.get(
          'FARM_SERVICE_URL',
          'http://localhost:3002/graphql',
        ),
      ],
      [
        'sensor',
        this.configService.get(
          'SENSOR_SERVICE_URL',
          'http://localhost:3003/graphql',
        ),
      ],
      [
        'alert',
        this.configService.get(
          'ALERT_SERVICE_URL',
          'http://localhost:3004/graphql',
        ),
      ],
      [
        'hr',
        this.configService.get('HR_SERVICE_URL', 'http://localhost:3005/graphql'),
      ],
      [
        'billing',
        this.configService.get(
          'BILLING_SERVICE_URL',
          'http://localhost:3006/graphql',
        ),
      ],
    ]);
  }

  /**
   * Get liveness status (is the gateway running)
   */
  getLiveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Get readiness status (is the gateway ready to accept traffic)
   */
  async getReadiness(): Promise<{ status: 'ok' | 'not_ready'; message?: string }> {
    // Check if we can reach at least the auth service
    const authHealth = await this.checkService('auth');

    if (authHealth.status === 'unhealthy') {
      return {
        status: 'not_ready',
        message: 'Auth service is unavailable',
      };
    }

    return { status: 'ok' };
  }

  /**
   * Get comprehensive health status
   */
  async getHealth(): Promise<HealthStatus> {
    const services = await this.checkAllServices();
    const memoryUsage = process.memoryUsage();

    const unhealthyCount = services.filter(
      (s) => s.status === 'unhealthy',
    ).length;
    const degradedCount = services.filter((s) => s.status === 'degraded').length;

    let overallStatus: 'healthy' | 'unhealthy' | 'degraded' = 'healthy';
    if (unhealthyCount > 0) {
      // If more than half services are unhealthy, overall is unhealthy
      overallStatus =
        unhealthyCount > services.length / 2 ? 'unhealthy' : 'degraded';
    } else if (degradedCount > 0) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      timestamp: new Date(),
      uptime: Date.now() - this.startTime,
      version: this.configService.get('APP_VERSION', '1.0.0'),
      services,
      memory: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        rss: memoryUsage.rss,
      },
    };
  }

  /**
   * Check health of all services
   */
  private async checkAllServices(): Promise<ServiceHealth[]> {
    const checks = Array.from(this.serviceUrls.keys()).map((name) =>
      this.checkService(name),
    );

    return Promise.all(checks);
  }

  /**
   * Check health of a single service
   */
  private async checkService(name: string): Promise<ServiceHealth> {
    const url = this.serviceUrls.get(name);

    if (!url) {
      return {
        name,
        status: 'unhealthy',
        url: 'unknown',
        error: 'Service URL not configured',
        lastChecked: new Date(),
      };
    }

    const healthUrl = url.replace('/graphql', '/health');
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.healthCheckTimeout,
      );

      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      clearTimeout(timeout);

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        return {
          name,
          status: 'unhealthy',
          url,
          responseTime,
          error: `HTTP ${response.status}`,
          lastChecked: new Date(),
        };
      }

      // If response is slow, mark as degraded
      const status: 'healthy' | 'degraded' =
        responseTime > 2000 ? 'degraded' : 'healthy';

      return {
        name,
        status,
        url,
        responseTime,
        lastChecked: new Date(),
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.warn(`Health check failed for ${name}: ${errorMessage}`);

      return {
        name,
        status: 'unhealthy',
        url,
        responseTime,
        error: errorMessage,
        lastChecked: new Date(),
      };
    }
  }
}
