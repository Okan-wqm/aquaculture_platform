import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { Farm } from './entities/farm.entity';
import { Pond } from './entities/pond.entity';

// Resolvers
import { FarmResolver } from './resolvers/farm.resolver';

// Command Handlers
import { CreateFarmHandler } from './handlers/create-farm.handler';
import { UpdateFarmHandler } from './handlers/update-farm.handler';
import { CreatePondHandler } from './handlers/create-pond.handler';

// Query Handlers
import { GetFarmQueryHandler } from './query-handlers/get-farm.handler';
import { ListFarmsQueryHandler } from './query-handlers/list-farms.handler';
import { GetPondQueryHandler } from './query-handlers/get-pond.handler';

// Setup submodules
import { SiteModule } from '../site/site.module';
import { DepartmentModule } from '../department/department.module';
import { EquipmentModule } from '../equipment/equipment.module';
import { SupplierModule } from '../supplier/supplier.module';
import { ChemicalModule } from '../chemical/chemical.module';
import { FeedModule } from '../feed/feed.module';

/**
 * Farm Module
 * Contains farm-level infrastructure functionality:
 * - Farm management (CRUD operations)
 * - Pond management (for farms that still model pond infrastructure)
 * - Site/Department/Equipment setup
 * - Supplier/Chemical/Feed management
 * - CQRS command/query handlers for farms + ponds
 *
 * Batch lifecycle (stocking, harvesting, transfers, cleaner fish) lives
 * entirely under `../batch/BatchModule`, which owns the canonical
 * `Batch` entity (`batches_v2` table). An earlier revision of this
 * module also owned a parallel `PondBatch` entity backed by the legacy
 * `batches` table, but that code path had zero frontend and zero
 * cross-service consumers and used a text-typed `tenantId` column that
 * was architecturally incompatible with the platform's uuid tenant
 * convention (and actively crashed `EnableRowLevelSecurity1776000000000`
 * in every production deploy). PondBatch has therefore been fully
 * removed; use `BatchModule`'s `Batch` entity and `batches`/`batch`
 * GraphQL fields for every batch operation going forward.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Farm, Pond]),
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
    UpdateFarmHandler,
    CreatePondHandler,

    // Query Handlers
    GetFarmQueryHandler,
    ListFarmsQueryHandler,
    GetPondQueryHandler,
  ],
  exports: [TypeOrmModule],
})
export class FarmModule {}
