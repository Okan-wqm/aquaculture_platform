import { ServiceMetricsService } from '@aquaculture/backend-common/metrics';
import { Logger, Module, Global, type OnModuleInit } from '@nestjs/common';

import { GatewayMetricsController } from './metrics.controller';

/**
 * Gateway Metrics Module
 *
 * Gateway-specific metrics module that uses the gateway's own @Public() decorator.
 * This is needed because gateway-api has its own AuthGuard with a different
 * @Public() decorator than the one in backend-common.
 *
 * Implements OnModuleInit so the class has a concrete instance member — the
 * @typescript-eslint/no-extraneous-class rule rejects decorator-only empty
 * classes, and the architectural fix is a real lifecycle hook (logs that
 * the metrics endpoint is registered, useful during deploy diagnostics).
 */
@Global()
@Module({
  controllers: [GatewayMetricsController],
  providers: [ServiceMetricsService],
  exports: [ServiceMetricsService],
})
export class GatewayMetricsModule implements OnModuleInit {
  private readonly logger = new Logger(GatewayMetricsModule.name);

  onModuleInit(): void {
    this.logger.log('Gateway metrics module initialised — /metrics exposed via GatewayMetricsController');
  }
}
