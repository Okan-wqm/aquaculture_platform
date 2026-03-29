/**
 * @module MetricsModule
 * @description Registers the messaging Prometheus metrics service and
 * the /metrics scrape controller. Marked @Global() because
 * MessagingMetricsService is a cross-cutting concern injected across
 * ChannelModule, MessageModule, OutboxModule, and rate-limit interceptors.
 * @see ADR-012 section 10 (Observability)
 */
import { Global, Module } from '@nestjs/common';
import { MessagingMetricsService } from './messaging-metrics.service';
import { MetricsController } from './metrics.controller';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MessagingMetricsService],
  exports: [MessagingMetricsService],
})
export class MetricsModule {}
