/**
 * Harvest Module
 *
 * Hasat planlaması ve yönetimi.
 * Kalite kontrolü ve izlenebilirlik.
 *
 * Sağladığı özellikler:
 * - Hasat planı oluşturma
 * - Çoklu hasat desteği
 * - Kalite kontrol ve sınıflandırma
 * - Lot/parti takibi
 * - Müşteri sevkiyat yönetimi
 * - Verim hesaplama
 *
 * @module Harvest
 */
import { MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Batch } from '../batch/entities/batch.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { TankOperation } from '../batch/entities/tank-operation.entity';
import { BackdatePolicyModule } from '../common/services/backdate-policy.module';
import { FarmStockModule } from '../farm-stock/farm-stock.module';
import { FishHealthModule } from '../fish-health/fish-health.module';
import { FarmMobileCommandReceipt } from '../mobile-command/entities/farm-mobile-command-receipt.entity';
import { Tank } from '../tank/entities/tank.entity';

import { HarvestPlan } from './entities/harvest-plan.entity';
import { HarvestRecord } from './entities/harvest-record.entity';
import { CreateHarvestRecordHandler } from './handlers/create-harvest-record.handler';
import { DeleteHarvestRecordHandler } from './handlers/delete-harvest-record.handler';
import { GetHarvestStatisticsHandler } from './handlers/get-harvest-statistics.handler';
import { GetHarvestHandler } from './handlers/get-harvest.handler';
import { ListHarvestsHandler } from './handlers/list-harvests.handler';
import { UpdateHarvestRecordHandler } from './handlers/update-harvest-record.handler';
// Harvest-plan read handlers (fail-closed tenant boundary — FARM-HIGH-074)
import { GetHarvestPlanHandler } from './handlers/get-harvest-plan.handler';
import { GetHarvestPlanByCodeHandler } from './handlers/get-harvest-plan-by-code.handler';
import { ListHarvestPlansHandler } from './handlers/list-harvest-plans.handler';
import { ListHarvestPlansByBatchHandler } from './handlers/list-harvest-plans-by-batch.handler';
import { ListUpcomingHarvestPlansHandler } from './handlers/list-upcoming-harvest-plans.handler';
import { ListOverdueHarvestPlansHandler } from './handlers/list-overdue-harvest-plans.handler';
import { GetHarvestPlanStatsHandler } from './handlers/get-harvest-plan-stats.handler';
import { HarvestPlanResolver } from './resolvers/harvest-plan.resolver';
import { HarvestResolver } from './resolvers/harvest.resolver';
import { HarvestPlanService } from './services/harvest-plan.service';
import { HarvestPolicyService } from './services/harvest-policy.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      HarvestPlan,
      HarvestRecord,
      Batch,
      Tank,
      TankBatch,
      TankOperation,
      FarmMobileCommandReceipt,
    ]),
    FishHealthModule,
    BackdatePolicyModule,
    FarmStockModule,
    ConfigModule,
  ],
  providers: [
    // Services
    HarvestPlanService,
    HarvestPolicyService,
    MobileCommandReceiptService,
    // SEC-HIGH-051 / SEC-HIGH-052: site authz SSoT + mobile-feature guard.
    SiteAuthorizationService,
    MobileFeatureGuard,
    // Command Handlers
    CreateHarvestRecordHandler,
    UpdateHarvestRecordHandler,
    DeleteHarvestRecordHandler,
    // Query Handlers
    ListHarvestsHandler,
    GetHarvestHandler,
    GetHarvestStatisticsHandler,
    // Harvest-plan read handlers
    GetHarvestPlanHandler,
    GetHarvestPlanByCodeHandler,
    ListHarvestPlansHandler,
    ListHarvestPlansByBatchHandler,
    ListUpcomingHarvestPlansHandler,
    ListOverdueHarvestPlansHandler,
    GetHarvestPlanStatsHandler,
    // Resolvers
    HarvestResolver,
    HarvestPlanResolver,
  ],
  exports: [
    TypeOrmModule,
    HarvestPlanService,
    HarvestPolicyService,
  ],
})
export class HarvestModule {}
