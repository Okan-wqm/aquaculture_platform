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

import { Batch } from '../batch/entities/batch.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { TankOperation } from '../batch/entities/tank-operation.entity';
import { Department } from '../department/entities/department.entity';
import { FarmStockModule } from '../farm-stock/farm-stock.module';
import { Species } from '../species/entities/species.entity';

import { Tank } from './entities/tank.entity';
import { TankHandlers } from './handlers';
import { TankResolver } from './resolvers/tank.resolver';
import { TankCapacityService } from './services/tank-capacity.service';
import { GetTankRegistryResponder } from './responders/get-tank-registry.responder';

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
    FarmStockModule,
  ],
  controllers: [GetTankRegistryResponder],
  providers: [
    TankCapacityService,
    ...TankHandlers,
    TankResolver,
  ],
  exports: [
    TypeOrmModule,
    // Exported so batch handlers (deploy-cleaner-fish, allocate-to-tank,
    // transfer-batch, create-batch) can consume the density check
    // without re-declaring the calculation.
    TankCapacityService,
  ],
})
export class TankModule {}
