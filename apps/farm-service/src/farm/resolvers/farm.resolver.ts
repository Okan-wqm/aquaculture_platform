import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
  ResolveReference,
} from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@platform/cqrs';
import { Tenant, CurrentUser, Roles, Role } from '@platform/backend-common';
import { Farm } from '../entities/farm.entity';
import { Pond } from '../entities/pond.entity';
import { PondBatch } from '../entities/batch.entity';
import { CreateFarmCommand } from '../commands/create-farm.command';
import { CreatePondCommand } from '../commands/create-pond.command';
import { CreatePondBatchCommand } from '../commands/create-batch.command';
import { HarvestBatchCommand } from '../commands/harvest-batch.command';
import { GetFarmQuery } from '../queries/get-farm.query';
import { ListFarmsQuery } from '../queries/list-farms.query';
import { GetPondQuery } from '../queries/get-pond.query';
import { ListPondBatchesQuery } from '../queries/list-batches.query';
import { CreateFarmInput } from '../dto/create-farm.input';
import { CreatePondInput } from '../dto/create-pond.input';
import { CreatePondBatchInput } from '../dto/create-batch.input';
import { HarvestBatchInput } from '../dto/harvest-batch.input';
import { PaginatedResult } from '../query-handlers/list-farms.handler';
import { BatchStatus } from '../entities/batch.entity';

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

/**
 * Farm Resolver
 * GraphQL resolver for farm-related operations
 * Implements Apollo Federation
 */
@Resolver(() => Farm)
export class FarmResolver {
  private readonly logger = new Logger(FarmResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Federation reference resolver
   *
   * NOTE: Federation __resolveReference calls bypass tenant context.
   * This query is tenant-agnostic by design for federation stitching.
   * Security is enforced at the gateway level where the initial query
   * must pass tenant authorization.
   */
  @ResolveReference()
  async resolveReference(reference: {
    __typename: string;
    id: string;
  }): Promise<Farm | null> {
    try {
      // Federation reference lookups are cross-tenant by design
      // Security check: only return farm if it exists (no tenant filter)
      // The gateway ensures the requesting user has access to related data
      return await this.queryBus.execute(
        new GetFarmQuery(reference.id, undefined, true, false),
      );
    } catch {
      return null;
    }
  }

  /**
   * Get a single farm by ID
   */
  @Query(() => Farm, { name: 'farm', nullable: true })
  async getFarm(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<Farm> {
    this.logger.debug(`Query: getFarm(${id})`);
    return await this.queryBus.execute(
      new GetFarmQuery(id, tenantId, true, false),
    );
  }

  /**
   * List all farms for the tenant
   */
  @Query(() => [Farm], { name: 'farms' })
  async listFarms(
    @Tenant() tenantId: string,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 })
    page: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 10 })
    limit: number,
    @Args('isActive', { type: () => Boolean, nullable: true })
    isActive?: boolean,
    @Args('search', { type: () => String, nullable: true })
    search?: string,
  ): Promise<Farm[]> {
    this.logger.debug(`Query: listFarms(tenant=${tenantId})`);
    const result: PaginatedResult<Farm> = await this.queryBus.execute(
      new ListFarmsQuery(
        tenantId,
        { page, limit },
        { isActive, search },
        true,
      ),
    );
    return result.items;
  }

  /**
   * Get a single pond by ID
   */
  @Query(() => Pond, { name: 'pond', nullable: true })
  async getPond(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<Pond> {
    this.logger.debug(`Query: getPond(${id})`);
    return await this.queryBus.execute(
      new GetPondQuery(id, tenantId, true, true),
    );
  }

  /**
   * List batches with filters
   */
  @Query(() => [PondBatch], { name: 'pondBatches' })
  async listPondBatches(
    @Tenant() tenantId: string,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 })
    page: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 10 })
    limit: number,
    @Args('status', { type: () => BatchStatus, nullable: true })
    status?: BatchStatus,
    @Args('species', { type: () => String, nullable: true })
    species?: string,
    @Args('pondId', { type: () => ID, nullable: true })
    pondId?: string,
  ): Promise<PondBatch[]> {
    this.logger.debug(`Query: listPondBatches(tenant=${tenantId})`);
    const result: PaginatedResult<PondBatch> = await this.queryBus.execute(
      new ListPondBatchesQuery(
        tenantId,
        { page, limit },
        { status, species, pondId },
      ),
    );
    return result.items;
  }

  /**
   * Create a new farm
   */
  @Mutation(() => Farm, { name: 'createFarm' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createFarm(
    @Args('input') input: CreateFarmInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Farm> {
    this.logger.log(`Mutation: createFarm(${input.name})`);
    return await this.commandBus.execute(
      new CreateFarmCommand(
        input.name,
        input.location,
        tenantId,
        user.sub,
        input.address,
        input.contactPerson,
        input.contactPhone,
        input.contactEmail,
        input.description,
        input.totalArea,
      ),
    );
  }

  /**
   * Create a new pond
   */
  @Mutation(() => Pond, { name: 'createPond' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createPond(
    @Args('input') input: CreatePondInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Pond> {
    this.logger.log(`Mutation: createPond(${input.name})`);
    return await this.commandBus.execute(
      new CreatePondCommand(
        input.name,
        input.farmId,
        input.capacity,
        tenantId,
        user.sub,
        input.waterType,
        input.depth,
        input.surfaceArea,
        input.status,
      ),
    );
  }

  /**
   * Create a new pond batch (legacy pond-based aquaculture)
   */
  @Mutation(() => PondBatch, { name: 'createPondBatch' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async createPondBatch(
    @Args('input') input: CreatePondBatchInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<PondBatch> {
    this.logger.log(`Mutation: createPondBatch(${input.name})`);
    return await this.commandBus.execute(
      new CreatePondBatchCommand(
        input.name,
        input.species,
        input.quantity,
        input.pondId,
        tenantId,
        user.sub,
        input.stockedAt,
        input.strain,
        input.averageWeight,
        input.expectedHarvestDate,
        input.notes,
      ),
    );
  }

  /**
   * Harvest a pond batch (legacy pond-based aquaculture)
   */
  @Mutation(() => PondBatch, { name: 'harvestPondBatch' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async harvestPondBatch(
    @Args('input') input: HarvestBatchInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<PondBatch> {
    this.logger.log(`Mutation: harvestPondBatch(${input.batchId})`);
    return await this.commandBus.execute(
      new HarvestBatchCommand(
        input.batchId,
        tenantId,
        user.sub,
        input.harvestedQuantity,
        input.harvestedWeight,
        input.harvestedAt,
        input.notes,
      ),
    );
  }
}
