/**
 * FarmSeedModule — reference data (every environment) and the dev/test demo
 * farm (FarmSeedService).
 *
 * WHY its own module (V-B1-14 of the B1a-1 verifier round): the demo stock is
 * written through THE storage-ledger sink (StockMovementService), which the
 * storage module exports. The seed used to live in the @Global DatabaseModule,
 * which must not import the storage module; so the seed wrote the ledger rows
 * and the catalog projection by hand — a second writer. Here it imports the
 * sink instead.
 */
import { Module } from '@nestjs/common';

import { InventoryModule } from '../storage/storage.module';
import { FarmSeedService } from './services/farm-seed.service';

@Module({
  imports: [InventoryModule],
  providers: [FarmSeedService],
})
export class FarmSeedModule {}
