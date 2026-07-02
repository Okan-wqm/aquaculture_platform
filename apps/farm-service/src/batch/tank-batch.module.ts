/**
 * TankBatchModule
 *
 * Provides the TankBatchService — the single SSoT writer for a tank's
 * `batchDetails[]` composition (applyBatchDelta) — as a shared, exportable
 * dependency. EVERY module whose handlers mutate a tank's fish count imports
 * this module: BatchModule (allocate/mortality/cull/transfer) and HarvestModule
 * (create/delete-harvest). Sharing the writer through one module keeps a single
 * instance AND makes the dependency impossible to forget — a handler that
 * injects TankBatchService lives in a module that must import TankBatchModule,
 * or the DI graph fails to compile (see harvest.module.di.spec.ts).
 *
 * TankBatchService is stateless (no constructor; it operates on the caller's
 * EntityManager), so this module needs no imports and introduces no coupling.
 */
import { Module } from '@nestjs/common';

import { TankBatchService } from './services/tank-batch.service';

@Module({
  providers: [TankBatchService],
  exports: [TankBatchService],
})
export class TankBatchModule {}
