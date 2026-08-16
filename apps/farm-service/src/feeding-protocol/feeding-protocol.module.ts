/**
 * FeedingProtocolModule — birleşik yemleme protokolü domain modülü.
 *
 * Faz 3 kapsamı: model + doğrulama/oran SSoT servisleri + CRUD/atama yüzeyi.
 * Yürütme motoru (day plan / meal üretimi) Faz 5'te bu modüle eklenir; legacy
 * FeedingModule motoru cutover'a (Faz 6) kadar dokunulmadan yaşar.
 *
 * @module FeedingProtocol
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FeedingProtocolV2 } from './entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from './entities/protocol-assignment.entity';
import { FeedingDayPlan } from './entities/feeding-day-plan.entity';
import { FeedingMeal } from './entities/feeding-meal.entity';
import { FeedingForecastSnapshot } from './entities/feeding-forecast-snapshot.entity';
import { Feed } from '../feed/entities/feed.entity';
import { Species } from '../species/entities/species.entity';
import { ProtocolValidationService } from './services/protocol-validation.service';
import { ProtocolRateService } from './services/protocol-rate.service';
import {
  FeedingForecastProjectionCompiler,
  ProtocolFeedForecastExecutor,
} from './executors/protocol-feed-forecast.executor';
import { MealPlanGeneratorService } from './services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from './services/biomass-growth-applier.service';
import { DayPlanRecalcService } from './services/day-plan-recalc.service';
import { MealOperationExecutor } from './executors/meal-operation.executor';
import { DayPlanOperationExecutor } from './executors/day-plan-operation.executor';
import { ScheduledFeedingOperationExecutor } from './executors/scheduled-feeding-operation.executor';
import { WaterTemperatureService } from '../water-quality/services/water-temperature.service';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { BatchDomainService } from '../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../batch/services/batch-lifecycle-policy.service';
import { FeedingModule } from '../feeding/feeding.module';
import { InventoryModule } from '../storage/storage.module';
import { GrowthModule } from '../growth/growth.module';
import {
  ArchiveFeedingProtocolV2Handler,
  CreateFeedingProtocolV2Handler,
  UpdateFeedingProtocolV2Handler,
} from './handlers/protocol-crud.handlers';
import {
  AssignProtocolToBatchUnitsHandler,
  AssignProtocolToUnitHandler,
  UnassignProtocolHandler,
  UpdateProtocolAssignmentHandler,
} from './handlers/protocol-assignment.handlers';
import {
  GetFeedingProtocolV2Handler,
  ListFeedingProtocolsV2Handler,
  ListProtocolAssignmentsHandler,
} from './query-handlers/feeding-protocol-v2.query-handlers';
import { FeedingProtocolV2Resolver } from './resolvers/feeding-protocol-v2.resolver';
import { MealFinalizationAuthority } from './services/meal-finalization.authority';
import { ProtocolResolutionAuthority } from './services/protocol-resolution.authority';
import { FeedingMutationTransactionAuthority } from './feeding-mutation-transaction.authority';
import { SensorTemperatureRecalcAuthority } from './services/sensor-temperature-recalc.authority';
import { FeedingWindowReadinessListener } from './listeners/feeding-window-readiness.listener';

@Module({
  imports: [
    // FeedingLedgerService (P-05 tek yem yazma yolu) FeedingModule'den gelir;
    // ters yönde import YOK (döngü riski yok).
    FeedingModule,
    // correctMealPour düzeltme hareketleri StockMovementService'i doğrudan kullanır.
    InventoryModule,
    // 18:00 FCR süpürmesi hedefi FCRCalculationService'ten (P-14 zinciri) okur.
    // GrowthModule geriye feeding-protocol'ü import etmez (döngü yok).
    GrowthModule,
    TypeOrmModule.forFeature([
      FeedingProtocolV2,
      ProtocolAssignment,
      FeedingDayPlan,
      FeedingMeal,
      FeedingForecastSnapshot,
      Feed,
      Species,
    ]),
  ],
  providers: [
    ProtocolValidationService,
    ProtocolRateService,
    ProtocolResolutionAuthority,
    FeedingMutationTransactionAuthority,
    MealPlanGeneratorService,
    BiomassGrowthApplierService,
    DayPlanRecalcService,
    SensorTemperatureRecalcAuthority,
    MealFinalizationAuthority,
    MealOperationExecutor,
    DayPlanOperationExecutor,
    ScheduledFeedingOperationExecutor,
    FeedingWindowReadinessListener,
    FeedingForecastProjectionCompiler,
    ProtocolFeedForecastExecutor,
    // Sıcaklık SSoT — cron toplu okuması (stateless, @InjectDataSource).
    WaterTemperatureService,
    // Stateless yardımcılar (BatchModule 'stateless pure domain logic' emsali).
    SiteAuthorizationService,
    BatchDomainService,
    BatchLifecyclePolicyService,
    CreateFeedingProtocolV2Handler,
    UpdateFeedingProtocolV2Handler,
    ArchiveFeedingProtocolV2Handler,
    AssignProtocolToUnitHandler,
    AssignProtocolToBatchUnitsHandler,
    UpdateProtocolAssignmentHandler,
    UnassignProtocolHandler,
    ListFeedingProtocolsV2Handler,
    GetFeedingProtocolV2Handler,
    ListProtocolAssignmentsHandler,
    FeedingProtocolV2Resolver,
  ],
  exports: [
    ProtocolValidationService,
    ProtocolRateService,
    ProtocolResolutionAuthority,
    MealPlanGeneratorService,
    BiomassGrowthApplierService,
    DayPlanRecalcService,
    SensorTemperatureRecalcAuthority,
    MealFinalizationAuthority,
    MealOperationExecutor,
    DayPlanOperationExecutor,
    ScheduledFeedingOperationExecutor,
    FeedingForecastProjectionCompiler,
    ProtocolFeedForecastExecutor,
  ],
})
export class FeedingProtocolModule {}
