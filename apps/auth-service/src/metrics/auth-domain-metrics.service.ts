import { ServiceMetricsService } from '@aquaculture/backend-common/metrics';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as client from 'prom-client';

export type AuthOutcome = 'success' | 'error';
export type AuthOperation = 'login' | 'token_validation';

/**
 * AuthDomainMetricsService
 *
 * Tier-0 auth latency SLI (PERF-MEDIUM-003). Login and token-validation are
 * GraphQL mutations served on /graphql, so the platform
 * `http_request_duration_seconds` histogram — labelled by `route` — cannot
 * isolate them (every GraphQL operation shares route="/graphql"). This dedicated
 * histogram measures the two tier-0 auth operations directly so the SLO
 * (slo-alerts.yml `aquaculture.slo.auth-latency`) has a real series to alert on.
 *
 * Same per-service private-registry + registerContributor pattern as
 * FarmDomainMetricsService (OBS-HIGH-001). Label discipline: NO tenant label on
 * the scrape series — the /metrics surface is unauthenticated, so a tenant id
 * would explode cardinality and let any scraper enumerate active tenants.
 */
@Injectable()
export class AuthDomainMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthDomainMetricsService.name);
  private readonly registry: client.Registry;
  private operationDuration!: client.Histogram;

  constructor() {
    this.registry = new client.Registry();
  }

  onModuleInit(): void {
    this.operationDuration = new client.Histogram({
      name: 'auth_operation_duration_seconds',
      help: 'Wall-clock duration of tier-0 auth operations (login, token validation) in seconds',
      labelNames: ['operation', 'outcome'],
      // Buckets tuned around the ~200ms constant-time login floor and a 500ms
      // p99 SLO so the histogram has resolution exactly where the alert fires.
      buckets: [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.logger.log('Auth domain metrics initialized');
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }

  /** Prometheus text dump of the auth-domain registry (the platform /metrics
   *  endpoint serves it via registerContributor; also used directly by tests). */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Plug this private registry into the platform /metrics endpoint. Called by
   * AuthMetricsModule.onModuleInit (module hook, not the constructor, so the
   * service stays constructible without DI in unit tests).
   */
  contributeTo(serviceMetrics: ServiceMetricsService): void {
    serviceMetrics.registerContributor('auth-domain', this.registry);
  }

  /**
   * Start timing a tier-0 auth operation. Returns a `stop(outcome)` to call in
   * BOTH the success and error paths — failed logins (brute-force probes) are
   * part of the latency SLI, not excluded from it.
   */
  startOperation(operation: AuthOperation): (outcome: AuthOutcome) => void {
    const end = this.operationDuration.startTimer({ operation });
    return (outcome: AuthOutcome): void => {
      end({ outcome });
    };
  }
}
