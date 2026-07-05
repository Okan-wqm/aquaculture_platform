import { Module, Global, OnModuleInit } from '@nestjs/common';
import { ServiceMetricsService } from '@aquaculture/backend-common/metrics';

import { AuthDomainMetricsService } from './auth-domain-metrics.service';
import { AuthMetricsController } from './metrics.controller';

/**
 * Auth Metrics Module
 *
 * Provides the Prometheus /metrics endpoint for auth-service and contributes the
 * auth-domain registry (tier-0 login + token-validation latency, PERF-MEDIUM-003)
 * to it — the same registerContributor wiring FarmMetricsModule uses
 * (OBS-HIGH-001), so the domain histogram is actually scraped.
 */
@Global()
@Module({
  controllers: [AuthMetricsController],
  providers: [ServiceMetricsService, AuthDomainMetricsService],
  exports: [ServiceMetricsService, AuthDomainMetricsService],
})
export class AuthMetricsModule implements OnModuleInit {
  constructor(
    private readonly serviceMetrics: ServiceMetricsService,
    private readonly authDomainMetrics: AuthDomainMetricsService,
  ) {}

  onModuleInit(): void {
    this.authDomainMetrics.contributeTo(this.serviceMetrics);
  }
}
