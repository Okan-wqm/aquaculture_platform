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
import { CqrsModule } from '@platform/cqrs';

// Entities
import { Batch } from './entities/batch.entity';
import { BatchDocument } from './entities/batch-document.entity';
import { BatchLocation } from './entities/batch-location.entity';
import { MortalityRecord } from './entities/mortality-record.entity';
import { TankAllocation } from './entities/tank-allocation.entity';
import { TankBatch } from './entities/tank-batch.entity';
import { TankOperation } from './entities/tank-operation.entity';

// Related entities
import { Species } from '../species/entities/species.entity';
import { Tank } from '../tank/entities/tank.entity';
import { Equipment } from '../equipment/entities/equipment.entity';

// Services
import { BatchService } from './services/batch.service';
import { SGRCalculatorService } from './services/sgr-calculator.service';
import { BiomassCalculatorService } from './services/biomass-calculator.service';

// Growth entities for calculators
import { GrowthMeasurement } from '../growth/entities/growth-measurement.entity';

// Controllers
import { BatchController, TankOperationsController } from './controllers/batch.controller';

// Database services
import { CodeGeneratorService } from '../database/services/code-generator.service';

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
      BatchLocation,
      MortalityRecord,
      TankAllocation,
      TankBatch,
      TankOperation,
      Species,
      Tank,
      Equipment,
      GrowthMeasurement,
    ]),
    CqrsModule,
  ],
  controllers: [
    BatchController,
    TankOperationsController,
  ],
  providers: [
    BatchService,
    SGRCalculatorService,
    BiomassCalculatorService,
    CodeGeneratorService,
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
