import { Module, Global } from '@nestjs/common';
import { ServiceMetricsService } from '@aquaculture/backend-common/metrics';

import { AuthMetricsController } from './metrics.controller';

/**
 * Auth Metrics Module
 *
 * Provides Prometheus /metrics endpoint for auth-service.
 */
@Global()
@Module({
  controllers: [AuthMetricsController],
  providers: [ServiceMetricsService],
  exports: [ServiceMetricsService],
})
export class AuthMetricsModule {}
