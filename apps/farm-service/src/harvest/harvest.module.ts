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
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { HarvestPlan } from './entities/harvest-plan.entity';
import { HarvestRecord } from './entities/harvest-record.entity';

// Related entities
import { Batch } from '../batch/entities/batch.entity';
import { Tank } from '../tank/entities/tank.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { TankOperation } from '../batch/entities/tank-operation.entity';

// Services
import { HarvestPlanService } from './services/harvest-plan.service';

// Command Handlers
import { CreateHarvestRecordHandler } from './handlers/create-harvest-record.handler';
import { UpdateHarvestRecordHandler } from './handlers/update-harvest-record.handler';
import { DeleteHarvestRecordHandler } from './handlers/delete-harvest-record.handler';

// Query Handlers
import { ListHarvestsHandler } from './handlers/list-harvests.handler';
import { GetHarvestHandler } from './handlers/get-harvest.handler';
import { GetHarvestStatisticsHandler } from './handlers/get-harvest-statistics.handler';

// Resolvers
import { HarvestResolver } from './resolvers/harvest.resolver';
import { HarvestPlanResolver } from './resolvers/harvest-plan.resolver';

// Cross-module: withdrawal-period / harvest-eligibility enforcement lives
// in the fish-health module and is shared here so createHarvestRecord can
// block harvests that would violate an active medicine withdrawal window.
import { FishHealthModule } from '../fish-health/fish-health.module';

// Cross-cutting: backdate policy for harvest records
// (HARVEST_BACKDATE_LIMIT_DAYS, default 7).
import { BackdatePolicyModule } from '../common/services/backdate-policy.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      HarvestPlan,
      HarvestRecord,
      Batch,
      Tank,
      TankBatch,
      TankOperation,
    ]),
    FishHealthModule,
    BackdatePolicyModule,
  ],
  providers: [
    // Services
    HarvestPlanService,
    // Command Handlers
    CreateHarvestRecordHandler,
    UpdateHarvestRecordHandler,
    DeleteHarvestRecordHandler,
    // Query Handlers
    ListHarvestsHandler,
    GetHarvestHandler,
    GetHarvestStatisticsHandler,
    // Resolvers
    HarvestResolver,
    HarvestPlanResolver,
  ],
  exports: [
    TypeOrmModule,
    HarvestPlanService,
  ],
})
export class HarvestModule {}
