import { Global, Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';
import { FarmOutbox } from './farm-outbox.entity';

/**
 * FarmOutboxModule
 *
 * Wires the @platform/outbox library against the farm_outbox table.
 *
 * `@Global()` so any feature module's command handler can inject
 * `OutboxPublisher` directly via constructor without each module
 * needing to import `FarmOutboxModule`. This mirrors how `EventBusModule`
 * is also global — transactional outbox is a cross-cutting infrastructure
 * concern, not a per-feature dependency.
 *
 * Requires:
 *   - `EventBusModule.forRoot(...)` registered globally (already in app.module.ts)
 *   - `farm_outbox` table created (CreateFarmOutboxTable1780300000000 migration)
 *
 * @see Phase A of farm domain real-time visibility plan.
 */
@Global()
@Module({
  imports: [OutboxModule.forFeature(FarmOutbox)],
  exports: [OutboxModule],
})
export class FarmOutboxModule {}
