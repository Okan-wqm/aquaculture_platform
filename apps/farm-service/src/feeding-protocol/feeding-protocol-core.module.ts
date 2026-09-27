import { Module } from '@nestjs/common';

import { BiomassGrowthApplierService } from './services/biomass-growth-applier.service';
import { DayPlanRecalcService } from './services/day-plan-recalc.service';
import { ProtocolRateService } from './services/protocol-rate.service';
import { ProtocolResolutionService } from './services/protocol-resolution.service';

/**
 * The protocol arithmetic every feeding-adjacent domain shares — band/rate/FCR
 * resolution and the day-plan recalculation it feeds — as ONE leaf module.
 *
 * WHY a leaf: FeedingProtocolModule imports FeedingModule and GrowthModule, so
 * neither of those (nor Batch, Harvest or WaterQuality, which sit beside them)
 * could import FeedingProtocolModule back without a cycle. Each of them
 * instead listed ProtocolRateService / DayPlanRecalcService /
 * BiomassGrowthApplierService under its own `providers`, which makes Nest
 * build a separate instance per module and resolve its dependencies THERE.
 * When DayPlanRecalcService gained a ProtocolResolutionService dependency, the
 * copy inside FeedingModule had nowhere to resolve it from and farm-service
 * could not boot ("Nest can't resolve dependencies of the DayPlanRecalcService
 * (OutboxPublisher, ?)", 2026-09-20 outage). These four services depend only
 * on each other and on @Global providers (OutboxPublisher, FarmDomainMetrics),
 * so they need no imports and every module can share the single instance.
 * tests/invariants/nest-module-provider-duplication.spec.ts keeps it that way.
 */
@Module({
  providers: [
    ProtocolRateService,
    ProtocolResolutionService,
    DayPlanRecalcService,
    BiomassGrowthApplierService,
  ],
  exports: [
    ProtocolRateService,
    ProtocolResolutionService,
    DayPlanRecalcService,
    BiomassGrowthApplierService,
  ],
})
export class FeedingProtocolCoreModule {}
