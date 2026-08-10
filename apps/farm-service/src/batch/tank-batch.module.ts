/**
 * TankBatchModule
 *
 * Provides the TankBatchService — the single SSoT writer for a tank's
 * `batchDetails[]` composition, reached ONLY through `applyStockChange` — as a
 * shared, exportable dependency. EVERY module whose handlers mutate a tank's
 * fish count imports this module: BatchModule (allocate/mortality/cull/transfer)
 * and HarvestModule (create/delete-harvest). Sharing the writer through one
 * module keeps a single instance AND makes the dependency impossible to forget —
 * a handler that injects TankBatchService lives in a module that must import
 * TankBatchModule, or the DI graph fails to compile (see harvest.module.di.spec.ts).
 *
 * A stock change is also a RATION change, so the writer needs a recalculator.
 * It is bound here to `DayPlanRecalcService` through the
 * `UNIT_RATION_RECALCULATOR` port, and injected WITHOUT `@Optional()`: a farm
 * service that cannot resolve a recalculator does not boot, so there is no
 * deployment in which stock moves and the day's remaining meals do not follow.
 *
 * The three feeding-protocol services are provided DIRECTLY (the repo pattern
 * BatchModule/HarvestModule/GrowthModule already follow) because importing
 * FeedingProtocolModule would create a module cycle. All three are stateless and
 * operate on the caller's EntityManager, so a per-module instance is equivalent
 * to a shared one and no `forFeature` registration is needed.
 */
import { Module } from '@nestjs/common';

import { ProtocolRateService } from '../feeding-protocol/services/protocol-rate.service';
import { FeedTypeTransitionService } from '../feeding-protocol/services/feed-transition.service';
import { DayPlanRecalcService } from '../feeding-protocol/services/day-plan-recalc.service';
import { TankBatchService } from './services/tank-batch.service';
import { UNIT_RATION_RECALCULATOR } from './services/unit-ration-recalculator.port';

@Module({
  providers: [
    ProtocolRateService,
    FeedTypeTransitionService,
    DayPlanRecalcService,
    { provide: UNIT_RATION_RECALCULATOR, useExisting: DayPlanRecalcService },
    TankBatchService,
  ],
  exports: [TankBatchService],
})
export class TankBatchModule {}
