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
import { TankOperation } from '../batch/entities/tank-operation.entity';
import { FeedingRecord } from '../feeding/entities/feeding-record.entity';
import { FeedingProgram } from '../feeding/entities/feeding-program.entity';
import { FeedingProgramTank } from '../feeding/entities/feeding-program-tank.entity';
import { Species } from '../species/entities/species.entity';

// Cross-cutting: growth-measurement backdating (GROWTH_BACKDATE_LIMIT_DAYS,
// default 30) is enforced in RecordGrowthSampleHandler.
import { BackdatePolicyModule } from '../common/services/backdate-policy.module';

// Stateless band/oran/FCR SSoT çözücüsü — getTargetFCR v2 zinciri (P-14).
// Doğrudan provider: FeedingProtocolModule import'u modül döngüsü yaratırdı
// (BatchModule/HarvestModule emsali).
import { ProtocolRateService } from '../feeding-protocol/services/protocol-rate.service';
// Tartımın üniteye inmesi (0.1) ve gün planının ölçülen ağırlıktan yeniden
// fiyatlanması için gereken iki servis. AYNI doğrudan-provider gerekçesi:
// FeedingProtocolModule'ü import etmek modül döngüsü yaratırdı. İkisi de
// EntityManager üzerinden çalışır (repository enjeksiyonu yok), bu yüzden
// ek `forFeature` kaydı gerekmez.
import { BiomassGrowthApplierService } from '../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../feeding-protocol/services/day-plan-recalc.service';

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
      TankOperation,
    ]),
    BackdatePolicyModule,
  ],
  providers: [
    FCRCalculationService,
    ProtocolRateService,
    BiomassGrowthApplierService,
    DayPlanRecalcService,
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
