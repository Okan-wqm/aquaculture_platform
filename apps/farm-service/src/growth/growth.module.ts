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
import { CqrsModule } from '@platform/cqrs';

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
import { FeedingRecord } from '../feeding/entities/feeding-record.entity';
import { Species } from '../species/entities/species.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GrowthMeasurement,
      Batch,
      FeedingRecord,
      Species,
    ]),
    CqrsModule,
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
