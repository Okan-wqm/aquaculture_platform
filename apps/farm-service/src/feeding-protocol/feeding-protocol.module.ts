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
import { Feed } from '../feed/entities/feed.entity';
import { Species } from '../species/entities/species.entity';
import { ProtocolValidationService } from './services/protocol-validation.service';
import { ProtocolRateService } from './services/protocol-rate.service';
import { MealPlanGeneratorService } from './services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from './services/biomass-growth-applier.service';
import { DayPlanRecalcService } from './services/day-plan-recalc.service';
import { MealExecutionService } from './services/meal-execution.service';
import { FeedingCronV2Service } from './services/feeding-cron-v2.service';
import { WaterTemperatureService } from '../water-quality/services/water-temperature.service';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { BatchDomainService } from '../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../batch/services/batch-lifecycle-policy.service';
import { FeedingModule } from '../feeding/feeding.module';
import { InventoryModule } from '../storage/storage.module';
import {
  ArchiveFeedingProtocolV2Handler,
  CreateFeedingProtocolV2Handler,
  UpdateFeedingProtocolV2Handler,
} from './handlers/protocol-crud.handlers';
import {
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
import { MealExecutionResolver } from './resolvers/meal-execution.resolver';

@Module({
  imports: [
    // FeedingLedgerService (P-05 tek yem yazma yolu) FeedingModule'den gelir;
    // ters yönde import YOK (döngü riski yok).
    FeedingModule,
    // correctMealPour düzeltme hareketleri StockMovementService'i doğrudan kullanır.
    InventoryModule,
    TypeOrmModule.forFeature([
      FeedingProtocolV2,
      ProtocolAssignment,
      FeedingDayPlan,
      FeedingMeal,
      Feed,
      Species,
    ]),
  ],
  providers: [
    ProtocolValidationService,
    ProtocolRateService,
    MealPlanGeneratorService,
    BiomassGrowthApplierService,
    DayPlanRecalcService,
    MealExecutionService,
    FeedingCronV2Service,
    // Sıcaklık SSoT — cron toplu okuması (stateless, @InjectDataSource).
    WaterTemperatureService,
    // Stateless yardımcılar (BatchModule 'stateless pure domain logic' emsali).
    MobileCommandReceiptService,
    SiteAuthorizationService,
    BatchDomainService,
    BatchLifecyclePolicyService,
    CreateFeedingProtocolV2Handler,
    UpdateFeedingProtocolV2Handler,
    ArchiveFeedingProtocolV2Handler,
    AssignProtocolToUnitHandler,
    UpdateProtocolAssignmentHandler,
    UnassignProtocolHandler,
    ListFeedingProtocolsV2Handler,
    GetFeedingProtocolV2Handler,
    ListProtocolAssignmentsHandler,
    FeedingProtocolV2Resolver,
    MealExecutionResolver,
  ],
  exports: [
    ProtocolValidationService,
    ProtocolRateService,
    MealPlanGeneratorService,
    BiomassGrowthApplierService,
    DayPlanRecalcService,
    MealExecutionService,
  ],
})
export class FeedingProtocolModule {}
