/**
 * Tank Module
 *
 * Yetiştirme tanklarının yönetimi. Fiziksel tankların boyutları,
 * kapasiteleri ve durumlarını yönetir.
 *
 * Sağladığı özellikler:
 * - Tank CRUD operasyonları
 * - Otomatik hacim hesaplama (circular, rectangular, raceway)
 * - Kapasite ve yoğunluk yönetimi
 * - Status yönetimi (state machine)
 *
 * @module Tank
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@platform/cqrs';

// Entities
import { Tank } from './entities/tank.entity';
import { Department } from '../department/entities/department.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { TankOperation } from '../batch/entities/tank-operation.entity';
import { Batch } from '../batch/entities/batch.entity';
import { Species } from '../species/entities/species.entity';

// Handlers
import { TankHandlers } from './handlers';

// Resolvers
import { TankResolver } from './resolvers/tank.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tank,
      Department,
      TankBatch,
      TankOperation,
      Batch,
      Species,
    ]),
    CqrsModule,
  ],
  providers: [
    ...TankHandlers,
    TankResolver,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class TankModule {}
