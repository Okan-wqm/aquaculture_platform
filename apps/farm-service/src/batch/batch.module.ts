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
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { Batch } from './entities/batch.entity';
import { BatchDocument } from './entities/batch-document.entity';
import { BatchFeedAssignment } from './entities/batch-feed-assignment.entity';
import { BatchLocation } from './entities/batch-location.entity';
import { MortalityRecord } from './entities/mortality-record.entity';
import { TankAllocation } from './entities/tank-allocation.entity';
import { TankBatch } from './entities/tank-batch.entity';
import { TankOperation } from './entities/tank-operation.entity';

// Related entities
import { Species } from '../species/entities/species.entity';
import { Tank } from '../tank/entities/tank.entity';
import { Equipment } from '../equipment/entities/equipment.entity';
import { EquipmentType } from '../equipment/entities/equipment-type.entity';
import { Feed } from '../feed/entities/feed.entity';

// Services
import { BatchService } from './services/batch.service';
import { BatchDomainService } from './services/batch-domain.service';
import { SGRCalculatorService } from './services/sgr-calculator.service';
import { BiomassCalculatorService } from './services/biomass-calculator.service';
import { BatchDocumentDataLoader } from './dataloaders/batch-document.dataloader';
import { BatchLocationDataLoader } from './dataloaders/batch-location.dataloader';
import { BatchFeedAssignmentDataLoader } from './dataloaders/batch-feed-assignment.dataloader';

// Growth entities for calculators
import { GrowthMeasurement } from '../growth/entities/growth-measurement.entity';

// Controllers
import { BatchController, TankOperationsController } from './controllers/batch.controller';

// Command Handlers
import { BatchCommandHandlers } from './handlers';

// Query Handlers
import { BatchQueryHandlers } from './query-handlers';

// Resolvers
import { BatchResolvers } from './resolvers';

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
      GrowthMeasurement,
    ]),
  ],
  controllers: [
    BatchController,
    TankOperationsController,
  ],
  providers: [
    BatchService,
    BatchDomainService,
    SGRCalculatorService,
    BiomassCalculatorService,
    BatchDocumentDataLoader,  // REQUEST-scoped: one instance per GraphQL request
    BatchLocationDataLoader,  // REQUEST-scoped: eliminates N+1 for batch.locations
    BatchFeedAssignmentDataLoader,  // REQUEST-scoped: eliminates N+1 for batch.feedAssignments
    ...BatchCommandHandlers,
    ...BatchQueryHandlers,
    ...BatchResolvers,
  ],
  exports: [
    TypeOrmModule,
    BatchService,
    SGRCalculatorService,
    BiomassCalculatorService,
  ],
})
export class BatchModule {}
