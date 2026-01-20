/**
 * Department GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { TenantGuard, CurrentTenant, CurrentUser } from '@platform/backend-common';
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

@Resolver(() => DepartmentResponse)
@UseGuards(TenantGuard)
export class DepartmentResolver {
  private readonly logger = new Logger(DepartmentResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Create a new department
   */
  @Mutation(() => DepartmentResponse)
  async createDepartment(
    @Args('input') input: CreateDepartmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<DepartmentResponse> {
    this.logger.log(`Creating department for tenant ${tenantId} by user ${user.sub}`);
    const command = new CreateDepartmentCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Update an existing department
   */
  @Mutation(() => DepartmentResponse)
  async updateDepartment(
    @Args('input') input: UpdateDepartmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<DepartmentResponse> {
    this.logger.log(`Updating department ${input.id} for tenant ${tenantId} by user ${user.sub}`);
    const command = new UpdateDepartmentCommand(input.id, input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  /**
   * Get delete preview for a department
   * Returns what will be deleted when the department is cascade soft deleted
   */
  @Query(() => DepartmentDeletePreviewResponse)
  async departmentDeletePreview(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<DepartmentDeletePreviewResponse> {
    this.logger.log(`Getting delete preview for department ${id} for tenant ${tenantId}`);
    const query = new GetDepartmentDeletePreviewQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  /**
   * Delete (soft) a department
   * @param cascade If true, cascade soft delete all related items (equipment, tanks)
   */
  @Mutation(() => Boolean)
  async deleteDepartment(
    @Args('id', { type: () => ID }) id: string,
    @Args('cascade', { type: () => Boolean, defaultValue: false }) cascade: boolean,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting department ${id} for tenant ${tenantId} by user ${user.sub} (cascade: ${cascade})`);
    const command = new DeleteDepartmentCommand(id, tenantId, user.sub, cascade);
    return this.commandBus.execute(command);
  }

  /**
   * Get a single department by ID
   */
  @Query(() => DepartmentResponse, { nullable: true })
  async department(
    @Args('id', { type: () => ID }) id: string,
    @Args('includeRelations', { type: () => Boolean, nullable: true, defaultValue: false }) includeRelations: boolean,
    @CurrentTenant() tenantId: string,
  ): Promise<DepartmentResponse | null> {
    const query = new GetDepartmentQuery(id, tenantId, includeRelations);
    return this.queryBus.execute(query);
  }

  /**
   * List departments with pagination and filtering
   */
  @Query(() => PaginatedDepartmentsResponse)
  async departments(
    @Args('filter', { type: () => DepartmentFilterInput, nullable: true }) filter?: DepartmentFilterInput,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination?: PaginationInput,
    @CurrentTenant() tenantId?: string,
  ): Promise<PaginatedDepartmentsResponse> {
    if (!tenantId) {
      throw new Error('Tenant ID is required');
    }
    const query = new ListDepartmentsQuery(tenantId, filter, pagination);
    return this.queryBus.execute(query);
  }

  /**
   * Get departments by site for dropdowns
   */
  @Query(() => [DepartmentResponse])
  async departmentsBySite(
    @Args('siteId', { type: () => ID }) siteId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<DepartmentResponse[]> {
    const query = new ListDepartmentsQuery(tenantId, { siteId, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Resolve site field
   */
  @ResolveField(() => SiteResponse, { nullable: true })
  async site(@Parent() department: DepartmentResponse): Promise<SiteResponse | null> {
    if (!department.siteId || !department.tenantId) return null;

    try {
      const query = new GetSiteQuery(department.siteId, department.tenantId);
      return this.queryBus.execute(query);
    } catch {
      return null;
    }
  }
}
