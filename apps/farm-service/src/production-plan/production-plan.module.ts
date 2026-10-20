/**
 * Production-plan module — temperature scenarios + tank growth projection
 * (the farm module's Üretim Planı backing).
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TemperatureScenario } from './entities/temperature-scenario.entity';
import { TemperatureScenarioPoint } from './entities/temperature-scenario-point.entity';
import { GetTemperatureScenariosHandler } from './query-handlers/get-temperature-scenarios.handler';
import { CreateTemperatureScenarioHandler } from './query-handlers/create-temperature-scenario.handler';
import { DeleteTemperatureScenarioHandler } from './query-handlers/delete-temperature-scenario.handler';
import { GetTankGrowthProjectionHandler } from './query-handlers/get-tank-growth-projection.handler';
import { ProductionPlanResolver } from './resolvers/production-plan.resolver';
import { FeedingProtocolCoreModule } from '../feeding-protocol/feeding-protocol-core.module';
import { WaterQualityModule } from '../water-quality/water-quality.module';

export const ProductionPlanQueryHandlers = [
  GetTemperatureScenariosHandler,
  CreateTemperatureScenarioHandler,
  DeleteTemperatureScenarioHandler,
  GetTankGrowthProjectionHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([TemperatureScenario, TemperatureScenarioPoint]),
    // ProtocolRateService comes from FeedingProtocolCoreModule (its provider
    // home) — re-providing it here would split its state across two instances.
    FeedingProtocolCoreModule,
    WaterQualityModule,
  ],
  providers: [...ProductionPlanQueryHandlers, ProductionPlanResolver],
  exports: [ProductionPlanResolver],
})
export class ProductionPlanModule {}
