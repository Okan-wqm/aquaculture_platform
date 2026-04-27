import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities — READ-ONLY LEGACY. Farm / Pond tables exist for backward
// compat with tenants that loaded data before the Site/Department/
// System/Tank hierarchy became the canonical model. No new writes
// land in these tables; the GraphQL createFarm / createPond mutations
// throw BadRequestException (see farm.resolver.ts, marked @deprecated).
import { Farm } from './entities/farm.entity';
import { Pond } from './entities/pond.entity';

// Resolver — still registers createFarm / createPond mutations under
// @deprecated so existing client code gets a clear error message
// instead of a silent NotFound. The mutations do not dispatch to any
// command handler any more.
import { FarmResolver } from './resolvers/farm.resolver';

// Query Handlers only — legacy reads remain available for tenants
// with historical data in farm.farms / farm.ponds.
import { GetFarmQueryHandler } from './query-handlers/get-farm.handler';
import { ListFarmsQueryHandler } from './query-handlers/list-farms.handler';
import { GetPondQueryHandler } from './query-handlers/get-pond.handler';

// Setup submodules — these are the actively-used hierarchy modules
// (Site > Department > System > Tank, plus equipment/supplier/chemical/
// feed catalogues). FarmModule aggregates them for legacy reasons;
// each submodule is self-contained.
import { SiteModule } from '../site/site.module';
import { DepartmentModule } from '../department/department.module';
import { EquipmentModule } from '../equipment/equipment.module';
import { SupplierModule } from '../supplier/supplier.module';
import { ChemicalModule } from '../chemical/chemical.module';
import { FeedModule } from '../feed/feed.module';

/**
 * Farm Module — READ-ONLY LEGACY surface.
 *
 * The business model does not register farms. The real hierarchy is
 * Site → Department → System → Tank, and the corresponding entity
 * surfaces live in Site/Department/System/Equipment modules (imported
 * here as a convenience aggregation).
 *
 * The `Farm` and `Pond` entities are kept so tenants whose historical
 * data predates the hierarchy change can still read their records.
 * Write paths (createFarm / createPond / updateFarm) are blocked:
 *
 *   - `FarmResolver.createFarm` and `createPond` are `@deprecated` and
 *     throw BadRequestException; they do not dispatch to any handler.
 *   - The `CreateFarmHandler` / `CreatePondHandler` / `UpdateFarmHandler`
 *     classes were dead code (no resolver dispatched to UpdateFarm at
 *     any point in git history) and have been deleted — phase 1.2 of
 *     the "kalan kör noktalar" plan. Their command classes were
 *     deleted with them.
 *
 * `FarmRepository` (via `TypeOrmModule.forFeature([Farm, Pond])`) is
 * still registered so the three query handlers can run. Do NOT
 * re-add write handlers here without also removing the @deprecated
 * annotations in `farm.resolver.ts`.
 *
 * Batch lifecycle lives entirely under `../batch/BatchModule`, which
 * owns the canonical `Batch` entity (`batches_v2` table). An earlier
 * revision of this module also owned a parallel `PondBatch` entity
 * backed by the legacy `batches` table; that surface was fully
 * removed on the pre-Phase-6 `EnableRowLevelSecurity1776000000000`
 * migration work.
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

    // Query Handlers — legacy reads only.
    GetFarmQueryHandler,
    ListFarmsQueryHandler,
    GetPondQueryHandler,
  ],
  exports: [TypeOrmModule],
})
export class FarmModule {}
