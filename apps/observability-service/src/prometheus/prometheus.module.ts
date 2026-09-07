import { Module, Global } from '@nestjs/common';
import { CronHeartbeatService, ServiceMetricsService } from '@aquaculture/backend-common/metrics';

import { PrometheusService } from './prometheus.service';
import { PrometheusController } from './prometheus.controller';

/**
 * observability-service owns its own registry, so it does not import the shared
 * `ServiceMetricsModule` — which is also where `CronHeartbeatService` lives.
 * Both are bound here instead:
 *
 *  - the `ServiceMetricsService` TOKEN resolves to `PrometheusService`, which
 *    implements the same narrow contributor port (`registerContributor`), so a
 *    platform service depending on that port works unchanged;
 *  - `CronHeartbeatService` is then constructible, which is what
 *    `ScheduledJobModule` needs, and its series land on THIS service's /metrics
 *    rather than nowhere (ADMIN-HIGH-013).
 */
@Global()
@Module({
  controllers: [PrometheusController],
  providers: [
    PrometheusService,
    { provide: ServiceMetricsService, useExisting: PrometheusService },
    CronHeartbeatService,
  ],
  exports: [PrometheusService, ServiceMetricsService, CronHeartbeatService],
})
export class PrometheusModule {}
