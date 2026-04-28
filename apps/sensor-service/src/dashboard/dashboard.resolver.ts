import { Logger, ForbiddenException, UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { Roles, Role, Tenant, CurrentUser, CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';

import { DashboardService } from './dashboard.service';
import { SaveDashboardLayoutInput, CreateSystemDefaultLayoutInput } from './dto/dashboard-layout.dto';
import { DashboardLayout } from './entities/dashboard-layout.entity';

/**
 * GraphQL Resolver for Dashboard Layout operations
 */
@Resolver(() => DashboardLayout)
@UseGuards(TenantGuard)
export class DashboardResolver {
  private readonly logger = new Logger(DashboardResolver.name);

  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * Get all layouts for the current user
   */
  @Query(() => [DashboardLayout], { name: 'dashboardLayouts' })
  async getDashboardLayouts(
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<DashboardLayout[]> {
    this.logger.debug(`Getting layouts for user ${userId} in tenant ${tenantId}`);
    return this.dashboardService.getUserLayouts(tenantId, userId);
  }

  /**
   * Get a single layout by ID
   */
  @Query(() => DashboardLayout, { name: 'dashboardLayout', nullable: true })
  async getDashboardLayout(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<DashboardLayout> {
    return this.dashboardService.getLayoutById(id, tenantId, userId);
  }

  /**
   * Get user's default layout (or system default if none)
   */
  @Query(() => DashboardLayout, { name: 'myDefaultLayout', nullable: true })
  async getMyDefaultLayout(
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<DashboardLayout | null> {
    this.logger.debug(`Getting default layout for user ${userId}`);
    return this.dashboardService.getMyDefaultLayout(tenantId, userId);
  }

  /**
   * Get system default layout for tenant
   */
  @Query(() => DashboardLayout, { name: 'systemDefaultLayout', nullable: true })
  async getSystemDefaultLayout(
    @Tenant() tenantId: string,
  ): Promise<DashboardLayout | null> {
    return this.dashboardService.getSystemDefaultLayout(tenantId);
  }

  /**
   * Save (create or update) a dashboard layout
   */
  @Mutation(() => DashboardLayout, { name: 'saveDashboardLayout' })
  async saveDashboardLayout(
    @Args('input') input: SaveDashboardLayoutInput,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<DashboardLayout> {
    this.logger.log(`Saving layout "${input.name}" for user ${userId}`);
    return this.dashboardService.saveLayout(input, tenantId, userId);
  }

  /**
   * Save system default layout (admin only)
   * Only TENANT_ADMIN or higher can modify system default layouts
   */
  @Mutation(() => DashboardLayout, { name: 'saveSystemDefaultLayout' })
  @Roles(Role.SUPER_ADMIN, Role.TENANT_ADMIN)
  async saveSystemDefaultLayout(
    @Args('input') input: CreateSystemDefaultLayoutInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<DashboardLayout> {
    const userId = user.sub;

    // Additional role verification from user payload
    const userRoles = user.roles || [];
    const hasAdminRole = userRoles.some(
      role => role === Role.SUPER_ADMIN || role === Role.TENANT_ADMIN
    );

    if (!hasAdminRole) {
      this.logger.warn(`Unauthorized attempt to modify system default layout by user ${userId}`);
      throw new ForbiddenException('Only tenant administrators can modify system default layouts');
    }

    this.logger.log(`Saving system default layout for tenant ${tenantId} by admin ${userId}`);
    return this.dashboardService.saveSystemDefaultLayout(input, tenantId, userId);
  }

  /**
   * Set a layout as the user's default
   */
  @Mutation(() => DashboardLayout, { name: 'setLayoutAsDefault' })
  async setLayoutAsDefault(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<DashboardLayout> {
    this.logger.log(`Setting layout ${id} as default for user ${userId}`);
    return this.dashboardService.setAsDefault(id, tenantId, userId);
  }

  /**
   * Delete a dashboard layout
   */
  @Mutation(() => Boolean, { name: 'deleteDashboardLayout' })
  async deleteDashboardLayout(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting layout ${id}`);
    return this.dashboardService.deleteLayout(id, tenantId, userId);
  }
}
