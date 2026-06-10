/**
 * FarmMetricsModule
 *
 * Global module that exposes FarmDomainMetricsService and registers
 * farm-wide APP_INTERCEPTOR providers. Tenant execution context runs
 * before metrics so every GraphQL resolver reaches TypeORM with the
 * validated tenant schema in AsyncLocalStorage.
 *
 * Phase 5.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import { TenantExecutionContextInterceptor } from '@aquaculture/backend-common/context';
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { FarmDomainMetricsService } from './farm-domain-metrics.service';
import { FarmMetricsInterceptor } from './farm-metrics.interceptor';

@Global()
@Module({
  providers: [
    FarmDomainMetricsService,
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantExecutionContextInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: FarmMetricsInterceptor,
    },
  ],
  exports: [FarmDomainMetricsService],
})
export class FarmMetricsModule {}
