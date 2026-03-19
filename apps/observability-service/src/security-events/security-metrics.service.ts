import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import * as client from 'prom-client';

/**
 * SecurityMetricsService — owns the `security_events_total` Prometheus counter.
 *
 * Separated from PrometheusService so the metric lifecycle is co-located with
 * the consumer module and does not pollute the platform-wide metrics class.
 */
@Injectable()
export class SecurityMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SecurityMetricsService.name);
  private registry!: client.Registry;
  private securityEventsTotal!: client.Counter;

  /**
   * We register into the *default* prom-client registry so the
   * PrometheusService (which collects from its own registry) and
   * the global `/metrics` endpoint both expose the counter.
   *
   * If the observability service ever uses a custom registry exclusively,
   * inject that registry here instead.
   */
  onModuleInit(): void {
    // Use a dedicated registry that the PrometheusController can merge,
    // or register directly into the default registry.
    // The observability service's PrometheusService uses its own registry;
    // we create a counter on the global default registry and the controller
    // merges both.  To keep it simple we register on default + the injected one.
    this.registry = new client.Registry();

    this.securityEventsTotal = new client.Counter({
      name: 'security_events_total',
      help: 'Total number of security events by type',
      labelNames: ['type'],
      registers: [this.registry, client.register],
    });

    this.logger.log('Security Prometheus metrics registered');
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }

  /**
   * Increment the security events counter for the given type label.
   *
   * @param type  Short event type label, e.g. `auth.login.failed`
   */
  incrementSecurityEvent(type: string): void {
    this.securityEventsTotal.inc({ type });
  }

  /**
   * Return Prometheus-formatted metrics (for optional dedicated endpoint).
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
