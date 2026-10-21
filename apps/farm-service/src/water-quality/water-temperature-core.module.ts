import { Module } from '@nestjs/common';

import { WaterTemperatureService } from './services/water-temperature.service';

/**
 * WaterTemperatureService as ONE leaf module — the FeedingProtocolCoreModule
 * pattern applied to the same class of cycle.
 *
 * WHY a leaf: WaterQualityModule imports EquipmentModule (its param-equipment
 * fan-out reads equipment entities), so EquipmentModule, FeedingProtocolModule
 * and ProductionPlanModule cannot import WaterQualityModule back without a
 * circular dependency. Each of them instead listed WaterTemperatureService
 * under its own `providers`, which builds a separate instance per module —
 * exactly the split-state failure the provider-duplication invariant forbids.
 * The service reads only TypeORM repositories via its injected DataSource and
 * the tenant-read boundary, so it needs no imports and every module can share
 * the single instance. tests/invariants/nest-module-provider-duplication.spec.ts
 * keeps it that way.
 */
@Module({
  providers: [WaterTemperatureService],
  exports: [WaterTemperatureService],
})
export class WaterTemperatureCoreModule {}
