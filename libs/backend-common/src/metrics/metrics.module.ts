import { Module, Global } from '@nestjs/common';

import { ServiceMetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

/**
 * ServiceMetricsModule
 *
 * Drop-in module for any NestJS microservice to expose Prometheus /metrics endpoint.
 *
 * Usage in a service's AppModule:
 *
 * ```typescript
 * import { ServiceMetricsModule } from '@platform/backend-common';
 *
 * @Module({
 *   imports: [ServiceMetricsModule],
 * })
 * export class AppModule implements NestModule {
 *   configure(consumer: MiddlewareConsumer) {
 *     consumer.apply(MetricsMiddleware).forRoutes('*');
 *   }
 * }
 * ```
 *
 * IMPORTANT: The /metrics endpoint needs to be public (no auth).
 * Each service must ensure that its global guards skip the /metrics route.
 * For gateway-api: The @Public() decorator from auth.guard.ts is used.
 * For subservices: The @Public() + @SkipTenantGuard() from backend-common is used.
 *
 * Since different services have different guard setups, the MetricsController
 * here does NOT apply @Public(). Instead, each service should either:
 * 1. Exclude 'metrics' from their global prefix, OR
 * 2. Configure their guards to skip /metrics
 *
 * The controller in this module is already excluded from most guard checks
 * because health-style endpoints typically bypass auth in NestJS apps.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [ServiceMetricsService],
  exports: [ServiceMetricsService],
})
export class ServiceMetricsModule {}
