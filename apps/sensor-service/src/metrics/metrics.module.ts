import { Module, Global } from '@nestjs/common';
import { ServiceMetricsService } from '@platform/backend-common';

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
  providers: [ServiceMetricsService],
  exports: [ServiceMetricsService],
})
export class SensorMetricsModule {}
