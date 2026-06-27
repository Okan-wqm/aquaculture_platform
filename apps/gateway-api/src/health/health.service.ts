import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CompositionStateService } from '../config/composition-state.service';
import { FEDERATED_SUBGRAPHS } from '../config/federated-subgraphs.generated';

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
 * Readiness check breakdown (ARCH-GW-006).
 *
 * Each sub-check reports the narrowest cause that keeps the gateway out of
 * rotation, so operators can tell "still composing" from "auth is down" from
 * "a non-critical subgraph is degraded".
 */
export interface ReadinessChecks {
  /** 'ok' once the live supergraph has composed; 'pending' before that. */
  composition: 'ok' | 'pending';
  /** 'ok' if auth is reachable; 'error' if it is not. */
  auth: 'ok' | 'error';
  /** 'ok' if every subgraph is healthy; 'degraded' if any is not. */
  subgraphs: 'ok' | 'degraded';
}

/**
 * Readiness status returned by getReadiness() (ARCH-GW-006).
 */
export interface ReadinessStatus {
  status: 'ok' | 'not_ready';
  message?: string;
  checks: ReadinessChecks;
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

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(CompositionStateService)
    private readonly compositionState: CompositionStateService,
  ) {
    this.healthCheckTimeout = this.configService.get<number>('HEALTH_CHECK_TIMEOUT_MS', 5000);
    this.cacheTtlMs = this.configService.get<number>('HEALTH_CHECK_CACHE_TTL_MS', 5000);

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
    this.serviceUrls = new Map(
      FEDERATED_SUBGRAPHS.map((subgraph) => [
        subgraph.name,
        this.configService.get(subgraph.urlEnv, subgraph.localUrl),
      ]),
    );
  }

  /**
   * Get liveness status (is the gateway running)
   */
  getLiveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Get readiness status (is the gateway ready to accept traffic).
   *
   * ARCH-GW-006: readiness now layers three checks, each short-circuiting at the
   * narrowest blocking cause:
   *
   *   1. composition — the live supergraph must have composed at least once.
   *      Until then there is no real schema to serve, so we return not_ready
   *      WITHOUT fanning out to the subgraphs (no point probing services for a
   *      schema that does not exist yet, and the deploy gate uses /health/live
   *      for liveness anyway).
   *   2. auth — the critical-path subgraph must be reachable.
   *   3. subgraphs — any other unhealthy/degraded subgraph downgrades readiness.
   *
   * /health/live is pure liveness and is unaffected by any of this.
   */
  async getReadiness(): Promise<ReadinessStatus> {
    // 1. Composition gate. Short-circuit before any subgraph fan-out.
    if (!this.compositionState.isComposed()) {
      const lastError = this.compositionState.getLastError();
      return {
        status: 'not_ready',
        message: lastError
          ? `Supergraph composition pending (last error: ${lastError})`
          : 'Supergraph composition pending',
        checks: { composition: 'pending', auth: 'ok', subgraphs: 'ok' },
      };
    }

    // 2 + 3. Composition is done — reuse the cached subgraph health sweep.
    const services = await this.checkAllServices();

    const authHealth = services.find((s) => s.name === 'auth');
    if (!authHealth || authHealth.status === 'unhealthy') {
      return {
        status: 'not_ready',
        message: 'Auth service is unavailable',
        checks: { composition: 'ok', auth: 'error', subgraphs: 'ok' },
      };
    }

    const unhealthy = services.filter(
      (s) => s.name !== 'auth' && s.status !== 'healthy',
    );
    if (unhealthy.length > 0) {
      const names = unhealthy.map((s) => s.name).join(', ');
      return {
        status: 'not_ready',
        message: `Degraded subgraphs: ${names}`,
        checks: { composition: 'ok', auth: 'ok', subgraphs: 'degraded' },
      };
    }

    return {
      status: 'ok',
      checks: { composition: 'ok', auth: 'ok', subgraphs: 'ok' },
    };
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

  private computeOverallStatus(services: ServiceHealth[]): 'healthy' | 'unhealthy' | 'degraded' {
    const unhealthyCount = services.filter((s) => s.status === 'unhealthy').length;
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

    const checks = Array.from(this.serviceUrls.keys()).map((name) => this.checkService(name));

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
      const timeout = setTimeout(() => controller.abort(), this.healthCheckTimeout);

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
            method: 'GET',
            path: new URL(healthUrl).pathname,
            audience: name,
            body: '',
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
      const status: 'healthy' | 'degraded' = responseTime > 2000 ? 'degraded' : 'healthy';

      return {
        name,
        status,
        url,
        responseTime,
        lastChecked: new Date(),
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

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
