import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';
import { FarmOutbox } from './farm-outbox.entity';

/**
 * FarmOutboxModule
 *
 * Wires the @platform/outbox library against canonical farm.outbox_events.
 * The FarmOutbox class name is retained for import stability; legacy
 * farm.farm_outbox is read/migration compatibility only.
 *
 * `@Global()` so any feature module's command handler can inject
 * `OutboxPublisher` directly via constructor without each module
 * needing to import `FarmOutboxModule`. This mirrors how `EventBusModule`
 * is also global — transactional outbox is a cross-cutting infrastructure
 * concern, not a per-feature dependency.
 *
 * Requires:
 *   - `EventBusModule.forRoot(...)` registered globally (already in app.module.ts)
 *   - `farm.outbox_events` table created (CreateCanonicalOutboxInbox1800700000000)
 *
 * @see Sites Setup SSOT remediation Phase 3.
 */
@Global()
@Module({
  imports: [OutboxModule.forFeature(FarmOutbox)],
  exports: [OutboxModule],
})
export class FarmOutboxModule {}
