/**
 * Batch Module
 *
 * Üretim partilerinin yönetimi. Batch'lerin yaşam döngüsünü,
 * lokasyonlarını ve mortality'lerini takip eder.
 *
 * Sağladığı özellikler:
 * - Batch CRUD operasyonları
 * - Multi-location batch tracking (BatchLocation M2M)
 * - Mortality kayıtları ve analizi
 * - Dual weight tracking (theoretical vs actual)
 * - FCR takibi
 *
 * @module Batch
 */
import { MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BackdatePolicyModule } from '../common/services/backdate-policy.module';
import { RestoreModule } from '../common/services/restore.module';
import { EquipmentType } from '../equipment/entities/equipment-type.entity';
import { Equipment } from '../equipment/entities/equipment.entity';
import { FarmStockModule } from '../farm-stock/farm-stock.module';
import { Feed } from '../feed/entities/feed.entity';
// FinanceModule exports the currency SSoT resolver (FARM-HIGH-146). No
// cycle: FinanceModule imports no domain module.
import { FinanceModule } from '../finance/finance.module';
import { HealthEvent } from '../fish-health/entities/health-event.entity';
import { FishHealthModule } from '../fish-health/fish-health.module';
import { GrowthMeasurement } from '../growth/entities/growth-measurement.entity';
import { GrowthModule } from '../growth/growth.module';
import { WorkOrder } from '../maintenance/entities/work-order.entity';
import { FarmMobileCommandReceipt } from '../mobile-command/entities/farm-mobile-command-receipt.entity';
import { Species } from '../species/entities/species.entity';
import { Tank } from '../tank/entities/tank.entity';
import { TankModule } from '../tank/tank.module';

import { BatchController, TankOperationsController } from './controllers/batch.controller';
import { BatchDocumentDataLoader } from './dataloaders/batch-document.dataloader';
import { BatchFeedAssignmentDataLoader } from './dataloaders/batch-feed-assignment.dataloader';
import { BatchLocationDataLoader } from './dataloaders/batch-location.dataloader';
import { BatchDocument } from './entities/batch-document.entity';
import { BatchFeedAssignment } from './entities/batch-feed-assignment.entity';
import { BatchLocation } from './entities/batch-location.entity';
import { Batch } from './entities/batch.entity';
import { MortalityRecord } from './entities/mortality-record.entity';
import { TankAllocation } from './entities/tank-allocation.entity';
import { TankBatch } from './entities/tank-batch.entity';
import { TankOperation } from './entities/tank-operation.entity';
import { BatchCommandHandlers } from './handlers';
import { BatchQueryHandlers } from './query-handlers';
import { BatchResolvers } from './resolvers';
import { BatchCostCalculatorService } from './services/batch-cost-calculator.service';
import { BatchDomainService } from './services/batch-domain.service';
import { BatchLifecyclePolicyService } from './services/batch-lifecycle-policy.service';
import { BatchService } from './services/batch.service';
import { BiomassCalculatorService } from './services/biomass-calculator.service';
import { TankCountReconcileService } from './services/tank-count-reconcile.service';
import { TankBatchModule } from './tank-batch.module';
import { MortalityCullPolicyService } from './services/mortality-cull-policy.service';
import { SGRCalculatorService } from './services/sgr-calculator.service';

// Cross-cutting: backdate policy for mortality observations
// (MORTALITY_BACKDATE_LIMIT_DAYS, default 14).

// Cross-cutting: restoreBatchFeedAssignment mutation delegates to
// RestoreService — closes FARM-MEDIUM-002's last entity gap (5/5 of
// the Phase 4.2 restorable surface) and FARM-MEDIUM-003 (the resolver
// converged onto TypeORM repos so RestoreService.restore() can run
// against it uniformly with the other restorable entities).

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Batch,
      BatchDocument,
      BatchFeedAssignment,
      BatchLocation,
      MortalityRecord,
      TankAllocation,
      TankBatch,
      TankOperation,
      Species,
      Tank,
      Equipment,
      EquipmentType,
      Feed,
      FarmMobileCommandReceipt,
      GrowthMeasurement,
      HealthEvent,
      WorkOrder,
    ]),
    TankModule,
    FishHealthModule,
    BackdatePolicyModule,
    RestoreModule,
    // The single SSoT writer for tank composition (applyBatchDelta). Shared via
    // its own module so allocate/mortality/cull/transfer here AND the harvest
    // handlers in HarvestModule resolve the same instance (never a per-module copy).
    TankBatchModule,
    FarmStockModule,
    FinanceModule,
    ConfigModule,
    // WHY: CloseBatchHandler + GetBatchPerformanceHandler now inject
    // FCRCalculationService (the single FCR authority, Tier-1 SSoT consolidation),
    // which is provided+exported ONLY by GrowthModule. No cycle: GrowthModule
    // imports only TypeOrmModule.forFeature + BackdatePolicyModule, never BatchModule.
    GrowthModule,
  ],
  controllers: [
    BatchController,
    TankOperationsController,
  ],
  providers: [
    BatchService,
    TankCountReconcileService,
    BatchDomainService,
    BatchLifecyclePolicyService,
    MortalityCullPolicyService,
    SGRCalculatorService,
    BiomassCalculatorService,
    BatchCostCalculatorService,
    BatchDocumentDataLoader,  // REQUEST-scoped: one instance per GraphQL request
    BatchLocationDataLoader,  // REQUEST-scoped: eliminates N+1 for batch.locations
    BatchFeedAssignmentDataLoader,  // REQUEST-scoped: eliminates N+1 for batch.feedAssignments
    MobileCommandReceiptService,
    // SEC-HIGH-051 / SEC-HIGH-052: object-level site authz SSoT (injected by the
    // stock handlers) + the mobile-feature guard (composed on the resolver).
    SiteAuthorizationService,
    MobileFeatureGuard,
    ...BatchCommandHandlers,
    ...BatchQueryHandlers,
    ...BatchResolvers,
  ],
  exports: [
    TypeOrmModule,
    BatchService,
    // Exported so feeding handlers can call assertFeedable(batch) inside the
    // feeding transaction (rejects feeding an empty / non-feedable batch).
    // BatchDomainService is stateless pure domain logic (no DB access), so
    // exporting it introduces no cross-module data coupling.
    BatchDomainService,
    SGRCalculatorService,
    BiomassCalculatorService,
    BatchCostCalculatorService,
  ],
})
export class BatchModule {}
