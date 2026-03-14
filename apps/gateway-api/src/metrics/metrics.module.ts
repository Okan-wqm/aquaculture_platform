import { Module, Global } from '@nestjs/common';
import { ServiceMetricsService } from '@platform/backend-common';

import { GatewayMetricsController } from './metrics.controller';

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
export class GatewayMetricsModule {}
