import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@platform/cqrs';

// Entities
import { Farm } from './entities/farm.entity';
import { Pond } from './entities/pond.entity';
import { PondBatch } from './entities/batch.entity';

// Resolvers
import { FarmResolver } from './resolvers/farm.resolver';

// Command Handlers
import { CreateFarmHandler } from './handlers/create-farm.handler';
import { CreatePondHandler } from './handlers/create-pond.handler';
import { CreatePondBatchHandler } from './handlers/create-batch.handler';
import { HarvestBatchHandler } from './handlers/harvest-batch.handler';

// Query Handlers
import { GetFarmQueryHandler } from './query-handlers/get-farm.handler';
import { ListFarmsQueryHandler } from './query-handlers/list-farms.handler';
import { GetPondQueryHandler } from './query-handlers/get-pond.handler';
import { ListPondBatchesHandler } from './query-handlers/list-batches.handler';

// Setup submodules
import { SiteModule } from '../site/site.module';
import { DepartmentModule } from '../department/department.module';
import { EquipmentModule } from '../equipment/equipment.module';
import { SupplierModule } from '../supplier/supplier.module';
import { ChemicalModule } from '../chemical/chemical.module';
import { FeedModule } from '../feed/feed.module';

/**
 * Farm Module
 * Contains all farm-related functionality including:
 * - Farm management (CRUD operations)
 * - Pond management
 * - Batch management (stocking, harvesting)
 * - Site/Department/Equipment setup
 * - Supplier/Chemical/Feed management
 * - CQRS command/query handlers
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Farm, Pond, PondBatch]),
    CqrsModule,
    // Setup submodules
    SiteModule,
    DepartmentModule,
    EquipmentModule,
    SupplierModule,
    ChemicalModule,
    FeedModule,
  ],
  providers: [
    // Resolvers
    FarmResolver,

    // Command Handlers
    CreateFarmHandler,
    CreatePondHandler,
    CreatePondBatchHandler,
    HarvestBatchHandler,

    // Query Handlers
    GetFarmQueryHandler,
    ListFarmsQueryHandler,
    GetPondQueryHandler,
    ListPondBatchesHandler,
  ],
  exports: [TypeOrmModule],
})
export class FarmModule {}
