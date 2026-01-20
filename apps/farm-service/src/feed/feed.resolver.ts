/**
 * Feed GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, Float } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantGuard, CurrentTenant, CurrentUser, SkipTenantGuard } from '@platform/backend-common';
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
import { FeedType } from './entities/feed.entity';
import { FeedTypeEntity } from './entities/feed-type.entity';

@Resolver(() => FeedResponse)
@UseGuards(TenantGuard)
export class FeedResolver {
  private readonly logger = new Logger(FeedResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(FeedTypeEntity)
    private readonly feedTypeRepository: Repository<FeedTypeEntity>,
  ) {}

  /**
   * Create a new feed
   */
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
   * Get a single feed by ID
   */
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
  @Query(() => PaginatedFeedsResponse)
  async feeds(
    @Args('filter', { type: () => FeedFilterInput, nullable: true }) filter: FeedFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedFeedsResponse> {
    const query = new ListFeedsQuery(tenantId, filter, pagination);
    return this.queryBus.execute(query);
  }

  /**
   * Get feeds by type for dropdowns
   */
  @Query(() => [FeedResponse])
  async feedsByType(
    @Args('type', { type: () => FeedType }) type: FeedType,
    @CurrentTenant() tenantId: string,
  ): Promise<FeedResponse[]> {
    const query = new ListFeedsQuery(tenantId, { type, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get feeds by pellet size for dropdowns
   */
  @Query(() => [FeedResponse])
  async feedsByPelletSize(
    @Args('pelletSize', { type: () => Float }) pelletSize: number,
    @CurrentTenant() tenantId: string,
  ): Promise<FeedResponse[]> {
    const query = new ListFeedsQuery(tenantId, { pelletSize, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get feeds for specific species (legacy convenience)
   */
  @Query(() => [FeedResponse])
  async feedsForSpecies(
    @Args('species') species: string,
    @CurrentTenant() tenantId: string,
  ): Promise<FeedResponse[]> {
    const query = new ListFeedsQuery(tenantId, { targetSpecies: species, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get all feed types (global, not tenant-specific)
   */
  @SkipTenantGuard()
  @Query(() => [FeedTypeResponse])
  async feedTypes(): Promise<FeedTypeResponse[]> {
    return this.feedTypeRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }
}
