import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FarmStockBatchSnapshot } from './entities/farm-stock-batch-snapshot.entity';
import { FarmStockContainerSnapshot } from './entities/farm-stock-container-snapshot.entity';
import { FarmStockProjectionService } from './farm-stock-projection.service';
import { FarmStockResolver } from './farm-stock.resolver';
// Read query handler (fail-closed tenant boundary — FARM-HIGH-060)
import { GetFarmStockInventoryHandler } from './handlers/get-farm-stock-inventory.handler';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      FarmStockContainerSnapshot,
      FarmStockBatchSnapshot,
    ]),
  ],
  providers: [FarmStockResolver, GetFarmStockInventoryHandler, FarmStockProjectionService],
  exports: [FarmStockProjectionService, TypeOrmModule],
})
export class FarmStockModule {}
