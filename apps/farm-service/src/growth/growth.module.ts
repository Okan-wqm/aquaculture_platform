/**
 * Growth Module
 *
 * Balık büyümesi takibi ve FCR hesaplamaları.
 * Sample-based istatistiksel analiz yapar.
 *
 * Sağladığı özellikler:
 * - Periyodik büyüme ölçümleri
 * - İstatistiksel analiz (avg, stdDev, CV, CI)
 * - Theoretical vs Actual karşılaştırması
 * - FCR trend analizi
 * - Otomatik aksiyon önerileri
 *
 * @module Growth
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { GrowthMeasurement } from './entities/growth-measurement.entity';

// Services
import { FCRCalculationService } from './services/fcr-calculation.service';

// Handlers
import { GrowthCommandHandlers } from './handlers';
import { GrowthQueryHandlers } from './query-handlers';

// Resolvers
import { GrowthResolvers } from './resolvers';

// Related entities
import { Batch } from '../batch/entities/batch.entity';
import { BatchLocation } from '../batch/entities/batch-location.entity';
import { FeedingRecord } from '../feeding/entities/feeding-record.entity';
import { FeedingProgram } from '../feeding/entities/feeding-program.entity';
import { FeedingProgramTank } from '../feeding/entities/feeding-program-tank.entity';
import { Species } from '../species/entities/species.entity';

// Cross-cutting: growth-measurement backdating (GROWTH_BACKDATE_LIMIT_DAYS,
// default 30) is enforced in RecordGrowthSampleHandler.
import { BackdatePolicyModule } from '../common/services/backdate-policy.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GrowthMeasurement,
      Batch,
      BatchLocation,
      FeedingRecord,
      FeedingProgram,
      FeedingProgramTank,
      Species,
    ]),
    BackdatePolicyModule,
  ],
  providers: [
    FCRCalculationService,
    ...GrowthCommandHandlers,
    ...GrowthQueryHandlers,
    ...GrowthResolvers,
  ],
  exports: [
    TypeOrmModule,
    FCRCalculationService,
  ],
})
export class GrowthModule {}
