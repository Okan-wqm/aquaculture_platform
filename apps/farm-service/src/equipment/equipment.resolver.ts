/**
 * Equipment GraphQL Resolver
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  ResolveField,
  Parent,
  Context,
} from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { TenantContextError } from '@aquaculture/backend-common/database';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';
import { getTenantSchemaName } from '../common/utils/schema-sanitizer';
import { FarmGraphQLContext } from '../common/types/graphql-context.types';
import {
  EquipmentResponse,
  PaginatedEquipmentResponse,
  EquipmentTypeResponse,
  EquipmentSystemResponse,
  EquipmentBatchMetrics,
} from './dto/equipment.response';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { FeedSelectorService } from '../feeding/services/feed-selector.service';
import { tankBandWeightG } from '../feeding-protocol/services/protocol-rate.service';
import { WaterTemperatureService } from '../water-quality/services/water-temperature.service';
import { EquipmentDeletePreviewResponse } from './dto/equipment-delete-preview.response';
import { CreateEquipmentInput } from './dto/create-equipment.input';
import { UpdateEquipmentInput } from './dto/update-equipment.input';
import { EquipmentFilterInput, EquipmentTypeFilterInput } from './dto/equipment-filter.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateEquipmentCommand } from './commands/create-equipment.command';
import { UpdateEquipmentCommand } from './commands/update-equipment.command';
import { DeleteEquipmentCommand } from './commands/delete-equipment.command';
import { GetEquipmentQuery } from './queries/get-equipment.query';
import { ListEquipmentQuery } from './queries/list-equipment.query';
import { GetEquipmentTypesQuery } from './queries/get-equipment-types.query';
import { GetEquipmentDeletePreviewQuery } from './queries/get-equipment-delete-preview.query';
import { DepartmentResponse } from '../department/dto/department.response';
import { GetDepartmentQuery } from '../department/queries/get-department.query';
import { Equipment } from './entities/equipment.entity';
import { EquipmentSystem } from './entities/equipment-system.entity';
import { FeederCalibrationResponse, FeederSetupResponse } from './dto/feeder-calibration.response';
import { SaveFeederCalibrationsInput } from './dto/feeder-calibration.input';
import { SaveFeederCalibrationsCommand } from './commands/save-feeder-calibrations.command';
import { ListFeederCalibrationsQuery } from './queries/list-feeder-calibrations.query';

@Resolver(() => EquipmentResponse)
@UseGuards(TenantGuard)
export class EquipmentResolver {
  private readonly logger = new Logger(EquipmentResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    private readonly feedSelectorService: FeedSelectorService,
    private readonly waterTemperatureService: WaterTemperatureService,
  ) {}

  /**
   * Create new equipment
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => EquipmentResponse)
  async createEquipment(
    @Args('input') input: CreateEquipmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<EquipmentResponse> {
    this.logger.log(`Creating equipment: ${input.name} for tenant ${tenantId} by user ${user.sub}`);
    const command = new CreateEquipmentCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update existing equipment
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => EquipmentResponse)
  async updateEquipment(
    @Args('input') input: UpdateEquipmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<EquipmentResponse> {
    this.logger.log(`Updating equipment: ${input.id} for tenant ${tenantId} by user ${user.sub}`);
    const command = new UpdateEquipmentCommand(input.id, input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Get delete preview for an equipment
   * Returns what will be deleted when the equipment is cascade soft deleted
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => EquipmentDeletePreviewResponse)
  async equipmentDeletePreview(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<EquipmentDeletePreviewResponse> {
    this.logger.log(`Getting delete preview for equipment ${id} for tenant ${tenantId}`);
    const query = new GetEquipmentDeletePreviewQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * Delete (soft) equipment
   * @param cascade If true, cascade soft delete all related items (child equipment, sub-equipment)
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteEquipment(
    @Args('id', { type: () => ID }) id: string,
    @Args('cascade', { type: () => Boolean, defaultValue: false }) cascade: boolean,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(
      `Deleting equipment: ${id} for tenant ${tenantId} by user ${user.sub} (cascade: ${cascade})`,
    );
    const command = new DeleteEquipmentCommand(id, tenantId, user.sub, cascade);
    return this.commandBus.execute(command);
  }

  /**
   * Get single equipment by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => EquipmentResponse, { nullable: true })
  async equipment(
    @Args('id', { type: () => ID }) id: string,
    @Args('includeRelations', { type: () => Boolean, nullable: true, defaultValue: false })
    includeRelations: boolean,
    @CurrentTenant() tenantId: string,
  ): Promise<EquipmentResponse | null> {
    const query = new GetEquipmentQuery(id, tenantId, includeRelations);
    return this.queryBus.execute(query);
  }

  /**
   * List equipment with pagination and filtering
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedEquipmentResponse)
  async equipmentList(
    @Args('filter', { type: () => EquipmentFilterInput, nullable: true })
    filter?: EquipmentFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
    @CurrentTenant() tenantId?: string,
  ): Promise<PaginatedEquipmentResponse> {
    if (!tenantId) {
      throw new Error('Tenant ID is required');
    }
    const query = new ListEquipmentQuery(tenantId, filter, pagination);
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<EquipmentResponse>;
    return fromCqrsPaginated(result);
  }

  /**
   * Get equipment by department for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [EquipmentResponse])
  async equipmentByDepartment(
    @Args('departmentId', { type: () => ID }) departmentId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<EquipmentResponse[]> {
    const query = new ListEquipmentQuery(
      tenantId,
      { departmentId, isActive: true },
      { limit: 1000 },
    );
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<EquipmentResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get all equipment types for the CURRENT TENANT.
   * Per-tenant catalog (operator decision): equipment_types is cloned into each
   * tenant schema, so this runs tenant-scoped (search_path → tenant_<uuid>) instead
   * of @SkipTenantGuard reading the shared source copy through a tenant-blind cache
   * that served the first tenant's result to every other tenant. A tenant context is
   * required (the @Roles are all tenant roles).
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [EquipmentTypeResponse])
  async equipmentTypes(
    @Args('filter', { type: () => EquipmentTypeFilterInput, nullable: true })
    filter?: EquipmentTypeFilterInput,
  ): Promise<EquipmentTypeResponse[]> {
    const query = new GetEquipmentTypesQuery(filter);
    return this.queryBus.execute(query) as Promise<EquipmentTypeResponse[]>;
  }

  /**
   * Get equipment type by ID with specification schema (current tenant's catalog).
   * PERF(F3-001): Query directly by ID instead of fetching all types and filtering in JS.
   * Tenant-scoped (per-tenant catalog) — see equipmentTypes above.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => EquipmentTypeResponse, { nullable: true })
  async equipmentType(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<EquipmentTypeResponse | null> {
    const query = new GetEquipmentTypesQuery({ isActive: true, id });
    const types = (await this.queryBus.execute(query)) as EquipmentTypeResponse[];
    return types[0] || null;
  }

  /**
   * Resolve department field
   * Note: For list queries, department is already loaded via JOIN in ListEquipmentHandler.
   * This resolver only makes a separate query if department is not already loaded.
   */
  /**
   * Exact-decimal wire form of `purchasePrice` (ADR-0004 / DATA-MEDIUM-009).
   * The Decimal scalar serialises the number to an exact decimal string.
   */
  @ResolveField(() => DecimalScalar, { nullable: true })
  purchasePriceDecimal(@Parent() equipment: EquipmentResponse): number | null {
    return equipment.purchasePrice ?? null;
  }

  @ResolveField(() => DepartmentResponse, { nullable: true })
  async department(@Parent() equipment: Equipment): Promise<DepartmentResponse | null> {
    // If department is already loaded (e.g., from JOIN in list query), return it directly
    // This avoids a separate query that could fail due to search_path race conditions
    if (equipment.department) {
      // Type assertion: Department entity is compatible with DepartmentResponse for GraphQL serialization
      return equipment.department as DepartmentResponse;
    }

    // Only make a separate query if department wasn't loaded
    if (!equipment.departmentId || !equipment.tenantId) return null;

    try {
      const query = new GetDepartmentQuery(equipment.departmentId, equipment.tenantId);
      return await this.queryBus.execute(query);
    } catch (error: unknown) {
      // A lost/wrong tenant context must surface, not be masked as "no department".
      if (error instanceof TenantContextError) {
        throw error;
      }
      this.logger.debug(
        `Error resolving department: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Resolve systems field - maps equipmentSystems to EquipmentSystemResponse[]
   */
  @ResolveField(() => [EquipmentSystemResponse], { nullable: true })
  systems(@Parent() equipment: Equipment): EquipmentSystemResponse[] | null {
    if (!equipment.equipmentSystems) return null;

    return equipment.equipmentSystems.map((es: EquipmentSystem) => ({
      id: es.id,
      systemId: es.systemId,
      systemName: es.system?.name,
      systemCode: es.system?.code,
      isPrimary: es.isPrimary,
      role: es.role,
      criticalityLevel: es.criticalityLevel,
      notes: es.notes,
    }));
  }

  /**
   * Resolve systemIds field - convenience field for form binding
   */
  @ResolveField(() => [String], { nullable: true })
  systemIds(@Parent() equipment: Equipment): string[] | null {
    if (!equipment.equipmentSystems) return null;
    return equipment.equipmentSystems.map((es: EquipmentSystem) => es.systemId);
  }

  /**
   * Resolve batch metrics from TankBatch entity
   * Works for equipment that can hold fish (tanks, ponds, cages)
   */
  @ResolveField(() => EquipmentBatchMetrics, { nullable: true })
  async batchMetrics(
    @Parent() equipment: Equipment,
    @Context() ctx?: FarmGraphQLContext,
  ): Promise<EquipmentBatchMetrics | null> {
    // Only load for equipment that can hold fish
    if (!equipment.isTank && !equipment.canHoldFish?.()) {
      const category = equipment.equipmentType?.category?.toUpperCase();
      if (!['TANK', 'POND', 'CAGE'].includes(category)) {
        return null;
      }
    }

    const tenantId = equipment.tenantId;
    const schemaName = getTenantSchemaName(tenantId);
    const loaders = ctx?.loaders;

    // ── Step 1: Get TankBatch (DataLoader or fallback) ────────────────
    let tankBatch: any;
    if (loaders?.tankBatchLoader) {
      tankBatch = await loaders.tankBatchLoader.load(equipment.id);
    } else {
      const result = await this.tankBatchRepository.query(
        `SELECT * FROM "${schemaName}".tank_batches WHERE "tenantId" = $1 AND "tankId" = $2 LIMIT 1`,
        [tenantId, equipment.id],
      );
      tankBatch = result?.[0];
    }

    const hasProductionFish = tankBatch?.totalQuantity > 0;
    const hasCleanerFish = tankBatch?.cleanerFishQuantity > 0;
    if (!tankBatch || (!hasProductionFish && !hasCleanerFish)) {
      return null;
    }

    // Calculate days since stocking
    let daysSinceStocking: number | undefined;
    if (tankBatch.createdAt) {
      const now = new Date();
      const stocked = new Date(tankBatch.createdAt);
      daysSinceStocking = Math.floor((now.getTime() - stocked.getTime()) / (1000 * 60 * 60 * 24));
    }

    // ── Step 2: Get Batch + Species metrics (DataLoader or fallback) ──
    let batchMetrics: {
      initialQuantity?: number;
      totalMortality?: number;
      mortalityRate?: number;
      survivalRate?: number;
      totalCull?: number;
      fcr?: number;
      sgr?: number;
      speciesCode?: string;
    } = {};

    if (tankBatch.primaryBatchId) {
      let batch: any;
      if (loaders?.batchSpeciesLoader) {
        batch = await loaders.batchSpeciesLoader.load(tankBatch.primaryBatchId);
      } else {
        const batchResult = await this.tankBatchRepository.query(
          `SELECT
            b."initialQuantity",
            b."totalMortality",
            b."cullCount",
            b."sgr",
            b."fcr",
            s."code" as "speciesCode"
          FROM "${schemaName}".batches_v2 b
          LEFT JOIN "${schemaName}".species s ON b."speciesId" = s."id"
          WHERE b."tenantId" = $1 AND b."id" = $2
          LIMIT 1`,
          [tenantId, tankBatch.primaryBatchId],
        );
        batch = batchResult?.[0];
      }

      if (batch) {
        const initialQty = batch.initialQuantity || 0;
        const totalMort = batch.totalMortality || 0;

        batchMetrics = {
          initialQuantity: initialQty,
          totalMortality: totalMort,
          totalCull: batch.cullCount || 0,
          mortalityRate: initialQty > 0 ? (totalMort / initialQty) * 100 : 0,
          survivalRate: initialQty > 0 ? ((initialQty - totalMort) / initialQty) * 100 : 100,
          fcr: batch.fcr?.actual,
          sgr: batch.sgr ? Number(batch.sgr) : undefined,
          speciesCode: batch.speciesCode || undefined,
        };
      }
    }

    // ── Step 3: Get Feed info (DataLoader or fallback) ────────────────
    let feedInfo: {
      feedCode?: string;
      feedName?: string;
      feedingRatePercent?: number;
      dailyFeedKg?: number;
    } = {};

    // Band/oran çözümü ÜNİTE aggregate'inden — batch ağırlığı geçirmek derleme
    // hatasıdır (BandWeightG); tanks-page ile plan motoru aynı sayıyı okur.
    const avgWeightG = tankBandWeightG(tankBatch);
    const biomassKg = Number(tankBatch.currentBiomassKg ?? tankBatch.totalBiomassKg);

    if (tankBatch.primaryBatchId && avgWeightG > 0 && biomassKg > 0) {
      // Latest water temperature for this tank drives the protocol's temperature
      // multiplier. Absent (null) → no correction (multiplier 1.0).
      const waterTempC = (
        await this.waterTemperatureService.getCurrentTemperature(tenantId, equipment.id)
      )?.celsius;
      try {
        if (loaders?.feedSelectionLoader) {
          // Set context for the feed loader before loading
          loaders.feedSelectionLoader.setContext(
            tankBatch.primaryBatchId,
            avgWeightG,
            biomassKg,
            waterTempC,
            equipment.id,
          );
          const feedResult = await loaders.feedSelectionLoader.load(tankBatch.primaryBatchId);
          if (feedResult) {
            feedInfo = {
              feedCode: feedResult.feedCode,
              feedName: feedResult.feedName,
              feedingRatePercent: feedResult.feedingRatePercent,
              dailyFeedKg: feedResult.dailyFeedKg,
            };
          }
        } else {
          const feedResult = await this.feedSelectorService.selectFeedForBatch(
            tenantId,
            schemaName,
            tankBatch.primaryBatchId,
            // The unit whose protocol assignment governs this tank — the same
            // `equipment.id` handed to the DataLoader path above, so both
            // branches of this if/else resolve the identical protocol.
            equipment.id,
            avgWeightG,
            biomassKg,
            waterTempC,
          );
          if (feedResult) {
            feedInfo = {
              feedCode: feedResult.feedCode,
              feedName: feedResult.feedName,
              feedingRatePercent: feedResult.feedingRatePercent,
              dailyFeedKg: feedResult.dailyFeedKg,
            };
          }
        }
      } catch (error: unknown) {
        // A lost/wrong tenant context must surface, not be masked as default feed info.
        if (error instanceof TenantContextError) {
          throw error;
        }
        this.logger.warn(
          `Error getting feed info for tank ${equipment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    return {
      batchNumber: tankBatch.primaryBatchNumber,
      batchId: tankBatch.primaryBatchId,
      // COUNT SSoT read (DB-FARMPROD-HIGH-001): the fish count is `totalQuantity`
      // (batchDetails-derived); reading the redundant currentQuantity mirror here
      // was a second channel of the 900-vs-719 web/mobile divergence. Biomass
      // (biomassKg above) keeps the currentBiomassKg-first read — growth-tracked.
      pieces: tankBatch.totalQuantity,
      avgWeight: avgWeightG || undefined,
      biomass: biomassKg || undefined,
      density: Number(tankBatch.densityKgM3) || undefined,
      capacityUsedPercent: Number(tankBatch.capacityUsedPercent) || undefined,
      isOverCapacity: tankBatch.isOverCapacity,
      isMixedBatch: tankBatch.isMixedBatch,
      batchDetails: tankBatch.batchDetails || undefined,
      lastFeedingAt: tankBatch.lastFeedingAt,
      lastSamplingAt: tankBatch.lastSamplingAt,
      lastMortalityAt: tankBatch.lastMortalityAt,
      daysSinceStocking,
      ...batchMetrics,
      ...feedInfo,
      cleanerFishQuantity: tankBatch.cleanerFishQuantity || undefined,
      cleanerFishBiomassKg: Number(tankBatch.cleanerFishBiomassKg) || undefined,
      cleanerFishDetails: tankBatch.cleanerFishDetails || undefined,
    };
  }

  // =========================================================================
  // Feeder Calibrations
  // =========================================================================

  /**
   * A feeder's dosing physics and its per-feed calibrations, read together.
   *
   * One query rather than two because neither half is interpretable alone: a
   * flow rate needs the speed band it holds on, and the band lives on the
   * capability row (stated once per machine, never once per feed).
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeederSetupResponse)
  async feederSetup(
    @Args('equipmentId', { type: () => ID }) equipmentId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<FeederSetupResponse> {
    const query = new ListFeederCalibrationsQuery(equipmentId, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * Save (upsert) feeder calibrations for an equipment
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => [FeederCalibrationResponse])
  async saveFeederCalibrations(
    @Args('input') input: SaveFeederCalibrationsInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<FeederCalibrationResponse[]> {
    this.logger.log(`Saving feeder calibrations for equipment ${input.equipmentId}`);
    const command = new SaveFeederCalibrationsCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }
}
