/**
 * System GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { SystemResponse, PaginatedSystemsResponse } from './dto/system.response';
import { SystemDeletePreviewResponse } from './dto/system-delete-preview.response';
import { CreateSystemInput } from './dto/create-system.input';
import { UpdateSystemInput } from './dto/update-system.input';
import { SystemFilterInput } from './dto/system-filter.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateSystemCommand } from './commands/create-system.command';
import { UpdateSystemCommand } from './commands/update-system.command';
import { DeleteSystemCommand } from './commands/delete-system.command';
import { GetSystemQuery } from './queries/get-system.query';
import { ListSystemsQuery } from './queries/list-systems.query';
import { GetSystemDeletePreviewQuery } from './queries/get-system-delete-preview.query';
import { SiteResponse } from '../site/dto/site.response';
import { DepartmentResponse } from '../department/dto/department.response';
import { GetSiteQuery } from '../site/queries/get-site.query';
import { GetDepartmentQuery } from '../department/queries/get-department.query';
import { System } from './entities/system.entity';
import { RestoreService } from '../common/services/restore.service';

@Resolver(() => SystemResponse)
@UseGuards(TenantGuard)
export class SystemResolver {
  private readonly logger = new Logger(SystemResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(System)
    private readonly systemRepository: Repository<System>,
    private readonly restoreService: RestoreService,
  ) {}

  /**
   * Create new system
   */
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => SystemResponse)
  async createSystem(
    @Args('input') input: CreateSystemInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SystemResponse> {
    this.logger.log(`Creating system: ${input.name} for tenant ${tenantId} by user ${user.sub}`);
    const command = new CreateSystemCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update existing system
   */
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => SystemResponse)
  async updateSystem(
    @Args('input') input: UpdateSystemInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<SystemResponse> {
    this.logger.log(`Updating system: ${input.id} for tenant ${tenantId} by user ${user.sub}`);
    const command = new UpdateSystemCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Get delete preview for a system
   * Returns what will be deleted when the system is cascade soft deleted
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => SystemDeletePreviewResponse)
  async systemDeletePreview(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SystemDeletePreviewResponse> {
    this.logger.log(`Getting delete preview for system ${id} for tenant ${tenantId}`);
    const query = new GetSystemDeletePreviewQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * Delete (soft) system
   * @param cascade If true, cascade soft delete all related items (child systems, equipment connections)
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteSystem(
    @Args('id', { type: () => ID }) id: string,
    @Args('cascade', { type: () => Boolean, defaultValue: false }) cascade: boolean,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting system: ${id} for tenant ${tenantId} by user ${user.sub} (cascade: ${cascade})`);
    const command = new DeleteSystemCommand(id, tenantId, user.sub, cascade);
    return this.commandBus.execute(command);
  }

  /**
   * Restore a soft-deleted system. TENANT_ADMIN only — restoring a
   * system re-activates child systems and equipment connections; the
   * uniqueness check guards the (tenantId, siteId, code) index so a
   * later create with the same code cannot collide with the restored
   * row. Cascade restore of children is intentionally NOT done here:
   * each soft-deleted child must be restored explicitly so the operator
   * is forced to confirm the scope of the rollback.
   *
   * Phase 4.2 of the "Farm modülü kalan kör noktalar" plan. Closes
   * Girdi 6 for System.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => SystemResponse)
  async restoreSystem(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; name?: string },
  ): Promise<System> {
    this.logger.log(`Restoring system ${id} for tenant ${tenantId} by user ${user.sub}`);
    return this.restoreService.restore(
      this.systemRepository,
      System,
      id,
      { tenantId, userId: user.sub, userName: user.name },
      {
        // System is unique per (tenantId, siteId, code) at the schema
        // level (see system.entity.ts:80). Restoring a row whose
        // (siteId, code) tuple has been reclaimed by an active row
        // would break the unique index — surfaces as
        // RestoreUniquenessConflictError.
        uniqueKeys: [['siteId', 'code']],
      },
    );
  }

  /**
   * Get single system by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SystemResponse, { nullable: true })
  async system(
    @Args('id', { type: () => ID }) id: string,
    @Args('includeRelations', { type: () => Boolean, nullable: true, defaultValue: false }) includeRelations: boolean,
    @CurrentTenant() tenantId: string,
  ): Promise<SystemResponse | null> {
    const query = new GetSystemQuery(id, tenantId, includeRelations);
    return this.queryBus.execute(query);
  }

  /**
   * List systems with pagination and filtering
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedSystemsResponse)
  async systems(
    @Args('filter', { type: () => SystemFilterInput, nullable: true }) filter?: SystemFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination?: PaginationInput,
    @CurrentTenant() tenantId?: string,
  ): Promise<PaginatedSystemsResponse> {
    if (!tenantId) {
      throw new Error('Tenant ID is required');
    }
    const query = new ListSystemsQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<SystemResponse>;
    return fromCqrsPaginated(result);
  }

  /**
   * Get systems by site for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SystemResponse])
  async systemsBySite(
    @Args('siteId', { type: () => ID }) siteId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SystemResponse[]> {
    const query = new ListSystemsQuery(tenantId, { siteId, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<SystemResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get systems by department for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SystemResponse])
  async systemsByDepartment(
    @Args('departmentId', { type: () => ID }) departmentId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SystemResponse[]> {
    const query = new ListSystemsQuery(tenantId, { departmentId, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<SystemResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get child systems of a parent system
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SystemResponse])
  async childSystems(
    @Args('parentSystemId', { type: () => ID }) parentSystemId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SystemResponse[]> {
    const query = new ListSystemsQuery(tenantId, { parentSystemId, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<SystemResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get root systems (no parent)
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SystemResponse])
  async rootSystems(
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @CurrentTenant() tenantId?: string,
  ): Promise<SystemResponse[]> {
    if (!tenantId) {
      throw new Error('Tenant ID is required');
    }
    const query = new ListSystemsQuery(tenantId, { siteId, rootOnly: true, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<SystemResponse>;
    return fromCqrsPaginated(result).items;
  }

  /**
   * Resolve site field
   */
  @ResolveField(() => SiteResponse, { nullable: true })
  async site(@Parent() system: SystemResponse): Promise<SiteResponse | null> {
    if ('site' in system && system.site) return system.site as SiteResponse;

    if (!system.siteId || !system.tenantId) return null;

    try {
      const query = new GetSiteQuery(system.siteId, system.tenantId);
      return await this.queryBus.execute(query);
    } catch (error: unknown) {
      this.logger.debug(`Error resolving site for system ${system.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Resolve department field
   */
  @ResolveField(() => DepartmentResponse, { nullable: true })
  async department(@Parent() system: SystemResponse): Promise<DepartmentResponse | null> {
    if ('department' in system && system.department) return system.department as DepartmentResponse;

    if (!system.departmentId || !system.tenantId) return null;

    try {
      const query = new GetDepartmentQuery(system.departmentId, system.tenantId);
      return await this.queryBus.execute(query);
    } catch (error: unknown) {
      this.logger.debug(`Error resolving department for system ${system.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Resolve parent system field
   */
  @ResolveField(() => SystemResponse, { nullable: true })
  async parentSystem(@Parent() system: SystemResponse): Promise<SystemResponse | null> {
    if ('parentSystem' in system && system.parentSystem) return system.parentSystem as SystemResponse;

    if (!system.parentSystemId || !system.tenantId) return null;

    try {
      const query = new GetSystemQuery(system.parentSystemId, system.tenantId);
      return await this.queryBus.execute(query);
    } catch (error: unknown) {
      // A genuinely missing parent (data-integrity edge) is a legitimate null
      // for this nullable field. A lost/wrong tenant context (TenantContextError)
      // must NOT be masked as "no parent" — let it surface.
      if (error instanceof NotFoundException) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Resolve child systems field
   */
  @ResolveField(() => [SystemResponse], { nullable: true })
  async childSystemsField(@Parent() system: SystemResponse): Promise<SystemResponse[]> {
    if ('childSystems' in system && system.childSystems) return system.childSystems as SystemResponse[];

    if (!system.id || !system.tenantId) return [];

    // ListSystemsQuery returns an empty list when there are no children, so a
    // genuine "no children" needs no catch. A query error (e.g. a lost tenant
    // context) must surface rather than be masked as an empty child list.
    const query = new ListSystemsQuery(system.tenantId, { parentSystemId: system.id, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query) as PaginatedQueryResult<SystemResponse>;
    return fromCqrsPaginated(result).items;
  }
}
