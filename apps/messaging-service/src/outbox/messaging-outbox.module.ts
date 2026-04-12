import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';
import { MessagingOutbox } from './messaging-outbox.entity';

/**
 * @module MessagingOutboxModule
 * @description Single registration point for the messaging transactional outbox.
 *
 * Wraps `OutboxModule.forFeature(MessagingOutbox)` from @platform/outbox so
 * the OutboxWorkerService runs exactly once in the messaging-service process.
 *
 * @Global() — OutboxPublisher is cross-cutting infrastructure. Command handlers
 * and resolvers across all feature modules inject it directly without each
 * needing an explicit import.
 *
 * Re-exports OutboxModule so OutboxPublisher and OutboxMetricsService are
 * injectable in all providers of any module in this service.
 *
 * WHY migration from local outbox:
 *   The previous local OutboxWorkerService used ClientProxy (NestJS core NATS)
 *   without LISTEN/NOTIFY, bounded concurrency, or Prometheus metrics.
 *   @platform/outbox provides all three plus validated enqueue API.
 */
@Global()
@Module({
  imports: [OutboxModule.forFeature(MessagingOutbox)],
  exports: [OutboxModule],
})
export class MessagingOutboxModule {}
