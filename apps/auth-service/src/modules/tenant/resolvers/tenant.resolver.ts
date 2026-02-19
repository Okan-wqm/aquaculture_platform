import { UseGuards, ForbiddenException } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType, Field } from '@nestjs/graphql';
import { CurrentUser, Public, SuperAdminOnly, TenantAdminOrHigher, Role } from '@platform/backend-common';

import { User } from '../../authentication/entities/user.entity';
import { JwtAuthGuard } from '../../authentication/guards/jwt-auth.guard';
import { CreateTenantInput, UpdateTenantInput, AssignModuleManagerInput } from '../dto/create-tenant.dto';
import { TenantStats, TenantDatabaseInfo, TableSchemaInfo } from '../dto/tenant-stats.dto';
import { TenantModule } from '../entities/tenant-module.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';

/**
 * Minimal public tenant info exposed by the unauthenticated tenantBySlug query.
 * SECURITY: Does not expose plan, maxUsers, settings, contactEmail, etc.
 */
@ObjectType()
class TenantPublicInfo {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field(() => String, { nullable: true })
  logoUrl!: string | null;

  @Field(() => TenantStatus)
  status!: TenantStatus;
}
import { TenantService } from '../services/tenant.service';

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
  async tenant(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser('role') role: Role,
    @CurrentUser('tenantId') userTenantId: string | null,
  ): Promise<Tenant> {
    // SECURITY: Tenant isolation - TENANT_ADMIN can only access their own tenant
    if (role !== Role.SUPER_ADMIN && userTenantId !== id) {
      throw new ForbiddenException('Access denied: You can only access your own tenant');
    }
    return this.tenantService.findById(id);
  }

  @Public()
  @Query(() => TenantPublicInfo)
  async tenantBySlug(@Args('slug') slug: string): Promise<TenantPublicInfo> {
    const tenant = await this.tenantService.findBySlug(slug);
    // SECURITY: Only expose minimal public info — no plan, maxUsers, settings, etc.
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      logoUrl: tenant.logoUrl ?? null,
      status: tenant.status,
    };
  }

  @UseGuards(JwtAuthGuard)
  @TenantAdminOrHigher()
  @Mutation(() => Tenant)
  async updateTenant(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateTenantInput,
    @CurrentUser('role') role: Role,
    @CurrentUser('tenantId') userTenantId: string | null,
  ): Promise<Tenant> {
    // SECURITY: Tenant isolation - TENANT_ADMIN can only update their own tenant
    if (role !== Role.SUPER_ADMIN && userTenantId !== id) {
      throw new ForbiddenException('Access denied: You can only update your own tenant');
    }
    // SECURITY: Non-SUPER_ADMIN callers use restricted updateTenantSettings
    // which blocks status, plan, and maxUsers changes (SEC-AUTH-016)
    if (role !== Role.SUPER_ADMIN) {
      return this.tenantService.updateTenantSettings(id, input);
    }
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
