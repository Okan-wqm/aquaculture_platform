import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { AuthOutbox } from './auth-outbox.entity';
import { BestEffortEventPublisher } from './best-effort-event-publisher';

/**
 * @module AuthOutboxModule
 * @description Single registration point for the auth-service transactional
 * outbox (DATA-HIGH-001).
 *
 * Wraps `OutboxModule.forFeature(AuthOutbox)` from @platform/outbox so the
 * OutboxWorkerService (poll + NATS publish + retry/dead-letter), the
 * OutboxPublisher (validated transactional enqueue), the metrics service, and
 * the LISTEN/NOTIFY low-latency listener all run exactly once in the
 * auth-service process.
 *
 * @Global() — OutboxPublisher is cross-cutting infrastructure. The tenant,
 * authentication, account, privacy, and provisioning services inject it
 * directly to enqueue domain events inside their write transaction, without
 * each feature module re-importing the outbox.
 */
@Global()
@Module({
  imports: [OutboxModule.forFeature(AuthOutbox)],
  providers: [BestEffortEventPublisher],
  exports: [OutboxModule, BestEffortEventPublisher],
})
export class AuthOutboxModule {}
