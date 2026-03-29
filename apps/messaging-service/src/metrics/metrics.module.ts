/**
 * @module MetricsModule
 * @description Registers the messaging Prometheus metrics service and
 * the /metrics scrape controller.
 * @see ADR-012 section 10 (Observability)
 */
import { Module } from '@nestjs/common';
import { MessagingMetricsService } from './messaging-metrics.service';
import { MetricsController } from './metrics.controller';

@Module({
  controllers: [MetricsController],
  providers: [MessagingMetricsService],
  exports: [MessagingMetricsService],
})
export class MetricsModule {}
