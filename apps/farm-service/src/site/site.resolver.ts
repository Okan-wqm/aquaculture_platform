/**
 * Site GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { UseGuards, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';
import { SiteResponse, PaginatedSitesResponse } from './dto/site.response';
import { SiteAccessCatalogItemResponse } from './dto/site-access-catalog.response';
import { SiteDeletePreviewResponse } from './dto/site-delete-preview.response';
import { SiteContactResponse } from './dto/site-contact.response';
import { CreateSiteInput } from './dto/create-site.input';
import { UpdateSiteInput } from './dto/update-site.input';
import { SiteContactInput } from './dto/site-contact.input';
import { SiteFilterInput, PaginationInput } from './dto/site-filter.input';
import { CreateSiteCommand } from './commands/create-site.command';
import { UpdateSiteCommand } from './commands/update-site.command';
import { DeleteSiteCommand } from './commands/delete-site.command';
import { UpsertSiteContactsCommand } from './commands/upsert-site-contacts.command';
import { GetSiteQuery } from './queries/get-site.query';
import { GetActiveSiteAccessCatalogQuery } from './queries/get-active-site-access-catalog.query';
import { ListSitesQuery } from './queries/list-sites.query';
import {
  ACTIVE_SITE_COLLECTION_HARD_CAP,
  ActiveSiteCollectionLimitExceededError,
} from './handlers/get-active-site-access-catalog.handler';
import { GetSiteDeletePreviewQuery } from './queries/get-site-delete-preview.query';
import { ListSiteContactsQuery } from './queries/list-site-contacts.query';
import { Site } from './entities/site.entity';
import { RestoreService } from '../common/services/restore.service';

@Resolver(() => SiteResponse)
@UseGuards(TenantGuard)
export class SiteResolver {
  private readonly logger = new Logger(SiteResolver.name);
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    private readonly restoreService: RestoreService,
  ) {}

  /**
   * Create a new site
   */
  @Mutation(() => SiteResponse)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createSite(
    @Args('input') input: CreateSiteInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; planLevel?: number },
  ): Promise<SiteResponse> {
    this.logger.log(`Creating site for tenant ${tenantId} by user ${user.sub}`);
    const command = new CreateSiteCommand(input, tenantId, user.sub, user.planLevel);
    return this.commandBus.execute(command);
  }

  /**
   * Update an existing site
   */
  @Mutation(() => SiteResponse)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => SiteDeletePreviewResponse)
  async siteDeletePreview(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: SiteScopeCaller,
  ): Promise<SiteDeletePreviewResponse> {
    this.logger.log(`Getting delete preview for site ${id} for tenant ${tenantId}`);
    const query = new GetSiteDeletePreviewQuery(id, tenantId, user);
    return this.queryBus.execute(query);
  }

  /**
   * Delete (soft) a site
   * @param cascade If true, cascade soft delete all related items (departments, systems, equipment, tanks)
   */
  @Mutation(() => Boolean)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deleteSite(
    @Args('id', { type: () => ID }) id: string,
    @Args('cascade', { type: () => Boolean, defaultValue: false }) cascade: boolean,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(
      `Deleting site ${id} for tenant ${tenantId} by user ${user.sub} (cascade: ${cascade})`,
    );
    const command = new DeleteSiteCommand(id, tenantId, user.sub, cascade);
    return this.commandBus.execute(command);
  }

  /**
   * Restore a soft-deleted site. TENANT_ADMIN only — restoring a site
   * does NOT cascade to its previously-deleted children; each child
   * (department, system, equipment) must be restored explicitly so the
   * operator confirms the rollback scope. The uniqueness check guards
   * BOTH unique indexes — (tenantId, code) and (tenantId, name) — so
   * a code or name re-used on an active site since the soft delete
   * surfaces a RestoreUniquenessConflictError instead of a database
   * unique-constraint failure.
   *
   * Phase 4.2 of the "Farm modülü kalan kör noktalar" plan. Closes
   * Girdi 6 for Site.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => SiteResponse)
  async restoreSite(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; name?: string },
  ): Promise<Site> {
    this.logger.log(`Restoring site ${id} for tenant ${tenantId} by user ${user.sub}`);
    return this.restoreService.restore(
      this.siteRepository,
      Site,
      id,
      { tenantId, userId: user.sub, userName: user.name },
      {
        // Both unique indexes from site.entity.ts:132-133 must be
        // checked. Restore is rejected if either active row collides.
        uniqueKeys: [['code'], ['name']],
      },
    );
  }

  /**
   * Get a single site by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SiteResponse, { nullable: true })
  async site(
    @Args('id', { type: () => ID }) id: string,
    @Args('includeRelations', { type: () => Boolean, nullable: true, defaultValue: false })
    includeRelations: boolean,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: SiteScopeCaller,
  ): Promise<SiteResponse | null> {
    const query = new GetSiteQuery(id, tenantId, user, includeRelations);
    return this.queryBus.execute(query);
  }

  /**
   * List sites with pagination and filtering
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedSitesResponse)
  async sites(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: SiteScopeCaller,
    @Args('filter', { type: () => SiteFilterInput, nullable: true }) filter?: SiteFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ): Promise<PaginatedSitesResponse> {
    const query = new ListSitesQuery(tenantId, user, filter, pagination);
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<SiteResponse>;
    return fromCqrsPaginated(result);
  }

  /**
   * Operational active-site list retained as a first-class API for existing
   * farm consumers. Unlike the legacy implementation, this fails closed when
   * the bounded response would be incomplete or its count/data snapshots
   * disagree; callers never receive a silently truncated list.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SiteResponse])
  async activeSites(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: SiteScopeCaller,
  ): Promise<SiteResponse[]> {
    const result = (await this.queryBus.execute(
      new ListSitesQuery(
        tenantId,
        user,
        { isActive: true },
        {
          page: 1,
          limit: ACTIVE_SITE_COLLECTION_HARD_CAP + 1,
          sortBy: 'id',
          sortOrder: 'ASC',
        },
      ),
    )) as PaginatedQueryResult<SiteResponse>;

    if (
      result.pagination.total > ACTIVE_SITE_COLLECTION_HARD_CAP ||
      result.data.length > ACTIVE_SITE_COLLECTION_HARD_CAP ||
      result.data.length !== result.pagination.total
    ) {
      throw new ActiveSiteCollectionLimitExceededError();
    }
    return result.data;
  }

  /**
   * Canonical tenant-wide catalog for user-to-site access administration.
   * The handler owns the bounded, single-snapshot read; this resolver accepts
   * no pagination input that could produce a silently incomplete catalog.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => [SiteAccessCatalogItemResponse])
  async activeSiteAccessCatalog(
    @CurrentTenant() tenantId: string,
  ): Promise<SiteAccessCatalogItemResponse[]> {
    return this.queryBus.execute(new GetActiveSiteAccessCatalogQuery(tenantId));
  }

  // -------------------------------------------------------------------------
  // SITE CONTACTS (Scope A Phase 4.4.3)
  // -------------------------------------------------------------------------

  /**
   * Replace the FULL contact list for a site. Pass an empty
   * `contacts` array to clear all contacts. At most one entry may
   * carry `isPrimary: true` (DB partial unique index also enforces;
   * the handler pre-checks for clearer error messages).
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => [SiteContactResponse])
  async upsertSiteContacts(
    @Args('siteId', { type: () => ID }) siteId: string,
    @Args('contacts', { type: () => [SiteContactInput] }) contacts: SiteContactInput[],
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SiteContactResponse[]> {
    this.logger.log(`Upserting ${contacts.length} contact(s) for site ${siteId}`);
    return this.commandBus.execute(
      new UpsertSiteContactsCommand(siteId, contacts, tenantId, user.sub),
    );
  }

  /**
   * List the contact rows for one site.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SiteContactResponse])
  async siteContacts(
    @Args('siteId', { type: () => ID }) siteId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: SiteScopeCaller,
  ): Promise<SiteContactResponse[]> {
    return this.queryBus.execute(new ListSiteContactsQuery(siteId, tenantId, user));
  }

  /**
   * Field resolver — exposes `Site.contacts` directly so a single
   * GraphQL query against `site(id)` returns both site + contacts.
   */
  @ResolveField(() => [SiteContactResponse])
  async contacts(
    @Parent() parent: SiteResponse,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: SiteScopeCaller,
  ): Promise<SiteContactResponse[]> {
    return this.queryBus.execute(new ListSiteContactsQuery(parent.id, tenantId, user));
  }
}
