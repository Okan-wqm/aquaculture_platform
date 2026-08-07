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
import { FeederAssignment } from './entities/feeder-assignment.entity';
import { FeederAssignmentUnitTotal } from './entities/feeder-assignment-unit-total.entity';
import { FeedingDayPlan } from './entities/feeding-day-plan.entity';
import { FeedingMeal } from './entities/feeding-meal.entity';
import { FeedingForecastSnapshot } from './entities/feeding-forecast-snapshot.entity';
import { Feed } from '../feed/entities/feed.entity';
import { Species } from '../species/entities/species.entity';
import { ProtocolValidationService } from './services/protocol-validation.service';
import { ProtocolRateService } from './services/protocol-rate.service';
import { UnitProtocolResolverService } from './services/unit-protocol-resolver.service';
import { ProtocolFeedForecastService } from './services/protocol-feed-forecast.service';
import { FeedForecastResolver } from './resolvers/feed-forecast.resolver';
import { ForecastRefreshListener } from './listeners/forecast-refresh.listener';
import { MealPlanGeneratorService } from './services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from './services/biomass-growth-applier.service';
import { DayPlanRecalcService } from './services/day-plan-recalc.service';
import { MealExecutionService } from './services/meal-execution.service';
import { DayPlanAdminService } from './services/day-plan-admin.service';
import { FeedingCronV2Service } from './services/feeding-cron-v2.service';
import { WaterTemperatureService } from '../water-quality/services/water-temperature.service';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
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
import { MealExecutionResolver } from './resolvers/meal-execution.resolver';
import { SetUnitFeedersHandler } from './handlers/feeder-assignment.handlers';
import { GetUnitFeederAssignmentsHandler } from './query-handlers/feeder-assignment.query-handlers';
import { FeederAssignmentResolver } from './resolvers/feeder-assignment.resolver';
import { FeederDoseSplitService } from './services/feeder-dose-split.service';
import { FeederDoseDirectiveService } from './services/feeder-dose-directive.service';
import { FeederCapability } from '../equipment/entities/feeder-capability.entity';
import { FeederCalibration } from '../equipment/entities/feeder-calibration.entity';
import { FeederSiloMassLatest } from '../equipment/entities/feeder-silo-mass-latest.entity';

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
      FeederAssignment,
      FeederAssignmentUnitTotal,
      FeedingDayPlan,
      FeedingMeal,
      FeedingForecastSnapshot,
      Feed,
      Species,
      // Kalibrasyon SSoT'si equipment domain'inde yaşar; buradaki kayıt
      // yalnızca doz→hız/süre türetmesinin okuma yoludur (yazma yolu değil).
      FeederCapability,
      FeederCalibration,
      FeederSiloMassLatest,
    ]),
  ],
  providers: [
    ProtocolValidationService,
    ProtocolRateService,
    UnitProtocolResolverService,
    MealPlanGeneratorService,
    BiomassGrowthApplierService,
    DayPlanRecalcService,
    MealExecutionService,
    DayPlanAdminService,
    FeedingCronV2Service,
    ProtocolFeedForecastService,
    ForecastRefreshListener,
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
    AssignProtocolToBatchUnitsHandler,
    UpdateProtocolAssignmentHandler,
    UnassignProtocolHandler,
    ListFeedingProtocolsV2Handler,
    GetFeedingProtocolV2Handler,
    ListProtocolAssignmentsHandler,
    SetUnitFeedersHandler,
    GetUnitFeederAssignmentsHandler,
    FeederDoseSplitService,
    FeederDoseDirectiveService,
    FeedingProtocolV2Resolver,
    MealExecutionResolver,
    FeedForecastResolver,
    FeederAssignmentResolver,
  ],
  exports: [
    ProtocolValidationService,
    ProtocolRateService,
    UnitProtocolResolverService,
    MealPlanGeneratorService,
    BiomassGrowthApplierService,
    DayPlanRecalcService,
    MealExecutionService,
    ProtocolFeedForecastService,
    // Doz bölme SSoT'si — öğün üretimi ve mobil pano aynı gövdeyi okur.
    FeederDoseSplitService,
    // Doz → sürücü hızı + motor çalışma süresi türetmesinin TEK gövdesi.
    FeederDoseDirectiveService,
  ],
})
export class FeedingProtocolModule {}
