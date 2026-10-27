import { Module, Global, OnModuleInit } from '@nestjs/common';
import { ServiceMetricsService } from '@aquaculture/backend-common/metrics';

import { GatewayMetricsController } from './metrics.controller';
import { MODULE_ACCESS_CLAIM_REGISTRY } from './module-access-claim.metrics';

/**
 * Gateway Metrics Module
 *
 * Gateway-specific metrics module that uses the gateway's own @Public() decorator.
 * This is needed because gateway-api has its own AuthGuard with a different
 * @Public() decorator than the one in backend-common.
 */
@Global()
@Module({
  controllers: [GatewayMetricsController],
  providers: [ServiceMetricsService],
  exports: [ServiceMetricsService],
})
export class GatewayMetricsModule implements OnModuleInit {
  constructor(private readonly serviceMetrics: ServiceMetricsService) {}

  onModuleInit(): void {
    // RBAC-HIGH-028 / PKG-04 accept: the share of verified tokens carrying moduleAccess.
    this.serviceMetrics.registerContributor('module-access-claim', MODULE_ACCESS_CLAIM_REGISTRY);
  }
}
