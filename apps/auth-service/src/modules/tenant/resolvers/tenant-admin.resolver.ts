import { TenantAdminOrHigher, ModuleUserOrHigher, CurrentUser } from '@aquaculture/backend-common/decorators';
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';

import { BadRequestException } from '@nestjs/common';

import { User } from '../../authentication/entities/user.entity';
import {
  AssignUserToModuleInput,
  AssignUserToSiteInput,
  AssignmentResult,
  SiteAssignmentResult,
  UserModuleInfo,
  TenantTableInfo,
  TableDataResult,
  GetTableDataInput,
} from '../dto/tenant-admin.dto';
import {
  TenantLocalizationPreferences,
  TenantSecurityPolicy,
  UpdateTenantLocalizationPreferencesInput,
  UpdateTenantSecurityPolicyInput,
} from '../dto/tenant-policy.dto';
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
   *
   * WHY @ModuleUserOrHigher: the query is self-scoped (service branches on
   * the CALLER's own role/assignments), so MODULE_USER must be able to call
   * it — the service's MODULE_MANAGER/USER branch is unreachable otherwise.
   */
  @Query(() => [UserModuleInfo])
  @ModuleUserOrHigher()
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
   * Assign a user to a farm-service Site (SEC-HIGH-051).
   *
   * The management write-path for auth.user_site_assignments — the object-level
   * site-authz SSoT. Gated with the SAME @TenantAdminOrHigher() as the module
   * assignment precedent (TENANT_ADMIN + SUPER_ADMIN). Idempotent upsert.
   */
  @Mutation(() => SiteAssignmentResult)
  @TenantAdminOrHigher()
  async assignUserToSite(
    @CurrentUser('sub') userId: string,
    @Args('input') input: AssignUserToSiteInput,
  ): Promise<SiteAssignmentResult> {
    return this.tenantAdminService.assignUserToSite(userId, input);
  }

  /**
   * Unassign (deactivate) a user's site assignment (SEC-HIGH-051).
   */
  @Mutation(() => SiteAssignmentResult)
  @TenantAdminOrHigher()
  async unassignUserFromSite(
    @CurrentUser('sub') userId: string,
    @Args('userId', { type: () => ID }) targetUserId: string,
    @Args('siteId', { type: () => ID }) siteId: string,
  ): Promise<SiteAssignmentResult> {
    return this.tenantAdminService.unassignUserFromSite(
      userId,
      targetUserId,
      siteId,
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

  // =========================================================
  // Tenant auth-security policy + localization preferences (ADR-045)
  //
  // tenantId ALWAYS comes from the caller's JWT — never an argument — so a
  // TENANT_ADMIN can only ever read/write their OWN tenant's policy. A
  // SUPER_ADMIN session without a tenant context is rejected fail-closed.
  // =========================================================

  /**
   * ADR-045: the caller's own tenant is the ONLY addressable tenant on this
   * surface. SUPER_ADMIN JWTs carry tenantId=null — reject rather than guess.
   */
  private requireTenantContext(tenantId: string | null | undefined): string {
    if (!tenantId) {
      throw new BadRequestException(
        'A tenant context is required for tenant policy operations',
      );
    }
    return tenantId;
  }

  /**
   * Effective tenant auth-security policy (ADR-045): enforceMfa collapses
   * NULL → false; sessionTimeoutMinutes stays nullable (null = platform TTL).
   */
  @Query(() => TenantSecurityPolicy)
  @TenantAdminOrHigher()
  async tenantSecurityPolicy(
    @CurrentUser() currentUser: { tenantId: string | null },
  ): Promise<TenantSecurityPolicy> {
    return this.tenantAdminService.getSecurityPolicy(
      this.requireTenantContext(currentUser.tenantId),
    );
  }

  /**
   * ADR-045 policy write. enforceMfa flip false/NULL→true revokes the refresh
   * tokens of this tenant's non-MFA users (see TenantAdminService); a
   * sessionTimeoutMinutes reduction applies on the next token rotation.
   */
  @Mutation(() => TenantSecurityPolicy)
  @TenantAdminOrHigher()
  async updateTenantSecurityPolicy(
    @CurrentUser() currentUser: { sub: string; tenantId: string | null },
    @Args('input') input: UpdateTenantSecurityPolicyInput,
  ): Promise<TenantSecurityPolicy> {
    return this.tenantAdminService.updateSecurityPolicy(
      currentUser.sub,
      this.requireTenantContext(currentUser.tenantId),
      input,
    );
  }

  /**
   * Tenant localization preferences (ADR-045 — separate from security).
   */
  @Query(() => TenantLocalizationPreferences)
  @TenantAdminOrHigher()
  async tenantLocalizationPreferences(
    @CurrentUser() currentUser: { tenantId: string | null },
  ): Promise<TenantLocalizationPreferences> {
    return this.tenantAdminService.getLocalizationPreferences(
      this.requireTenantContext(currentUser.tenantId),
    );
  }

  @Mutation(() => TenantLocalizationPreferences)
  @TenantAdminOrHigher()
  async updateTenantLocalizationPreferences(
    @CurrentUser() currentUser: { sub: string; tenantId: string | null },
    @Args('input') input: UpdateTenantLocalizationPreferencesInput,
  ): Promise<TenantLocalizationPreferences> {
    return this.tenantAdminService.updateLocalizationPreferences(
      currentUser.sub,
      this.requireTenantContext(currentUser.tenantId),
      input,
    );
  }

  /**
   * ORPHAN-MEDIUM-320: clear a failed-login lockout for a user in this
   * tenant. See TenantAdminService.unlockUser for the trust rationale
   * (admin targets allowed — lockout recovery requires a peer).
   */
  @Mutation(() => User)
  @TenantAdminOrHigher()
  async unlockTenantUser(
    @CurrentUser('sub') userId: string,
    @Args('userId', { type: () => ID }) targetUserId: string,
  ): Promise<User> {
    return this.tenantAdminService.unlockUser(userId, targetUserId);
  }
}
