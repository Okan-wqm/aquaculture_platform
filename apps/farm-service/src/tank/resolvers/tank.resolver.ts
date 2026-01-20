/**
 * Tank GraphQL Resolver
 * @module Tank/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  ObjectType,
  Field,
  Int,
  Float,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandBus, QueryBus } from '@platform/cqrs';
import { TenantGuard, CurrentTenant, CurrentUser } from '@platform/backend-common';
import { Tank } from '../entities/tank.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Department } from '../../department/entities/department.entity';
import { CreateTankInput } from '../dto/create-tank.dto';
import { UpdateTankInput } from '../dto/update-tank.dto';
import { TankFilterInput } from '../dto/tank-filter.dto';
import { UpdateTankStatusInput } from '../dto/update-tank-status.dto';
import { CreateTankCommand } from '../commands/create-tank.command';
import { UpdateTankCommand } from '../commands/update-tank.command';
import { UpdateTankStatusCommand } from '../commands/update-tank-status.command';
import { DeleteTankCommand } from '../commands/delete-tank.command';
import { GetTankQuery } from '../queries/get-tank.query';
import { ListTanksQuery } from '../queries/list-tanks.query';
import { TankListResult } from '../handlers/list-tanks.handler';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class TankListResponse {
  @Field(() => [Tank])
  items: Tank[];

  @Field(() => Int)
  total: number;

  @Field(() => Int)
  offset: number;

  @Field(() => Int)
  limit: number;

  @Field()
  hasMore: boolean;
}

@ObjectType()
export class DeleteTankResponse {
  @Field()
  success: boolean;

  @Field()
  id: string;

  @Field({ nullable: true })
  message?: string;
}

@ObjectType()
export class TankCapacityInfo {
  @Field(() => Float)
  currentBiomass: number;

  @Field(() => Float)
  maxBiomass: number;

  @Field(() => Float)
  availableCapacity: number;

  @Field(() => Float)
  utilizationPercent: number;

  @Field(() => Float)
  currentDensity: number;

  @Field(() => Float)
  maxDensity: number;

  @Field()
  hasCapacity: boolean;
}

/**
 * Site info for tank's department
 */
@ObjectType()
export class TankSiteInfo {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;
}

/**
 * Department info for tank display
 */
@ObjectType()
export class TankDepartmentInfo {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field({ nullable: true })
  siteId?: string;

  @Field(() => TankSiteInfo, { nullable: true })
  site?: TankSiteInfo;
}

/**
 * Batch metrics info for tank display
 */
@ObjectType()
export class TankBatchMetrics {
  @Field({ nullable: true })
  batchNumber?: string;

  @Field({ nullable: true })
  batchId?: string;

  @Field(() => Int, { nullable: true })
  pieces?: number;

  @Field(() => Float, { nullable: true })
  avgWeight?: number;

  @Field(() => Float, { nullable: true })
  biomass?: number;

  @Field(() => Float, { nullable: true })
  density?: number;

  @Field(() => Float, { nullable: true })
  capacityUsedPercent?: number;

  @Field({ nullable: true })
  isOverCapacity?: boolean;

  @Field({ nullable: true })
  isMixedBatch?: boolean;

  @Field({ nullable: true })
  lastFeedingAt?: Date;

  @Field({ nullable: true })
  lastSamplingAt?: Date;

  @Field({ nullable: true })
  lastMortalityAt?: Date;

  @Field(() => Int, { nullable: true })
  daysSinceStocking?: number;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => Tank)
