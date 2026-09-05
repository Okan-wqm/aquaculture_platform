/**
 * Department GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { TenantContextError } from '@aquaculture/backend-common/database';
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';
import { DepartmentResponse, PaginatedDepartmentsResponse } from './dto/department.response';
import { DepartmentDeletePreviewResponse } from './dto/department-delete-preview.response';
import { CreateDepartmentInput } from './dto/create-department.input';
import { UpdateDepartmentInput } from './dto/update-department.input';
import { DepartmentFilterInput } from './dto/department-filter.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateDepartmentCommand } from './commands/create-department.command';
import { UpdateDepartmentCommand } from './commands/update-department.command';
import { DeleteDepartmentCommand } from './commands/delete-department.command';
import { GetDepartmentQuery } from './queries/get-department.query';
import { ListDepartmentsQuery } from './queries/list-departments.query';
import { GetDepartmentDeletePreviewQuery } from './queries/get-department-delete-preview.query';
import { SiteResponse } from '../site/dto/site.response';
import { GetSiteQuery } from '../site/queries/get-site.query';
import { Department } from './entities/department.entity';
import { RestoreService } from '../common/services/restore.service';

@Resolver(() => DepartmentResponse)
@UseGuards(TenantGuard)
export class DepartmentResolver {
  private readonly logger = new Logger(DepartmentResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
    private readonly restoreService: RestoreService,
  ) {}

  /**
   * Create a new department
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => DepartmentResponse)
  async createDepartment(
    @Args('input') input: CreateDepartmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<DepartmentResponse> {
    this.logger.log('action=department.create');
    const command = new CreateDepartmentCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update an existing department
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => DepartmentResponse)
  async updateDepartment(
    @Args('input') input: UpdateDepartmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<DepartmentResponse> {
    this.logger.log('action=department.update');
    const command = new UpdateDepartmentCommand(input.id, input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Get delete preview for a department
   * Returns what will be deleted when the department is cascade soft deleted
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => DepartmentDeletePreviewResponse)
  async departmentDeletePreview(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<DepartmentDeletePreviewResponse> {
    this.logger.log('action=department.delete_preview');
    const query = new GetDepartmentDeletePreviewQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * Delete (soft) a department
   * @param cascade If true, cascade soft delete all related items (equipment, tanks)
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteDepartment(
    @Args('id', { type: () => ID }) id: string,
    @Args('cascade', { type: () => Boolean, defaultValue: false }) cascade: boolean,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`action=department.delete cascade=${cascade}`);
    const command = new DeleteDepartmentCommand(id, tenantId, user.sub, cascade);
    return this.commandBus.execute(command);
  }

  /**
   * Restore a soft-deleted department. TENANT_ADMIN only — restore
   * does NOT cascade to children; each soft-deleted child must be
   * restored explicitly. The uniqueness check guards the
   * (tenantId, code) index from department.entity.ts:80.
   *
   * Phase 4.2 of the "Farm modülü kalan kör noktalar" plan. Closes
   * Girdi 6 for Department.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => DepartmentResponse)
  async restoreDepartment(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; name?: string },
  ): Promise<Department> {
    this.logger.log('action=department.restore');
    return this.restoreService.restore(
      this.departmentRepository,
      Department,
      id,
      { tenantId, userId: user.sub, userName: user.name },
      {
        uniqueKeys: [['code']],
      },
    );
  }

  /**
   * Get a single department by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => DepartmentResponse, { nullable: true })
  async department(
    @Args('id', { type: () => ID }) id: string,
    @Args('includeRelations', { type: () => Boolean, nullable: true, defaultValue: false })
    includeRelations: boolean,
    @CurrentTenant() tenantId: string,
  ): Promise<DepartmentResponse | null> {
    const query = new GetDepartmentQuery(id, tenantId, includeRelations);
    return this.queryBus.execute(query);
  }

  /**
   * List departments with pagination and filtering
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedDepartmentsResponse)
  async departments(
    @Args('filter', { type: () => DepartmentFilterInput, nullable: true })
    filter?: DepartmentFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
    @CurrentTenant() tenantId?: string,
  ): Promise<PaginatedDepartmentsResponse> {
    if (!tenantId) {
      throw new Error('Tenant ID is required');
    }
    const query = new ListDepartmentsQuery(tenantId, filter, pagination);
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<DepartmentResponse>;
    return fromCqrsPaginated(result);
  }

  /**
   * Get departments by site for dropdowns
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [DepartmentResponse])
  async departmentsBySite(
    @Args('siteId', { type: () => ID }) siteId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<readonly DepartmentResponse[]> {
    this.logger.debug('action=department.list_by_site');
    const query = new ListDepartmentsQuery(tenantId, { siteId }, { limit: 1000 });
    const result = (await this.queryBus.execute(query)) as PaginatedQueryResult<DepartmentResponse>;
    const paginated = fromCqrsPaginated(result);
    this.logger.debug(`action=department.list_by_site_complete count=${paginated.items.length}`);
    return paginated.items;
  }

  /**
   * Resolve site field
   */
  @ResolveField(() => SiteResponse, { nullable: true })
  async site(
    @Parent() department: DepartmentResponse,
    @CurrentUser() user: SiteScopeCaller,
  ): Promise<SiteResponse | null> {
    if (!department.siteId || !department.tenantId) return null;

    try {
      const query = new GetSiteQuery(department.siteId, department.tenantId, user);
      return await this.queryBus.execute(query);
    } catch (error: unknown) {
      // A lost/wrong tenant context must surface, not be masked as "no site".
      if (error instanceof TenantContextError) {
        throw error;
      }
      this.logger.debug(
        `Error resolving site: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
