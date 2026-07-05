/**
 * FarmMetricsModule
 *
 * Global module that exposes FarmDomainMetricsService and registers
 * farm-wide APP_INTERCEPTOR providers. Tenant execution context runs
 * before metrics so every GraphQL resolver reaches TypeORM with the
 * validated tenant schema in AsyncLocalStorage.
 *
 * Phase 5.3 of the "Farm modülü kalan kör noktalar" plan.
 *
 * OBS-HIGH-001: imports the platform ServiceMetricsModule (which owns the
 * GET /metrics scrape endpoint + HTTP metrics middleware) and contributes
 * the farm domain registry to it in onModuleInit. Before this wiring the
 * farm_* counters were recorded into a private registry that NO controller
 * served — Prometheus could never scrape them.
 */
import { TenantExecutionContextModule } from '@aquaculture/backend-common/context';
import { ServiceMetricsModule, ServiceMetricsService } from '@aquaculture/backend-common/metrics';
import { Global, Module, OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { FarmDomainMetricsService } from './farm-domain-metrics.service';
import { FarmMetricsInterceptor } from './farm-metrics.interceptor';

@Global()
@Module({
  // TenantExecutionContextModule is imported FIRST so its APP_INTERCEPTOR
  // (tenant execution context) registers ahead of FarmMetricsInterceptor —
  // tenant context must wrap the resolver before metrics observe it. The
  // interceptor registration itself is the SSoT module in backend-common,
  // shared verbatim by every tenant-scoped service (no inline duplication).
  imports: [TenantExecutionContextModule, ServiceMetricsModule],
  providers: [
    FarmDomainMetricsService,
    {
      provide: APP_INTERCEPTOR,
      useClass: FarmMetricsInterceptor,
    },
  ],
  exports: [FarmDomainMetricsService],
})
export class FarmMetricsModule implements OnModuleInit {
  constructor(
    private readonly farmDomainMetrics: FarmDomainMetricsService,
    private readonly serviceMetrics: ServiceMetricsService,
  ) {}

  onModuleInit(): void {
    // WHAT: plug the farm domain registry into the platform /metrics
    // endpoint. WHY here (module hook, not service constructor): keeps
    // FarmDomainMetricsService constructible without DI in unit tests
    // while making the production wiring automatic and un-forgettable.
    this.farmDomainMetrics.contributeTo(this.serviceMetrics);
  }
}
