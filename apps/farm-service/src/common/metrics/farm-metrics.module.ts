/**
 * FarmMetricsModule
 *
 * Global module that exposes `FarmDomainMetricsService` and registers
 * `FarmMetricsInterceptor` as an APP_INTERCEPTOR so every GraphQL
 * resolver gets the duration + error metrics automatically.
 *
 * Phase 5.3 of the "Farm modülü kalan kör noktalar" plan.
 */
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
      useClass: FarmMetricsInterceptor,
    },
  ],
  exports: [FarmDomainMetricsService],
})
export class FarmMetricsModule {}
