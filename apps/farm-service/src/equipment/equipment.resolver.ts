/**
 * Equipment GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantGuard, CurrentTenant, CurrentUser, SkipTenantGuard } from '@platform/backend-common';
import { EquipmentResponse, PaginatedEquipmentResponse, EquipmentTypeResponse, EquipmentSystemResponse, EquipmentBatchMetrics } from './dto/equipment.response';
import { TankBatch } from '../batch/entities/tank-batch.entity';
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

@Resolver(() => EquipmentResponse)
@UseGuards(TenantGuard)
export class EquipmentResolver {
  private readonly logger = new Logger(EquipmentResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
  ) {}

  /**
   * Create new equipment
   */
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
  @Mutation(() => Boolean)
  async deleteEquipment(
    @Args('id', { type: () => ID }) id: string,
    @Args('cascade', { type: () => Boolean, defaultValue: false }) cascade: boolean,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting equipment: ${id} for tenant ${tenantId} by user ${user.sub} (cascade: ${cascade})`);
    const command = new DeleteEquipmentCommand(id, tenantId, user.sub, cascade);
    return this.commandBus.execute(command);
  }

  /**
   * Get single equipment by ID
   */
  @Query(() => EquipmentResponse, { nullable: true })
  async equipment(
    @Args('id', { type: () => ID }) id: string,
    @Args('includeRelations', { type: () => Boolean, nullable: true, defaultValue: false }) includeRelations: boolean,
    @CurrentTenant() tenantId: string,
  ): Promise<EquipmentResponse | null> {
    const query = new GetEquipmentQuery(id, tenantId, includeRelations);
    return this.queryBus.execute(query);
  }

  /**
   * List equipment with pagination and filtering
   */
  @Query(() => PaginatedEquipmentResponse)
  async equipmentList(
    @Args('filter', { type: () => EquipmentFilterInput, nullable: true }) filter?: EquipmentFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination?: PaginationInput,
    @CurrentTenant() tenantId?: string,
  ): Promise<PaginatedEquipmentResponse> {
    if (!tenantId) {
      throw new Error('Tenant ID is required');
    }
    const query = new ListEquipmentQuery(tenantId, filter, pagination);
    return this.queryBus.execute(query);
  }

  /**
   * Get equipment by department for dropdowns
   */
  @Query(() => [EquipmentResponse])
  async equipmentByDepartment(
    @Args('departmentId', { type: () => ID }) departmentId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<EquipmentResponse[]> {
    const query = new ListEquipmentQuery(tenantId, { departmentId, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get all equipment types (global, not tenant-specific)
   */
  @SkipTenantGuard()
  @Query(() => [EquipmentTypeResponse])
  async equipmentTypes(
    @Args('filter', { type: () => EquipmentTypeFilterInput, nullable: true }) filter?: EquipmentTypeFilterInput,
  ): Promise<EquipmentTypeResponse[]> {
    const query = new GetEquipmentTypesQuery(filter);
    return this.queryBus.execute(query);
  }

  /**
   * Get equipment type by ID with specification schema
   */
  @SkipTenantGuard()
  @Query(() => EquipmentTypeResponse, { nullable: true })
  async equipmentType(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<EquipmentTypeResponse | null> {
    const query = new GetEquipmentTypesQuery({ isActive: true });
    const types = await this.queryBus.execute(query);
    return types.find((t: EquipmentTypeResponse) => t.id === id) || null;
  }

  /**
   * Resolve department field
   * Note: For list queries, department is already loaded via JOIN in ListEquipmentHandler.
   * This resolver only makes a separate query if department is not already loaded.
   */
  @ResolveField(() => DepartmentResponse, { nullable: true })
  async department(@Parent() equipment: any): Promise<DepartmentResponse | null> {
    // If department is already loaded (e.g., from JOIN in list query), return it directly
    // This avoids a separate query that could fail due to search_path race conditions
    if (equipment.department) {
      return equipment.department;
    }

    // Only make a separate query if department wasn't loaded
    if (!equipment.departmentId || !equipment.tenantId) return null;

    try {
      const query = new GetDepartmentQuery(equipment.departmentId, equipment.tenantId);
      return this.queryBus.execute(query);
    } catch {
      return null;
    }
  }

  /**
   * Resolve systems field - maps equipmentSystems to EquipmentSystemResponse[]
   */
  @ResolveField(() => [EquipmentSystemResponse], { nullable: true })
  systems(@Parent() equipment: any): EquipmentSystemResponse[] | null {
    if (!equipment.equipmentSystems) return null;

    return equipment.equipmentSystems.map((es: any) => ({
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
  systemIds(@Parent() equipment: any): string[] | null {
    if (!equipment.equipmentSystems) return null;
    return equipment.equipmentSystems.map((es: any) => es.systemId);
  }

  /**
   * Resolve batch metrics from TankBatch entity
   * Works for equipment that can hold fish (tanks, ponds, cages)
   */
  @ResolveField(() => EquipmentBatchMetrics, { nullable: true })
  async batchMetrics(@Parent() equipment: any): Promise<EquipmentBatchMetrics | null> {
    // Only load for equipment that can hold fish
    if (!equipment.isTank && !equipment.canHoldFish?.()) {
      // Also check equipmentType category (handle both uppercase and lowercase)
      const category = equipment.equipmentType?.category?.toUpperCase();
      if (!['TANK', 'POND', 'CAGE'].includes(category)) {
        return null;
      }
    }

    // Use raw query with explicit tenant schema to avoid search_path issues
    const tenantId = equipment.tenantId;
    const schemaName = `tenant_${tenantId.substring(0, 8)}`;

    const result = await this.tankBatchRepository.query(
      `SELECT * FROM "${schemaName}".tank_batches WHERE "tenantId" = $1 AND "tankId" = $2 LIMIT 1`,
      [tenantId, equipment.id]
    );

    const tankBatch = result?.[0];
    // Return null only if no tank batch exists OR if both production and cleaner fish are empty
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

    // Fetch batch entity to get mortality/performance metrics
    let batchMetrics: {
      initialQuantity?: number;
      totalMortality?: number;
      mortalityRate?: number;
      survivalRate?: number;
      totalCull?: number;
      fcr?: number;
      sgr?: number;
    } = {};

    if (tankBatch.primaryBatchId) {
      const batchResult = await this.tankBatchRepository.query(
        `SELECT
          "initialQuantity",
          "totalMortality",
          "cullCount",
          "sgr",
          "fcr"
        FROM "${schemaName}".batches_v2
        WHERE "tenantId" = $1 AND "id" = $2
        LIMIT 1`,
        [tenantId, tankBatch.primaryBatchId]
      );

      const batch = batchResult?.[0];
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
        };
      }
    }

    return {
      batchNumber: tankBatch.primaryBatchNumber,
      batchId: tankBatch.primaryBatchId,
      pieces: tankBatch.currentQuantity ?? tankBatch.totalQuantity,
      avgWeight: Number(tankBatch.avgWeightG) || undefined,
      biomass: Number(tankBatch.currentBiomassKg ?? tankBatch.totalBiomassKg) || undefined,
      density: Number(tankBatch.densityKgM3) || undefined,
      capacityUsedPercent: Number(tankBatch.capacityUsedPercent) || undefined,
      isOverCapacity: tankBatch.isOverCapacity,
      isMixedBatch: tankBatch.isMixedBatch,
      lastFeedingAt: tankBatch.lastFeedingAt,
      lastSamplingAt: tankBatch.lastSamplingAt,
      lastMortalityAt: tankBatch.lastMortalityAt,
      daysSinceStocking,
      // Mortality & Performance metrics from Batch
      ...batchMetrics,
      // Cleaner Fish metrics
      cleanerFishQuantity: tankBatch.cleanerFishQuantity || undefined,
      cleanerFishBiomassKg: Number(tankBatch.cleanerFishBiomassKg) || undefined,
      cleanerFishDetails: tankBatch.cleanerFishDetails || undefined,
    };
  }
}
