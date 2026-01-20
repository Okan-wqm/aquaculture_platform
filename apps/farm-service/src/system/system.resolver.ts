/**
 * System GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { TenantGuard, CurrentTenant, CurrentUser } from '@platform/backend-common';
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

@Resolver(() => SystemResponse)
@UseGuards(TenantGuard)
export class SystemResolver {
  private readonly logger = new Logger(SystemResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Create new system
   */
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
   * Get single system by ID
   */
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
    return this.queryBus.execute(query);
  }

  /**
   * Get systems by site for dropdowns
   */
  @Query(() => [SystemResponse])
  async systemsBySite(
    @Args('siteId', { type: () => ID }) siteId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SystemResponse[]> {
    const query = new ListSystemsQuery(tenantId, { siteId, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get systems by department for dropdowns
   */
  @Query(() => [SystemResponse])
  async systemsByDepartment(
    @Args('departmentId', { type: () => ID }) departmentId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SystemResponse[]> {
    const query = new ListSystemsQuery(tenantId, { departmentId, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get child systems of a parent system
   */
  @Query(() => [SystemResponse])
  async childSystems(
    @Args('parentSystemId', { type: () => ID }) parentSystemId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<SystemResponse[]> {
    const query = new ListSystemsQuery(tenantId, { parentSystemId, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Get root systems (no parent)
   */
  @Query(() => [SystemResponse])
  async rootSystems(
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @CurrentTenant() tenantId?: string,
  ): Promise<SystemResponse[]> {
    if (!tenantId) {
      throw new Error('Tenant ID is required');
    }
    const query = new ListSystemsQuery(tenantId, { siteId, rootOnly: true, isActive: true }, { limit: 1000 });
    const result = await this.queryBus.execute(query);
    return result.items;
  }

  /**
   * Resolve site field
   */
  @ResolveField(() => SiteResponse, { nullable: true })
  async site(@Parent() system: SystemResponse): Promise<SiteResponse | null> {
    if (!system.siteId || !system.tenantId) return null;

    try {
      const query = new GetSiteQuery(system.siteId, system.tenantId);
      return this.queryBus.execute(query);
    } catch {
      return null;
    }
  }

  /**
   * Resolve department field
   */
  @ResolveField(() => DepartmentResponse, { nullable: true })
  async department(@Parent() system: SystemResponse): Promise<DepartmentResponse | null> {
    if (!system.departmentId || !system.tenantId) return null;

    try {
      const query = new GetDepartmentQuery(system.departmentId, system.tenantId);
      return this.queryBus.execute(query);
    } catch {
      return null;
    }
  }

  /**
   * Resolve parent system field
   */
  @ResolveField(() => SystemResponse, { nullable: true })
  async parentSystem(@Parent() system: SystemResponse): Promise<SystemResponse | null> {
    if (!system.parentSystemId || !system.tenantId) return null;

    try {
      const query = new GetSystemQuery(system.parentSystemId, system.tenantId);
      return this.queryBus.execute(query);
    } catch {
      return null;
    }
  }

  /**
   * Resolve child systems field
   */
  @ResolveField(() => [SystemResponse], { nullable: true })
  async childSystemsField(@Parent() system: SystemResponse): Promise<SystemResponse[]> {
    if (!system.id || !system.tenantId) return [];

    try {
      const query = new ListSystemsQuery(system.tenantId, { parentSystemId: system.id, isActive: true }, { limit: 1000 });
      const result = await this.queryBus.execute(query);
      return result.items;
    } catch {
      return [];
    }
  }
}
