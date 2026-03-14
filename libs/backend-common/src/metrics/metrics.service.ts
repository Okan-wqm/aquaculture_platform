import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import * as client from 'prom-client';

/**
 * ServiceMetricsService
 *
 * Per-service Prometheus metrics provider. Each microservice gets its own
 * instance with a dedicated registry. This avoids conflicts with the
 * central observability-service's PrometheusService.
 *
 * Provides:
 * - Default Node.js metrics (GC, event loop, memory)
 * - HTTP request duration histogram (with route normalization)
 * - HTTP requests total counter
 * - HTTP requests in-flight gauge
 */
@Injectable()
export class ServiceMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServiceMetricsService.name);
  private readonly registry: client.Registry;
  private defaultMetricsDispose: (() => void) | null = null;

  // Cached output to avoid blocking event loop on every scrape
  private cachedMetrics: string | null = null;
  private cacheTimestamp = 0;
  private readonly cacheTtlMs = 5_000;

  // HTTP metrics
  private httpRequestDuration!: client.Histogram;
  private httpRequestsTotal!: client.Counter;
  private httpRequestsInFlight!: client.Gauge;

  constructor() {
    this.registry = new client.Registry();
  }

  onModuleInit(): void {
    // Clear global default registry to prevent duplicate metric errors
    // when multiple modules or tests register default metrics
    client.register.clear();
    this.registry.clear();
    this.initializeMetrics();
    this.startDefaultMetrics();
    this.logger.log('Service metrics initialized');
  }

  onModuleDestroy(): void {
    if (this.defaultMetricsDispose) {
      this.defaultMetricsDispose();
      this.defaultMetricsDispose = null;
    }
    this.registry.clear();
    this.logger.log('Service metrics cleaned up');
  }

  private initializeMetrics(): void {
    this.httpRequestDuration = new client.Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new client.Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.httpRequestsInFlight = new client.Gauge({
      name: 'http_requests_in_flight',
      help: 'Number of HTTP requests currently being processed',
      registers: [this.registry],
    });
  }

  private startDefaultMetrics(): void {
    this.defaultMetricsDispose = client.collectDefaultMetrics({
      register: this.registry,
      prefix: 'nodejs_',
    }) as unknown as (() => void);
  }

  /**
   * Get all metrics in Prometheus text exposition format.
   * Cached for 5 seconds to avoid blocking the event loop on large registries.
   */
  async getMetrics(): Promise<string> {
    const now = Date.now();
    if (this.cachedMetrics && now - this.cacheTimestamp < this.cacheTtlMs) {
      return this.cachedMetrics;
    }
    this.cachedMetrics = await this.registry.metrics();
    this.cacheTimestamp = now;
    return this.cachedMetrics;
  }

  /**
   * Get the content type for Prometheus scrape responses.
   */
  getContentType(): string {
    return this.registry.contentType;
  }

  /**
   * Record an HTTP request observation.
   * Called by MetricsMiddleware on response finish.
   */
  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    const labels = {
      method,
      route,
      status_code: String(statusCode),
    };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }

  /**
   * Increment in-flight request count.
   */
  incInFlight(): void {
    this.httpRequestsInFlight.inc();
  }

  /**
   * Decrement in-flight request count.
   */
  decInFlight(): void {
    this.httpRequestsInFlight.dec();
  }
}
