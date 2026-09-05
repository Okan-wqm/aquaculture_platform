/**
 * Feed GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, Float, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentTenant, CurrentUser, Role, Roles, SkipTenantGuard } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { FeedResponse, PaginatedFeedsResponse, FeedTypeResponse } from './dto/feed.response';
import { CreateFeedInput } from './dto/create-feed.input';
import { UpdateFeedInput } from './dto/update-feed.input';
import { FeedFilterInput } from './dto/feed-filter.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateFeedCommand } from './commands/create-feed.command';
import { UpdateFeedCommand } from './commands/update-feed.command';
import { DeleteFeedCommand } from './commands/delete-feed.command';
import { GetFeedQuery } from './queries/get-feed.query';
import { ListFeedsQuery } from './queries/list-feeds.query';
import { Feed, FeedType } from './entities/feed.entity';
import { FeedTypeEntity } from './entities/feed-type.entity';
import { RestoreService } from '../common/services/restore.service';

@Resolver(() => FeedResponse)
@UseGuards(TenantGuard)
export class FeedResolver {
  private readonly logger = new Logger(FeedResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(FeedTypeEntity)
    private readonly feedTypeRepository: Repository<FeedTypeEntity>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    private readonly restoreService: RestoreService,
  ) {}

  /** Exact-decimal wire form of `pricePerKg` (ADR-0004 / DATA-MEDIUM-009). */
  @ResolveField(() => DecimalScalar, { nullable: true })
  pricePerKgDecimal(@Parent() feed: FeedResponse): number | null {
    return feed.pricePerKg ?? null;
  }

  /** Exact-decimal wire form of `unitPrice` (ADR-0004 / DATA-MEDIUM-009). */
  @ResolveField(() => DecimalScalar, { nullable: true })
  unitPriceDecimal(@Parent() feed: FeedResponse): number | null {
    return feed.unitPrice ?? null;
  }

  /**
   * Create a new feed
   */
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => FeedResponse)
  async createFeed(
    @Args('input') input: CreateFeedInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<FeedResponse> {
    this.logger.log(`Creating feed "${input.name}" for tenant ${tenantId}`);
    const command = new CreateFeedCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update an existing feed
   */
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => FeedResponse)
  async updateFeed(
    @Args('input') input: UpdateFeedInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<FeedResponse> {
    this.logger.log(`Updating feed ${input.id} for tenant ${tenantId}`);
    const command = new UpdateFeedCommand(input.id, input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Delete (soft) a feed
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteFeed(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting feed ${id} for tenant ${tenantId}`);
    const command = new DeleteFeedCommand(id, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Restore a soft-deleted feed. TENANT_ADMIN only — restoring
   * previously-purged inventory items is an admin-level operation
   * because it re-activates SKU codes, supplier links, and any
   * associated batch feed assignments' references. Phase 4.2 of the
   * "Farm modülü kalan kör noktalar" plan. Closes Girdi 6.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => FeedResponse)
  async restoreFeed(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; name?: string },
  ): Promise<Feed> {
    this.logger.log(`Restoring feed ${id} for tenant ${tenantId}`);
    return this.restoreService.restore(
      this.feedRepository,
      Feed,
      id,
      { tenantId, userId: user.sub, userName: user.name },
      {
        // Feed is unique per (tenantId, code) at the schema level.
        // Restoring a row whose code has been reclaimed by an active
        // row would break the unique index — the service flags it
        // with a ConflictException instead.
        uniqueKeys: [['code']],
      },
    );
  }

  /**
   * Get a single feed by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeedResponse, { nullable: true })
  async feed(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<FeedResponse | null> {
    const query = new GetFeedQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * List feeds with pagination and filtering
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedFeedsResponse)
  async feeds(
    @Args('filter', { type: () => FeedFilterInput, nullable: true }) filter: FeedFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedFeedsResponse> {
    const query = new ListFeedsQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<FeedResponse>;
    return fromCqrsPaginated(result);
  }

  /**
   * Get feeds by type for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [FeedResponse])
  async feedsByType(
    @Args('type', { type: () => FeedType }) type: FeedType,
    @CurrentTenant() tenantId: string,
  ): Promise<readonly FeedResponse[]> {
    const query = new ListFeedsQuery(tenantId, { type, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<FeedResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get feeds by pellet size for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [FeedResponse])
  async feedsByPelletSize(
    @Args('pelletSize', { type: () => Float }) pelletSize: number,
    @CurrentTenant() tenantId: string,
  ): Promise<readonly FeedResponse[]> {
    const query = new ListFeedsQuery(tenantId, { pelletSize, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<FeedResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get feeds for specific species (legacy convenience)
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [FeedResponse])
  async feedsForSpecies(
    @Args('species') species: string,
    @CurrentTenant() tenantId: string,
  ): Promise<readonly FeedResponse[]> {
    const query = new ListFeedsQuery(
      tenantId,
      { targetSpecies: species, isActive: true },
      { limit: 1000 },
    );
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<FeedResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get all feed types (global, not tenant-specific)
   */
  @SkipTenantGuard()
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [FeedTypeResponse])
  async feedTypes(): Promise<FeedTypeResponse[]> {
    return this.feedTypeRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }
}
