import { Logger } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';

import { DashboardService } from './dashboard.service';
import { SaveDashboardLayoutInput, CreateSystemDefaultLayoutInput } from './dto/dashboard-layout.dto';
import { DashboardLayout } from './entities/dashboard-layout.entity';

/**
 * GraphQL Resolver for Dashboard Layout operations
 */
@Resolver(() => DashboardLayout)
export class DashboardResolver {
  private readonly logger = new Logger(DashboardResolver.name);

  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * Get all layouts for the current user
   */
  @Query(() => [DashboardLayout], { name: 'dashboardLayouts' })
  async getDashboardLayouts(@Context() ctx: any): Promise<DashboardLayout[]> {
    const { tenantId, userId } = this.extractContext(ctx);
    this.logger.debug(`Getting layouts for user ${userId} in tenant ${tenantId}`);
    return this.dashboardService.getUserLayouts(tenantId, userId);
  }

  /**
   * Get a single layout by ID
   */
  @Query(() => DashboardLayout, { name: 'dashboardLayout', nullable: true })
  async getDashboardLayout(
    @Args('id', { type: () => ID }) id: string,
    @Context() ctx: any,
  ): Promise<DashboardLayout> {
    const { tenantId, userId } = this.extractContext(ctx);
    return this.dashboardService.getLayoutById(id, tenantId, userId);
  }

  /**
   * Get user's default layout (or system default if none)
   */
  @Query(() => DashboardLayout, { name: 'myDefaultLayout', nullable: true })
  async getMyDefaultLayout(@Context() ctx: any): Promise<DashboardLayout | null> {
    const { tenantId, userId } = this.extractContext(ctx);
    this.logger.debug(`Getting default layout for user ${userId}`);
    return this.dashboardService.getMyDefaultLayout(tenantId, userId);
  }

  /**
   * Get system default layout for tenant
   */
  @Query(() => DashboardLayout, { name: 'systemDefaultLayout', nullable: true })
  async getSystemDefaultLayout(@Context() ctx: any): Promise<DashboardLayout | null> {
    const { tenantId } = this.extractContext(ctx);
    return this.dashboardService.getSystemDefaultLayout(tenantId);
  }

  /**
   * Save (create or update) a dashboard layout
   */
  @Mutation(() => DashboardLayout, { name: 'saveDashboardLayout' })
  async saveDashboardLayout(
    @Args('input') input: SaveDashboardLayoutInput,
    @Context() ctx: any,
  ): Promise<DashboardLayout> {
    const { tenantId, userId } = this.extractContext(ctx);
    this.logger.log(`Saving layout "${input.name}" for user ${userId}`);
    return this.dashboardService.saveLayout(input, tenantId, userId);
  }

  /**
   * Save system default layout (admin only)
   */
  @Mutation(() => DashboardLayout, { name: 'saveSystemDefaultLayout' })
  async saveSystemDefaultLayout(
    @Args('input') input: CreateSystemDefaultLayoutInput,
    @Context() ctx: any,
  ): Promise<DashboardLayout> {
    const { tenantId, userId } = this.extractContext(ctx);
    // TODO: Add role check for TENANT_ADMIN
    this.logger.log(`Saving system default layout for tenant ${tenantId}`);
    return this.dashboardService.saveSystemDefaultLayout(input, tenantId, userId);
  }

  /**
   * Set a layout as the user's default
   */
  @Mutation(() => DashboardLayout, { name: 'setLayoutAsDefault' })
  async setLayoutAsDefault(
    @Args('id', { type: () => ID }) id: string,
    @Context() ctx: any,
  ): Promise<DashboardLayout> {
    const { tenantId, userId } = this.extractContext(ctx);
    this.logger.log(`Setting layout ${id} as default for user ${userId}`);
    return this.dashboardService.setAsDefault(id, tenantId, userId);
  }

  /**
   * Delete a dashboard layout
   */
  @Mutation(() => Boolean, { name: 'deleteDashboardLayout' })
  async deleteDashboardLayout(
    @Args('id', { type: () => ID }) id: string,
    @Context() ctx: any,
  ): Promise<boolean> {
    const { tenantId, userId } = this.extractContext(ctx);
    this.logger.log(`Deleting layout ${id}`);
    return this.dashboardService.deleteLayout(id, tenantId, userId);
  }

  /**
   * Extract tenant and user context from request
   */
  private extractContext(ctx: any): { tenantId: string; userId: string } {
    const req = ctx.req;
    const tenantId = req?.tenantId || req?.headers?.['x-tenant-id'];
    const userId = req?.user?.sub || req?.user?.id;

    if (!tenantId) {
      throw new Error('Tenant ID not found in request context');
    }
    if (!userId) {
      throw new Error('User ID not found in request context');
    }

    return { tenantId, userId };
  }
}
