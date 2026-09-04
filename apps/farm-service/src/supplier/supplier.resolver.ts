/**
 * Supplier GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentTenant, CurrentUser, SkipTenantGuard, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { SupplierResponse, PaginatedSuppliersResponse, SupplierTypeResponse } from './dto/supplier.response';
import { CreateSupplierInput } from './dto/create-supplier.input';
import { UpdateSupplierInput } from './dto/update-supplier.input';
import { SupplierFilterInput } from './dto/supplier-filter.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateSupplierCommand } from './commands/create-supplier.command';
import { UpdateSupplierCommand } from './commands/update-supplier.command';
import { DeleteSupplierCommand } from './commands/delete-supplier.command';
import { SetSupplierApprovedSitesCommand } from './commands/set-supplier-approved-sites.command';
import { GetSupplierQuery } from './queries/get-supplier.query';
import { ListSuppliersQuery } from './queries/list-suppliers.query';
import { ListSupplierSitesQuery } from './queries/list-supplier-sites.query';
import { SupplierSiteResponse } from './dto/supplier-site.response';
import { Supplier, SupplierType } from './entities/supplier.entity';
import { SupplierType as SupplierTypeEntity } from './entities/supplier-type.entity';
import { RestoreService } from '../common/services/restore.service';

@Resolver(() => SupplierResponse)
@UseGuards(TenantGuard)
export class SupplierResolver {
  private readonly logger = new Logger(SupplierResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(SupplierTypeEntity)
    private readonly supplierTypeRepository: Repository<SupplierTypeEntity>,
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
    private readonly restoreService: RestoreService,
  ) {}

  /**
   * Create a new supplier
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => SupplierResponse)
  async createSupplier(
    @Args('input') input: CreateSupplierInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SupplierResponse> {
    this.logger.log(`Creating supplier "${input.name}" for tenant ${tenantId}`);
    const command = new CreateSupplierCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update an existing supplier
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => SupplierResponse)
  async updateSupplier(
    @Args('input') input: UpdateSupplierInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SupplierResponse> {
    this.logger.log(`Updating supplier ${input.id} for tenant ${tenantId}`);
    const command = new UpdateSupplierCommand(input.id, input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Delete (soft) a supplier
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteSupplier(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting supplier ${id} for tenant ${tenantId}`);
    const command = new DeleteSupplierCommand(id, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Restore a soft-deleted supplier. TENANT_ADMIN only. Phase 4.2
   * of the "Farm modülü kalan kör noktalar" plan. Closes Girdi 6
   * on the supplier surface.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => SupplierResponse)
  async restoreSupplier(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; name?: string },
  ): Promise<Supplier> {
    this.logger.log(`Restoring supplier ${id} for tenant ${tenantId}`);
    return this.restoreService.restore(
      this.supplierRepository,
      Supplier,
      id,
      { tenantId, userId: user.sub, userName: user.name },
      { uniqueKeys: [['code']] },
    );
  }

  /**
   * Get a single supplier by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SupplierResponse, { nullable: true })
  async supplier(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SupplierResponse | null> {
    const query = new GetSupplierQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * List suppliers with pagination and filtering
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedSuppliersResponse)
  async suppliers(
    @Args('filter', { type: () => SupplierFilterInput, nullable: true }) filter: SupplierFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedSuppliersResponse> {
    const query = new ListSuppliersQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<SupplierResponse>;
    return fromCqrsPaginated(result);
  }

  /**
   * Get suppliers by type for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SupplierResponse])
  async suppliersByType(
    @Args('type', { type: () => SupplierType }) type: SupplierType,
    @CurrentTenant() tenantId: string,
  ): Promise<readonly SupplierResponse[]> {
    const query = new ListSuppliersQuery(tenantId, { type, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<SupplierResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get equipment suppliers for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SupplierResponse])
  async equipmentSuppliers(
    @CurrentTenant() tenantId: string,
  ): Promise<readonly SupplierResponse[]> {
    const query = new ListSuppliersQuery(
      tenantId,
      { type: SupplierType.EQUIPMENT, isActive: true },
      { limit: 1000 },
    );
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<SupplierResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get feed suppliers for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SupplierResponse])
  async feedSuppliers(@CurrentTenant() tenantId: string): Promise<readonly SupplierResponse[]> {
    const query = new ListSuppliersQuery(
      tenantId,
      { type: SupplierType.FEED, isActive: true },
      { limit: 1000 },
    );
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<SupplierResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get chemical suppliers for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SupplierResponse])
  async chemicalSuppliers(@CurrentTenant() tenantId: string): Promise<readonly SupplierResponse[]> {
    const query = new ListSuppliersQuery(
      tenantId,
      { type: SupplierType.CHEMICAL, isActive: true },
      { limit: 1000 },
    );
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<SupplierResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get all supplier types (global, not tenant-specific)
   */
  @SkipTenantGuard()
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SupplierTypeResponse])
  async supplierTypes(): Promise<SupplierTypeResponse[]> {
    return this.supplierTypeRepository.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }

  // -------------------------------------------------------------------------
  // SUPPLIER ↔ SITE APPROVALS (Scope A Phase 4.4.2)
  // -------------------------------------------------------------------------

  /**
   * Replace the FULL set of sites a supplier is approved to deliver
   * to. Pass an empty `siteIds` array to clear all approvals.
   * `preferredSiteId` MUST be one of `siteIds` (or null) — orphan
   * preferences are rejected at the handler level.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => [SupplierSiteResponse])
  async setSupplierApprovedSites(
    @Args('supplierId', { type: () => ID }) supplierId: string,
    @Args('siteIds', { type: () => [ID] }) siteIds: string[],
    @Args('preferredSiteId', { type: () => ID, nullable: true })
    preferredSiteId: string | null,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SupplierSiteResponse[]> {
    this.logger.log(
      `Setting approved sites for supplier ${supplierId} (${siteIds.length} site(s))`,
    );
    const command = new SetSupplierApprovedSitesCommand(
      supplierId,
      siteIds,
      preferredSiteId ?? null,
      tenantId,
      user.sub,
    );
    return this.commandBus.execute(command);
  }

  /**
   * List the supplier-site approval rows for one supplier.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SupplierSiteResponse])
  async supplierSites(
    @Args('supplierId', { type: () => ID }) supplierId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SupplierSiteResponse[]> {
    return this.queryBus.execute(new ListSupplierSitesQuery(supplierId, tenantId));
  }

  /**
   * Field resolver — exposes `Supplier.approvedSites` directly on the
   * SupplierResponse type so a single GraphQL query against
   * `supplier(id)` can return both the supplier and its approval
   * rows. Per-row supplier/site joins are NOT done here; clients
   * fetch the joined Site object via the existing `site(id)` query.
   */
  @ResolveField(() => [SupplierSiteResponse])
  async approvedSites(
    @Parent() parent: SupplierResponse,
    @CurrentTenant() tenantId: string,
  ): Promise<SupplierSiteResponse[]> {
    return this.queryBus.execute(new ListSupplierSitesQuery(parent.id, tenantId));
  }
}
