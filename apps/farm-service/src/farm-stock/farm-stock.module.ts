import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FarmStockBatchSnapshot } from './entities/farm-stock-batch-snapshot.entity';
import { FarmStockContainerSnapshot } from './entities/farm-stock-container-snapshot.entity';
import { FarmStockProjectionService } from './farm-stock-projection.service';
import { FarmStockResolver } from './farm-stock.resolver';
import { FarmStockService } from './farm-stock.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      FarmStockContainerSnapshot,
      FarmStockBatchSnapshot,
    ]),
  ],
  providers: [FarmStockResolver, FarmStockService, FarmStockProjectionService],
  exports: [FarmStockService, FarmStockProjectionService, TypeOrmModule],
})
export class FarmStockModule {}
