import { Module } from '@nestjs/common';
import { OutboxModule } from '@platform/outbox';
import { FarmOutbox } from './farm-outbox.entity';

/**
 * FarmOutboxModule
 *
 * Wires the @platform/outbox library against the farm_outbox table.
 *
 * Re-exports `OutboxModule.forFeature(FarmOutbox)` so any handler module
 * that imports `FarmOutboxModule` gains access to the `OutboxPublisher`
 * provider for transactional `enqueue(event, manager)` calls.
 *
 * Requires:
 *   - `EventBusModule.forRoot(...)` registered globally (already in app.module.ts)
 *   - `farm_outbox` table created (CreateFarmOutboxTable1780300000000 migration)
 *
 * @see Phase 2 of farm domain real-time visibility plan.
 */
@Module({
  imports: [OutboxModule.forFeature(FarmOutbox)],
  exports: [OutboxModule],
})
export class FarmOutboxModule {}
