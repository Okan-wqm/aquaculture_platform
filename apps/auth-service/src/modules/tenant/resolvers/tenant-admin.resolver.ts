import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { TenantAdminOrHigher, CurrentUser, Roles, Role } from '@platform/backend-common';

import { User } from '../../authentication/entities/user.entity';
import {
  AssignUserToModuleInput,
  AssignmentResult,
  UserModuleInfo,
  TenantTableInfo,
  TableDataResult,
  GetTableDataInput,
} from '../dto/tenant-admin.dto';
import { TenantAdminService } from '../services/tenant-admin.service';

/**
 * TenantAdminResolver
 *
 * GraphQL resolver for tenant admin operations.
 * All operations require TENANT_ADMIN role or higher.
 */
@Resolver()
export class TenantAdminResolver {
  constructor(private readonly tenantAdminService: TenantAdminService) {}

  // =========================================================
  // Queries
  // =========================================================

  /**
   * Get modules accessible by current user
   * TENANT_ADMIN: All tenant modules
   * MODULE_MANAGER/USER: Only assigned modules
   * SECURITY: Requires at least MODULE_USER role
   */
  @Roles(Role.MODULE_USER, Role.MODULE_MANAGER, Role.TENANT_ADMIN, Role.SUPER_ADMIN)
  @Query(() => [UserModuleInfo])
  async myModules(@CurrentUser('sub') userId: string): Promise<UserModuleInfo[]> {
    return this.tenantAdminService.getMyModules(userId);
  }

  /**
   * Get users assigned to a specific module
   */
  @Query(() => [User])
  @TenantAdminOrHigher()
  async moduleUsers(
    @CurrentUser('sub') userId: string,
    @Args('moduleId', { type: () => ID }) moduleId: string,
  ): Promise<User[]> {
    return this.tenantAdminService.getModuleUsers(userId, moduleId);
  }

  /**
   * Get tenant database tables (read-only)
   */
  @Query(() => [TenantTableInfo])
  @TenantAdminOrHigher()
  async tenantTables(
    @CurrentUser('sub') userId: string,
  ): Promise<TenantTableInfo[]> {
    return this.tenantAdminService.getTenantTables(userId);
  }

  /**
   * Get data from a specific table (paginated, read-only)
   */
  @Query(() => TableDataResult)
  @TenantAdminOrHigher()
  async tableData(
    @CurrentUser('sub') userId: string,
    @Args('input') input: GetTableDataInput,
  ): Promise<TableDataResult> {
    return this.tenantAdminService.getTableData(userId, input);
  }

  // =========================================================
  // Mutations
  // =========================================================

  /**
   * Assign a user to a module
   * Creates new user if email doesn't exist in tenant
   */
  @Mutation(() => AssignmentResult)
  @TenantAdminOrHigher()
  async assignUserToModule(
    @CurrentUser('sub') userId: string,
    @Args('input') input: AssignUserToModuleInput,
  ): Promise<AssignmentResult> {
    return this.tenantAdminService.assignUserToModule(userId, input);
  }

  /**
   * Remove a user from a module
   */
  @Mutation(() => Boolean)
  @TenantAdminOrHigher()
  async removeUserFromModule(
    @CurrentUser('sub') userId: string,
    @Args('userId', { type: () => ID }) targetUserId: string,
    @Args('moduleId', { type: () => ID }) moduleId: string,
  ): Promise<boolean> {
    return this.tenantAdminService.removeUserFromModule(
      userId,
      targetUserId,
      moduleId,
    );
  }

  /**
   * Deactivate a user in tenant
   */
  @Mutation(() => User)
  @TenantAdminOrHigher()
  async deactivateTenantUser(
    @CurrentUser('sub') userId: string,
    @Args('userId', { type: () => ID }) targetUserId: string,
  ): Promise<User> {
    return this.tenantAdminService.deactivateUser(userId, targetUserId);
  }

  /**
   * Activate a user in tenant
   */
  @Mutation(() => User)
  @TenantAdminOrHigher()
  async activateTenantUser(
    @CurrentUser('sub') userId: string,
    @Args('userId', { type: () => ID }) targetUserId: string,
  ): Promise<User> {
    return this.tenantAdminService.activateUser(userId, targetUserId);
  }
}
