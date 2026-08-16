import { Module, Global, MiddlewareConsumer, NestModule } from '@nestjs/common';

import { CronHeartbeatService } from './cron-heartbeat.service';
import { MetricsController } from './metrics.controller';
import { MetricsMiddleware } from './metrics.middleware';
import { ServiceMetricsService } from './metrics.service';

/**
 * ServiceMetricsModule
 *
 * Drop-in module for any NestJS microservice to expose a Prometheus
 * /metrics endpoint (OBS-HIGH-001).
 *
 * Adoption is exactly ONE line in a service's AppModule:
 *
 * ```typescript
 * import { ServiceMetricsModule } from '@aquaculture/backend-common/metrics';
 *
 * @Module({
 *   imports: [ServiceMetricsModule],
 * })
 * export class AppModule {}
 * ```
 *
 * WHY the module is self-contained (no per-service wiring):
 *
 * - The controller carries @Public() itself — every platform guard chain
 *   keys public bypass on the same 'isPublic' reflector metadata (see
 *   metrics.controller.ts header), so no consuming service has to wrap
 *   the controller to decorate it.
 * - The module implements NestModule and applies MetricsMiddleware to
 *   every route itself. Nest invokes configure() on imported modules, so
 *   HTTP request histograms populate without the AppModule repeating the
 *   consumer.apply(...) ceremony. Services that wire MetricsMiddleware in
 *   their own AppModule (gateway-api, auth-service, sensor-service, with
 *   bespoke metrics modules predating this) do NOT import this module, so
 *   no request is double-counted.
 * - Domain modules that keep a private prom-client Registry (e.g.
 *   farm-service's FarmDomainMetricsService) surface it through
 *   ServiceMetricsService.registerContributor() — the single scrape
 *   endpoint then serves HTTP + Node.js + domain metrics together.
 *
 * The endpoint is served at /metrics because the shared bootstrap
 * excludes 'metrics' from the global API prefix by default.
 *
 * Enforced by tests/invariants/metrics-endpoint-adoption.spec.ts: every
 * catalog entry with metricsExposure 'prom-endpoint' must register a
 * metrics module in its app.module.ts.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [ServiceMetricsService, CronHeartbeatService],
  exports: [ServiceMetricsService, CronHeartbeatService],
})
export class ServiceMetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // WHAT: record duration/status/in-flight for every HTTP route of the
    // importing service. WHY here: the module owns its full contract —
    // endpoint + collection — so adoption cannot silently ship a scrape
    // endpoint whose http_* series never observe anything.
    consumer.apply(MetricsMiddleware).forRoutes('*');
  }
}
