import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';

/**
 * Health check result for a single service (internal use)
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
 * Overall health status (internal - full details)
 */
export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
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
 * Public health status (sanitized - no internal details)
 * SECURITY: Only exposes overall status, no individual service breakdown.
 * Service-level details are available on the authenticated /health/detail endpoint.
 */
export interface PublicHealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
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
  private cachedResults: ServiceHealth[] | null = null;
  private cacheExpiry = 0;
  private readonly cacheTtlMs: number;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    this.healthCheckTimeout = this.configService.get<number>(
      'HEALTH_CHECK_TIMEOUT_MS',
      5000,
    );
    this.cacheTtlMs = this.configService.get<number>(
      'HEALTH_CHECK_CACHE_TTL_MS',
      5000,
    );

    /**
     * ARCH-GW-003: Health check service URL map must mirror the subgraph list in
     * app.module.ts (RetryableIntrospectAndCompose). If a service is registered
     * as a federated subgraph, it MUST be included here so that /health/detail
     * reports accurate downstream status.
     *
     * BUG-4 FIX (app.module.ts): notification-service was re-added as a federated
     * subgraph because it exposes ApolloFederationDriver queries. It must therefore
     * be included in health checks.
     *
     * ADR-012: messaging-service is a federated subgraph added in the messaging
     * service implementation. It must be included in health checks.
     */
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
      [
        'hydroponics',
        this.configService.get(
          'HYDROPONICS_SERVICE_URL',
          'http://localhost:4007/graphql',
        ),
      ],
      [
        'config',
        this.configService.get(
          'CONFIG_SERVICE_URL',
          'http://localhost:3007/graphql',
        ),
      ],
      [
        'notification',
        this.configService.get(
          'NOTIFICATION_SERVICE_URL',
          'http://localhost:4008/graphql',
        ),
      ],
      [
        'messaging',
        this.configService.get(
          'MESSAGING_SERVICE_URL',
          'http://messaging-service:3000/graphql',
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
   * Get comprehensive health status (internal - requires auth)
   */
  async getHealth(): Promise<HealthStatus> {
    const services = await this.checkAllServices();
    const memoryUsage = process.memoryUsage();
    const overallStatus = this.computeOverallStatus(services);

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
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
   * Get sanitized health status (public - no sensitive details)
   * SECURITY: Only returns overall status. Does not expose individual service
   * names, statuses, URLs, memory, uptime, version, or errors.
   * Exposing per-service status reveals architecture details and confirms
   * which subsystems are degraded, aiding targeted attacks.
   */
  async getPublicHealth(): Promise<PublicHealthStatus> {
    const services = await this.checkAllServices();
    const overallStatus = this.computeOverallStatus(services);

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
    };
  }

  private computeOverallStatus(
    services: ServiceHealth[],
  ): 'healthy' | 'unhealthy' | 'degraded' {
    const unhealthyCount = services.filter(
      (s) => s.status === 'unhealthy',
    ).length;
    const degradedCount = services.filter((s) => s.status === 'degraded').length;

    if (unhealthyCount > 0) {
      return unhealthyCount > services.length / 2 ? 'unhealthy' : 'degraded';
    }
    if (degradedCount > 0) {
      return 'degraded';
    }
    return 'healthy';
  }

  /**
   * Check health of all services
   * Results are cached for 5 seconds to avoid 7+ parallel HTTP calls per probe invocation
   * across multiple replicas (reduces ~504 upstream calls/min to ~36).
   */
  private async checkAllServices(): Promise<ServiceHealth[]> {
    const now = Date.now();
    if (this.cachedResults && now < this.cacheExpiry) {
      return this.cachedResults;
    }

    const checks = Array.from(this.serviceUrls.keys()).map((name) =>
      this.checkService(name),
    );

    const results = await Promise.all(checks);
    this.cachedResults = results;
    this.cacheExpiry = now + this.cacheTtlMs;

    return results;
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

      // SECURITY (HIGH-003): keep the platform invariant — every internal
      // HTTP call signed. Health probes use empty tenantId to declare
      // explicitly that no tenant context applies (vs. silently omitting).
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...buildSignedInternalHeaders({
            serviceName: 'gateway-api',
            tenantId: '',
          }),
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
