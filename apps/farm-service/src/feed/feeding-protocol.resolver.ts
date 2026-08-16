/**
 * Feeding Protocol GraphQL Resolver
 *
 * Manages feeding protocols for species and growth stages.
 * Provides customizable feeding schedules based on temperature and weight.
 *
 * @module Feed/Resolvers
 */
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import {
  FeedingProtocolResponse,
  PaginatedFeedingProtocolsResponse,
} from './dto/feeding-protocol.response';
import { CreateFeedingProtocolInput } from './dto/create-feeding-protocol.input';
import { UpdateFeedingProtocolInput } from './dto/update-feeding-protocol.input';
import { FeedingProtocolFilterInput } from './dto/feeding-protocol-filter.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateFeedingProtocolCommand } from './commands/create-feeding-protocol.command';
import { UpdateFeedingProtocolCommand } from './commands/update-feeding-protocol.command';
import { DeleteFeedingProtocolCommand } from './commands/delete-feeding-protocol.command';
import { GetFeedingProtocolQuery } from './queries/get-feeding-protocol.query';
import { ListFeedingProtocolsQuery } from './queries/list-feeding-protocols.query';
import { FeedingProtocol } from './entities/feeding-protocol.entity';
import { FeedType } from './entities/feed.entity';
import { FeedResponse } from './dto/feed.response';

@Resolver(() => FeedingProtocolResponse)
@UseGuards(TenantGuard)
export class FeedingProtocolResolver {
  private readonly logger = new Logger(FeedingProtocolResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * Get a single feeding protocol by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeedingProtocolResponse, { nullable: true, description: 'Get a feeding protocol by ID' })
  async feedingProtocol(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<FeedingProtocolResponse | null> {
    this.logger.debug(`Getting feeding protocol ${id} for tenant ${tenantId}`);
    const query = new GetFeedingProtocolQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * List feeding protocols with pagination and filtering
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedFeedingProtocolsResponse, { description: 'List feeding protocols with filters' })
  async feedingProtocols(
    @Args('filter', { type: () => FeedingProtocolFilterInput, nullable: true }) filter: FeedingProtocolFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedFeedingProtocolsResponse> {
    this.logger.debug(`Listing feeding protocols for tenant ${tenantId}`);
    const query = new ListFeedingProtocolsQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<FeedingProtocolResponse>;
    return fromCqrsPaginated(result);
  }

  /**
   * Get feeding protocols by species
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [FeedingProtocolResponse], { description: 'Get feeding protocols for a species' })
  async feedingProtocolsBySpecies(
    @Args('species') species: string,
    @CurrentTenant() tenantId: string,
  ): Promise<readonly FeedingProtocolResponse[]> {
    this.logger.debug(`Getting feeding protocols for species "${species}" for tenant ${tenantId}`);
    const query = new ListFeedingProtocolsQuery(
      tenantId,
      { species, isActive: true },
      { limit: 100 },
    );
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<FeedingProtocolResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get the default feeding protocol for a species and stage
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeedingProtocolResponse, { nullable: true, description: 'Get default protocol for species/stage' })
  async defaultFeedingProtocol(
    @Args('species') species: string,
    @Args('stage', { type: () => String, nullable: true }) stage: string | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<FeedingProtocolResponse | null> {
    this.logger.debug(`Getting default feeding protocol for species "${species}" for tenant ${tenantId}`);
    const query = new ListFeedingProtocolsQuery(
      tenantId,
      { species, stage: stage as FeedType | undefined, isDefault: true, isActive: true },
      { limit: 1 },
    );
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<FeedingProtocolResponse>;
    return fromCqrsPaginated(result).items[0] || null;
  }

  // ==========================================================================
  // MUTATIONS
  // ==========================================================================

  /**
   * Create a new feeding protocol
   */
  @Mutation(() => FeedingProtocolResponse, { description: 'Create a new feeding protocol' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createFeedingProtocol(
    @Args('input') input: CreateFeedingProtocolInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<FeedingProtocolResponse> {
    this.logger.log(`Creating feeding protocol "${input.name}" for tenant ${tenantId}`);
    const command = new CreateFeedingProtocolCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update an existing feeding protocol
   */
  @Mutation(() => FeedingProtocolResponse, { description: 'Update a feeding protocol' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateFeedingProtocol(
    @Args('input') input: UpdateFeedingProtocolInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<FeedingProtocolResponse> {
    this.logger.log(`Updating feeding protocol ${input.id} for tenant ${tenantId}`);
    const command = new UpdateFeedingProtocolCommand(input.id, input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Delete (deactivate) a feeding protocol
   */
  @Mutation(() => Boolean, { description: 'Delete a feeding protocol' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deleteFeedingProtocol(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting feeding protocol ${id} for tenant ${tenantId}`);
    const command = new DeleteFeedingProtocolCommand(id, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Set a protocol as the default for its species/stage
   */
  @Mutation(() => FeedingProtocolResponse, { description: 'Set a protocol as default for species/stage' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async setDefaultFeedingProtocol(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<FeedingProtocolResponse> {
    this.logger.log(`Setting feeding protocol ${id} as default for tenant ${tenantId}`);
    const command = new UpdateFeedingProtocolCommand(
      id,
      { id, isDefault: true },
      tenantId,
      user.sub,
    );
    return this.commandBus.execute(command);
  }

  // ==========================================================================
  // FIELD RESOLVERS
  // ==========================================================================

  /**
   * Resolve the associated feed
   */
  @ResolveField(() => FeedResponse, { nullable: true, description: 'The associated feed' })
  async feed(@Parent() protocol: FeedingProtocol): Promise<FeedResponse | null> {
    // If the relation was already loaded, return it
    if (protocol.feed) {
      return protocol.feed as FeedResponse;
    }
    // Otherwise return null - caller should use dataloader or explicit query
    return null;
  }
}
