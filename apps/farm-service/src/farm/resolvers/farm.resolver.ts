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
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { Tenant, CurrentUser, Roles, Role, fromCqrsPaginated } from '@aquaculture/backend-common';
import { Farm } from '../entities/farm.entity';
import { Pond } from '../entities/pond.entity';
import { CreateFarmCommand } from '../commands/create-farm.command';
import { CreatePondCommand } from '../commands/create-pond.command';
import { GetFarmQuery } from '../queries/get-farm.query';
import { ListFarmsQuery } from '../queries/list-farms.query';
import { GetPondQuery } from '../queries/get-pond.query';
import { CreateFarmInput } from '../dto/create-farm.input';
import { CreatePondInput } from '../dto/create-pond.input';

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
@UseGuards(GqlAuthGuard)
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
    tenantId?: string;
  }): Promise<Farm | null> {
    if (!reference.tenantId) {
      this.logger.warn(`resolveReference called without tenantId for farm ${reference.id} — rejecting for tenant isolation`);
      return null;
    }
    try {
      return await this.queryBus.execute(
        new GetFarmQuery(reference.id, reference.tenantId, true, false),
      );
    } catch (error: unknown) {
      this.logger.debug(`Error in resolveReference: ${error instanceof Error ? error.message : String(error)}`);
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
    const result: PaginatedQueryResult<Farm> = await this.queryBus.execute(
      new ListFarmsQuery(
        tenantId,
        { page, limit },
        { isActive, search },
        true,
      ),
    );
    return fromCqrsPaginated(result).items;
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

}
