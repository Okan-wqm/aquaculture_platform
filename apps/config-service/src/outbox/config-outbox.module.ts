import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';

import { ConfigOutbox } from './config-outbox.entity';

/**
 * config-service outbox module (DB-INFRA-HIGH-003) — thin wrapper over the
 * shared `@platform/outbox` module, which provides the `OutboxPublisher` the
 * tenant-erasure target executor enqueues proof events through, plus the worker
 * that relays them to NATS. Mirrors `BillingOutboxModule`.
 */
@Global()
@Module({
  imports: [OutboxModule.forFeature(ConfigOutbox)],
  exports: [OutboxModule],
})
export class ConfigOutboxModule {}
