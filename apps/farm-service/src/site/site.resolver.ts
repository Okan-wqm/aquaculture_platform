/**
 * Site GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { UseGuards, Logger } from '@nestjs/common';
import { TenantGuard, CurrentTenant, CurrentUser } from '@platform/backend-common';
import { SiteResponse, PaginatedSitesResponse } from './dto/site.response';
import { SiteDeletePreviewResponse } from './dto/site-delete-preview.response';
import { CreateSiteInput } from './dto/create-site.input';
import { UpdateSiteInput } from './dto/update-site.input';
import { SiteFilterInput, PaginationInput } from './dto/site-filter.input';
import { CreateSiteCommand } from './commands/create-site.command';
import { UpdateSiteCommand } from './commands/update-site.command';
import { DeleteSiteCommand } from './commands/delete-site.command';
import { GetSiteQuery } from './queries/get-site.query';
import { ListSitesQuery } from './queries/list-sites.query';
import { GetSiteDeletePreviewQuery } from './queries/get-site-delete-preview.query';

@Resolver(() => SiteResponse)
@UseGuards(TenantGuard)
export class SiteResolver {
  private readonly logger = new Logger(SiteResolver.name);
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Create a new site
   */
  @Mutation(() => SiteResponse)
  async createSite(
    @Args('input') input: CreateSiteInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SiteResponse> {
    this.logger.log(`Creating site for tenant ${tenantId} by user ${user.sub}`);
    const command = new CreateSiteCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update an existing site
   */
  @Mutation(() => SiteResponse)
  async updateSite(
    @Args('input') input: UpdateSiteInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SiteResponse> {
    this.logger.log(`Updating site ${input.id} for tenant ${tenantId} by user ${user.sub}`);
    const command = new UpdateSiteCommand(input.id, input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Get delete preview for a site
   * Returns what will be deleted when the site is cascade soft deleted
   */
  @Query(() => SiteDeletePreviewResponse)
  async siteDeletePreview(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SiteDeletePreviewResponse> {
    this.logger.log(`Getting delete preview for site ${id} for tenant ${tenantId}`);
    const query = new GetSiteDeletePreviewQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * Delete (soft) a site
   * @param cascade If true, cascade soft delete all related items (departments, systems, equipment, tanks)
   */
  @Mutation(() => Boolean)
  async deleteSite(
    @Args('id', { type: () => ID }) id: string,
    @Args('cascade', { type: () => Boolean, defaultValue: false }) cascade: boolean,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting site ${id} for tenant ${tenantId} by user ${user.sub} (cascade: ${cascade})`);
    const command = new DeleteSiteCommand(id, tenantId, user.sub, cascade);
    return this.commandBus.execute(command);
  }

  /**
   * Get a single site by ID
   */
  @Query(() => SiteResponse, { nullable: true })
  async site(
    @Args('id', { type: () => ID }) id: string,
    @Args('includeRelations', { type: () => Boolean, nullable: true, defaultValue: false }) includeRelations: boolean,
    @CurrentTenant() tenantId: string,
  ): Promise<SiteResponse | null> {
    const query = new GetSiteQuery(id, tenantId, includeRelations);
    return this.queryBus.execute(query);
  }

  /**
   * List sites with pagination and filtering
   */
  @Query(() => PaginatedSitesResponse)
  async sites(
    @Args('filter', { type: () => SiteFilterInput, nullable: true }) filter?: SiteFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination?: PaginationInput,
    @CurrentTenant() tenantId?: string,
  ): Promise<PaginatedSitesResponse> {
    if (!tenantId) {
      throw new Error('Tenant ID is required');
    }
    const query = new ListSitesQuery(tenantId, filter, pagination);
    return this.queryBus.execute(query);
  }

  /**
   * Get active sites for dropdowns
   */
  @Query(() => [SiteResponse])
  async activeSites(
    @CurrentTenant() tenantId: string,
  ): Promise<SiteResponse[]> {
    const query = new ListSitesQuery(tenantId, { isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }
}
