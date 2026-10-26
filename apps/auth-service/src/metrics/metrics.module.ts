import { Module, Global, OnModuleInit } from '@nestjs/common';
import { CronHeartbeatService, ServiceMetricsService } from '@aquaculture/backend-common/metrics';

import { AuthDomainMetricsService } from './auth-domain-metrics.service';
import { AuthMetricsController } from './metrics.controller';
import { MODULE_ACCESS_METRICS_REGISTRY } from './module-access.metrics';

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
  // CronHeartbeatService rides whichever module owns /metrics, exactly as it
  // does in the shared ServiceMetricsModule. auth-service has a bespoke metrics
  // module (it predates the shared one), so without this line
  // `ScheduledJobModule` cannot resolve the heartbeat and the service does not
  // boot — which is the intended failure, but the fix belongs here.
  providers: [ServiceMetricsService, CronHeartbeatService, AuthDomainMetricsService],
  exports: [ServiceMetricsService, CronHeartbeatService, AuthDomainMetricsService],
})
export class AuthMetricsModule implements OnModuleInit {
  constructor(
    private readonly serviceMetrics: ServiceMetricsService,
    private readonly authDomainMetrics: AuthDomainMetricsService,
  ) {}

  onModuleInit(): void {
    this.authDomainMetrics.contributeTo(this.serviceMetrics);
    // RBAC-MEDIUM-029: the codes a minted moduleAccess claim leaves out, counted at mint.
    this.serviceMetrics.registerContributor('module-access', MODULE_ACCESS_METRICS_REGISTRY);
  }
}
