import { Module, Global } from '@nestjs/common';
import { CronHeartbeatService, ServiceMetricsService } from '@aquaculture/backend-common/metrics';

import { SensorMetricsController } from './metrics.controller';

/**
 * Sensor Metrics Module
 *
 * Provides Prometheus /metrics endpoint for sensor-service.
 * Uses backend-common's @Public() and @SkipTenantGuard() decorators.
 */
@Global()
@Module({
  controllers: [SensorMetricsController],
  // CronHeartbeatService rides whichever module owns /metrics — see the note
  // in the shared ServiceMetricsModule. sensor-service has a bespoke one.
  providers: [ServiceMetricsService, CronHeartbeatService],
  exports: [ServiceMetricsService, CronHeartbeatService],
})
export class SensorMetricsModule {}
