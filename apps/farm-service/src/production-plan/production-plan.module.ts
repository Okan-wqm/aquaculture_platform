/**
 * Production-plan module — temperature scenarios + tank growth projection
 * (the farm module's Üretim Planı backing).
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  TemperatureScenario,
  TemperatureScenarioPoint,
} from './entities/temperature-scenario.entity';
import { GetTemperatureScenariosHandler } from './query-handlers/get-temperature-scenarios.handler';
import { CreateTemperatureScenarioHandler } from './query-handlers/create-temperature-scenario.handler';
import { DeleteTemperatureScenarioHandler } from './query-handlers/delete-temperature-scenario.handler';
import { GetTankGrowthProjectionHandler } from './query-handlers/get-tank-growth-projection.handler';
import { ProductionPlanResolver } from './resolvers/production-plan.resolver';
import { ProtocolRateService } from '../feeding-protocol/services/protocol-rate.service';
import { WaterTemperatureService } from '../water-quality/services/water-temperature.service';

export const ProductionPlanQueryHandlers = [
  GetTemperatureScenariosHandler,
  CreateTemperatureScenarioHandler,
  DeleteTemperatureScenarioHandler,
  GetTankGrowthProjectionHandler,
];

@Module({
  imports: [TypeOrmModule.forFeature([TemperatureScenario, TemperatureScenarioPoint])],
  providers: [
    ...ProductionPlanQueryHandlers,
    ProductionPlanResolver,
    ProtocolRateService,
    WaterTemperatureService,
  ],
  exports: [ProductionPlanResolver],
})
export class ProductionPlanModule {}