@UseGuards(TenantGuard)
export class TankResolver {
  private readonly logger = new Logger(TankResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  /**
   * Get a single tank by ID
   */
  @Query(() => Tank, { name: 'tank' })
  async getTank(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<Tank> {
    this.logger.debug(`Getting tank: ${id}`);
    return this.queryBus.execute(new GetTankQuery(tenantId, id));
  }

  /**
   * List tanks with filtering and pagination
   */
  @Query(() => TankListResponse, { name: 'tanks' })
  async listTanks(
    @CurrentTenant() tenantId: string,
    @Args('filter', { type: () => TankFilterInput, nullable: true })
    filter?: TankFilterInput,
  ): Promise<TankListResult> {
    this.logger.debug(`Listing tanks for tenant: ${tenantId}`);
    return this.queryBus.execute(new ListTanksQuery(tenantId, filter));
  }

  /**
   * Get tanks by department
   */
  @Query(() => [Tank], { name: 'tanksByDepartment' })
  async getTanksByDepartment(
    @Args('departmentId', { type: () => ID }) departmentId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<Tank[]> {
    const result: TankListResult = await this.queryBus.execute(
      new ListTanksQuery(tenantId, { departmentId, isActive: true, limit: 100 }),
    );
    return result.items;
  }

  /**
   * Get tanks with available capacity
   */
  @Query(() => [Tank], { name: 'availableTanks' })
  async getAvailableTanks(
    @CurrentTenant() tenantId: string,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ): Promise<Tank[]> {
    const result: TankListResult = await this.queryBus.execute(
      new ListTanksQuery(tenantId, {
        departmentId,
        hasAvailableCapacity: true,
        isActive: true,
        limit: 100,
      }),
    );
    return result.items;
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  /**
   * Create a new tank
   */
  @Mutation(() => Tank)
  async createTank(
    @Args('input') input: CreateTankInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<Tank> {
    this.logger.log(`Creating tank: ${input.name}`);
    return this.commandBus.execute(
      new CreateTankCommand(tenantId, userId, input),
    );
  }

  /**
   * Update an existing tank
   */
  @Mutation(() => Tank)
  async updateTank(
    @Args('input') input: UpdateTankInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<Tank> {
    this.logger.log(`Updating tank: ${input.id}`);
    return this.commandBus.execute(
      new UpdateTankCommand(tenantId, userId, input),
    );
  }

  /**
   * Update tank status
   */
  @Mutation(() => Tank)
  async updateTankStatus(
    @Args('input') input: UpdateTankStatusInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<Tank> {
    this.logger.log(`Updating tank status: ${input.id} to ${input.status}`);
    return this.commandBus.execute(
      new UpdateTankStatusCommand(tenantId, userId, input),
    );
  }

  /**
   * Delete a tank (soft delete)
   */
  @Mutation(() => DeleteTankResponse)
  async deleteTank(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<DeleteTankResponse> {
    this.logger.log(`Deleting tank: ${id}`);
    const success: boolean = await this.commandBus.execute(
      new DeleteTankCommand(tenantId, userId, id),
    );
    return {
      success,
      id,
      message: success ? 'Tank deleted successfully' : 'Failed to delete tank',
    };
  }

  // -------------------------------------------------------------------------
  // FIELD RESOLVERS
  // -------------------------------------------------------------------------

  /**
   * Resolve computed capacity info
   */
  @ResolveField(() => TankCapacityInfo, { name: 'capacityInfo' })
  getCapacityInfo(@Parent() tank: Tank): TankCapacityInfo {
    const currentDensity = tank.getCurrentDensity();
    const utilizationPercent = tank.getUtilizationPercent();
    const availableCapacity = tank.getAvailableCapacity();

    return {
      currentBiomass: Number(tank.currentBiomass) || 0,
      maxBiomass: Number(tank.maxBiomass) || 0,
      availableCapacity,
      utilizationPercent,
      currentDensity,
      maxDensity: Number(tank.maxDensity) || 0,
      hasCapacity: availableCapacity > 0,
    };
  }

  /**
   * Resolve water volume (if different from total volume)
   */
  @ResolveField(() => Float, { name: 'effectiveVolume' })
  getEffectiveVolume(@Parent() tank: Tank): number {
    return Number(tank.waterVolume) || Number(tank.volume) || 0;
  }

  /**
   * Resolve batch metrics from TankBatch entity
   */
  @ResolveField(() => TankBatchMetrics, { name: 'batchMetrics', nullable: true })
  async getBatchMetrics(@Parent() tank: Tank): Promise<TankBatchMetrics | null> {
    const tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId: tank.tenantId, tankId: tank.id },
    });

    if (!tankBatch || tankBatch.totalQuantity === 0) {
      return null;
    }

    // Calculate days since stocking
    let daysSinceStocking: number | undefined;
    if (tankBatch.createdAt) {
      const now = new Date();
      const stocked = new Date(tankBatch.createdAt);
      daysSinceStocking = Math.floor((now.getTime() - stocked.getTime()) / (1000 * 60 * 60 * 24));
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
    };
  }

  /**
   * Resolve department with site info
   */
  @ResolveField(() => TankDepartmentInfo, { name: 'department', nullable: true })
  async getDepartment(@Parent() tank: Tank): Promise<TankDepartmentInfo | null> {
    if (!tank.departmentId) {
      return null;
    }

    const department = await this.departmentRepository.findOne({
      where: { id: tank.departmentId },
      relations: ['site'],
    });

    if (!department) {
      return null;
    }

    return {
      id: department.id,
      name: department.name,
      siteId: department.siteId,
      site: department.site
        ? { id: department.site.id, name: department.site.name }
        : undefined,
    };
  }
}
