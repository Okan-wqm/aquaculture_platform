import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { EventStoreOutbox } from './event-store-outbox.entity';

/**
 * event-store-service outbox module (DB-INFRA-HIGH-003) — thin wrapper over the
 * shared `@platform/outbox` module, providing the OutboxPublisher the erasure
 * target executor enqueues proof events through + the worker that relays them to
 * NATS. Mirrors BillingOutboxModule.
 */
@Global()
@Module({
  imports: [OutboxModule.forFeature(EventStoreOutbox)],
  exports: [OutboxModule],
})
export class EventStoreOutboxModule {}
