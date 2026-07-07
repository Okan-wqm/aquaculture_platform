/**
 * Feeding Module
 *
 * Yemleme yönetimi ve FCR hesaplamaları.
 * Günlük yemleme programları ve kayıtları.
 *
 * Sağladığı özellikler:
 * - FCR bazlı yemleme tabloları
 * - Günlük yemleme kayıtları
 * - Planlanan vs Gerçekleşen takibi
 * - Çevresel koşul kayıtları
 * - Balık davranışı gözlemleri
 *
 * @module Feeding
 */
import { MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FarmMobileCommandReceipt } from '../mobile-command/entities/farm-mobile-command-receipt.entity';

// Entities
import { FeedingTable } from './entities/feeding-table.entity';
import { FeedingRecord } from './entities/feeding-record.entity';
import { GetFeedingOverviewResponder } from './responders/get-feeding-overview.responder';
import { FeedInventory } from './entities/feed-inventory.entity';
import { FeedingProgram } from './entities/feeding-program.entity';
import { FeedingProgramTank } from './entities/feeding-program-tank.entity';
import { DailyFeedingExecution } from './entities/daily-feeding-execution.entity';

// Related entities
import { Batch } from '../batch/entities/batch.entity';
import { BatchFeedAssignment } from '../batch/entities/batch-feed-assignment.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { Feed } from '../feed/entities/feed.entity';
import { Tank } from '../tank/entities/tank.entity';
import { Site } from '../site/entities/site.entity';
import { Equipment } from '../equipment/entities/equipment.entity';

// Services
import { FeedSelectorService } from './services/feed-selector.service';
import { BilinearInterpolationService } from './services/bilinear-interpolation.service';
import { GrowthSimulatorService } from './services/growth-simulator.service';
import { FeedConsumptionForecastService } from './services/feed-consumption-forecast.service';
import { FeedingProgramService } from './services/feeding-program.service';
import { DailyFeedingExecutionService } from './services/daily-feeding-execution.service';
import { WaterTemperatureService } from '../water-quality/services/water-temperature.service';

// Handlers
import { FeedingCommandHandlers } from './handlers';
import { FeedingQueryHandlers } from './query-handlers';

// Resolvers
import { FeedingResolvers } from './resolvers';

// Cross-cutting: backdate policy (phase 1.5) enforces the
// FEEDING_BACKDATE_LIMIT_DAYS + future-date rejection rules inside
// CreateFeedingRecordHandler. Imported here so the DI container
// resolves the service for every feeding command handler.
import { BackdatePolicyModule } from '../common/services/backdate-policy.module';
// Phase 4.2: restoreFeedingProgram mutation delegates to RestoreService.
import { RestoreModule } from '../common/services/restore.module';
// Feed dual-SSoT write-path correctness (Phase A): the feeding write path
// asserts the batch is feedable (BatchModule → BatchDomainService) and
// deducts feed from the storage ledger inside the feeding transaction
// (InventoryModule → StockMovementService). Neither module imports
// FeedingModule, so there is no DI cycle.
import { BatchModule } from '../batch/batch.module';
import { InventoryModule } from '../storage/storage.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      FeedingTable,
      FeedingRecord,
      FeedInventory,
      FeedingProgram,
      FeedingProgramTank,
      DailyFeedingExecution,
      Batch,
      BatchFeedAssignment,
      TankBatch,
      Feed,
      Tank,
      Site,
      Equipment,
      FarmMobileCommandReceipt,
    ]),
    BackdatePolicyModule,
    RestoreModule,
    BatchModule,
    InventoryModule,
  ],
  controllers: [GetFeedingOverviewResponder],
  providers: [
    FeedSelectorService,
    WaterTemperatureService,
    BilinearInterpolationService,
    GrowthSimulatorService,
    FeedConsumptionForecastService,
    FeedingProgramService,
    DailyFeedingExecutionService,
    MobileCommandReceiptService,
    // SEC-HIGH-051 / SEC-HIGH-052: site authz SSoT + mobile-feature guard.
    SiteAuthorizationService,
    MobileFeatureGuard,
    ...FeedingCommandHandlers,
    ...FeedingQueryHandlers,
    ...FeedingResolvers,
  ],
  exports: [
    TypeOrmModule,
    FeedSelectorService,
    BilinearInterpolationService,
    GrowthSimulatorService,
    FeedConsumptionForecastService,
    FeedingProgramService,
    DailyFeedingExecutionService,
  ],
})
export class FeedingModule {}
