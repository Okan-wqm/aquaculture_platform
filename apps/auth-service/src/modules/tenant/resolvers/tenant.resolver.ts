import { Resolver, Query, Mutation, Args, ID, Context, Int, ResolveField, Parent } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { TenantService } from '../services/tenant.service';
import { Tenant } from '../entities/tenant.entity';
import { TenantModule } from '../entities/tenant-module.entity';
import { CreateTenantInput, UpdateTenantInput, AssignModuleManagerInput } from '../dto/create-tenant.dto';
import { TenantStats, TenantDatabaseInfo, TableSchemaInfo } from '../dto/tenant-stats.dto';
import { JwtAuthGuard } from '../../authentication/guards/jwt-auth.guard';
import { CurrentUser, Public, SuperAdminOnly, TenantAdminOrHigher } from '@platform/backend-common';
import { User } from '../../authentication/entities/user.entity';

@Resolver(() => Tenant)
export class TenantResolver {
  constructor(private readonly tenantService: TenantService) {}

  @UseGuards(JwtAuthGuard)
  @SuperAdminOnly()
  @Mutation(() => Tenant)
  async createTenant(
    @Args('input') input: CreateTenantInput,
    @Context() ctx: { req: { user: { id: string } } },
  ): Promise<Tenant> {
    return this.tenantService.create(input, ctx.req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @SuperAdminOnly()
  @Query(() => [Tenant])
  async tenants(): Promise<Tenant[]> {
    return this.tenantService.findAll();
  }

  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Query(() => Tenant)
  async tenant(@Args('id', { type: () => ID }) id: string): Promise<Tenant> {
    return this.tenantService.findById(id);
  }

  @Public()
  @Query(() => Tenant)
  async tenantBySlug(@Args('slug') slug: string): Promise<Tenant> {
    return this.tenantService.findBySlug(slug);
  }

  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Mutation(() => Tenant)
  async updateTenant(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateTenantInput,
  ): Promise<Tenant> {
    return this.tenantService.update(id, input);
  }

  @UseGuards(JwtAuthGuard)
  @SuperAdminOnly()
  @Mutation(() => Tenant)
  async suspendTenant(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Tenant> {
    return this.tenantService.suspend(id);
  }

  @UseGuards(JwtAuthGuard)
  @SuperAdminOnly()
  @Mutation(() => Tenant)
  async activateTenant(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Tenant> {
    return this.tenantService.activate(id);
  }

  @UseGuards(JwtAuthGuard)
  @SuperAdminOnly()
  @Mutation(() => Tenant)
  async cancelTenant(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<Tenant> {
    return this.tenantService.cancel(id);
  }

  // ============================================================================
  // Tenant Admin Specific Queries and Mutations
  // ============================================================================

  /**
   * Get current user's tenant (for TENANT_ADMIN)
   */
  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Query(() => Tenant)
  async myTenant(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<Tenant> {
    return this.tenantService.findById(tenantId);
  }

  /**
   * Get tenant statistics (users, modules, activity)
   */
  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Query(() => TenantStats)
  async tenantStats(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantStats> {
    return this.tenantService.getTenantStats(tenantId);
  }

  /**
   * Get tenant's assigned modules with details
   */
  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Query(() => [TenantModule])
  async myTenantModules(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantModule[]> {
    return this.tenantService.getTenantModules(tenantId);
  }

  /**
   * Get users belonging to tenant
   */
  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Query(() => [User])
  async tenantUsers(
    @CurrentUser('tenantId') tenantId: string,
    @Args('status', { nullable: true }) status?: string,
    @Args('role', { nullable: true }) role?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<User[]> {
    return this.tenantService.getTenantUsers(tenantId, { status, role, limit, offset });
  }

  /**
   * Get tenant database information (read-only view)
   */
  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Query(() => TenantDatabaseInfo)
  async tenantDatabase(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantDatabaseInfo> {
    return this.tenantService.getTenantDatabaseInfo(tenantId);
  }

  /**
   * Get table schema information (columns, indexes)
   * Only returns schema for tables the tenant has access to
   */
  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Query(() => TableSchemaInfo)
  async tableSchema(
    @Args('schemaName') schemaName: string,
    @Args('tableName') tableName: string,
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TableSchemaInfo> {
    return this.tenantService.getTableSchema(tenantId, schemaName, tableName);
  }

  /**
   * Assign module manager to a module
   */
  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Mutation(() => TenantModule)
  async assignModuleManager(
    @Args('input') input: AssignModuleManagerInput,
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantModule> {
    return this.tenantService.assignModuleManager(
      tenantId,
      input.moduleId,
      input.userId,
    );
  }

  /**
   * Remove module manager from a module
   */
  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Mutation(() => TenantModule)
  async removeModuleManager(
    @Args('moduleId', { type: () => ID }) moduleId: string,
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantModule> {
    return this.tenantService.removeModuleManager(tenantId, moduleId);
  }

  /**
   * Update tenant settings (TENANT_ADMIN can update limited fields)
   */
  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Mutation(() => Tenant)
  async updateTenantSettings(
    @Args('input') input: UpdateTenantInput,
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<Tenant> {
    // Tenant admins can only update their own tenant
    return this.tenantService.updateTenantSettings(tenantId, input);
  }
}
