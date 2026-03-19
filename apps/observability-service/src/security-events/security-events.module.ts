import { Module } from '@nestjs/common';
import { EventBusModule } from '@platform/event-bus';
import { SecurityEventsConsumerService } from './security-events-consumer.service';
import { SecurityMetricsService } from './security-metrics.service';

/**
 * SecurityEventsModule
 *
 * Consumes security events from NATS `security.events.*` subjects,
 * logs them in structured format, and exposes Prometheus counter metrics.
 */
@Module({
  imports: [EventBusModule.forRoot()],
  providers: [SecurityEventsConsumerService, SecurityMetricsService],
  exports: [SecurityMetricsService],
})
export class SecurityEventsModule {}
