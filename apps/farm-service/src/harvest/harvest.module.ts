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
import { CqrsModule } from '@platform/cqrs';

// Entities
import { HarvestPlan } from './entities/harvest-plan.entity';
import { HarvestRecord } from './entities/harvest-record.entity';

// Related entities
import { Batch } from '../batch/entities/batch.entity';
import { Tank } from '../tank/entities/tank.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { TankOperation } from '../batch/entities/tank-operation.entity';

// Handlers
import { CreateHarvestRecordHandler } from './handlers/create-harvest-record.handler';

// Resolvers
import { HarvestResolver } from './resolvers/harvest.resolver';

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
    CqrsModule,
  ],
  providers: [
    // Handlers
    CreateHarvestRecordHandler,
    // Resolvers
    HarvestResolver,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class HarvestModule {}
