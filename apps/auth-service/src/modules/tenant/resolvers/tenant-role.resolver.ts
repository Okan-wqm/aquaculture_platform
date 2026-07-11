import { BadRequestException } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { CurrentUser, RequireTenantPermission } from '@aquaculture/backend-common/decorators';
import GraphQLJSON from 'graphql-type-json';

import { User } from '../../authentication/entities/user.entity';

/**
 * UUID v4 regex for parameter validation
 * Prevents injection attacks through malformed IDs
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate UUID format to prevent injection attacks
 */
function validateUUID(value: string, fieldName: string): string {
  if (!value || !UUID_REGEX.test(value)) {
    throw new BadRequestException(`Invalid UUID format for ${fieldName}`);
  }
  return value.toLowerCase();
}

/**
 * Sanitize string input to prevent XSS
 * Escapes HTML entities and removes dangerous characters
 */
function sanitizeString(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  // Remove null bytes
  let sanitized = value.replace(/\0/g, '');

  // Escape HTML entities to prevent XSS
  sanitized = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');

  // Trim whitespace
  sanitized = sanitized.trim();

  return sanitized;
}
import {
  TenantRole,
  TenantRolePermissions,
  PermissionCategory,
  PermissionResource,
  CreateTenantRoleInput,
  UpdateTenantRoleInput,
  UserRoleAssignment,
  AssignUserRoleInput,
  UpdateUserRoleInput,
  EffectivePermissions,
  BulkAssignRoleInput,
  BulkAssignResult,
  CreateTenantUserInput,
  CreatedTenantUserResult,
  UpdateTenantUserInput,
  RevokeUserRoleInput,
} from '../dto/tenant-role.dto';
import { TenantRoleService, PERMISSION_CATEGORIES } from '../services/tenant-role.service';
import { TenantUserManagementService, UserRoleAssignmentResult } from '../services/tenant-user-management.service';

@Resolver(() => TenantRole)
export class TenantRoleResolver {
  constructor(
    private readonly tenantRoleService: TenantRoleService,
    private readonly tenantUserManagementService: TenantUserManagementService,
  ) {}

  // ============================================================================
  // Queries
  // ============================================================================

  /**
   * Get all roles for current tenant
   */
  @RequireTenantPermission('roles:view')
  @Query(() => [TenantRole])
  async tenantRoles(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantRole[]> {
    // Validate tenant ID format
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const roles = await this.tenantRoleService.getTenantRoles(validTenantId);
    return roles.map((role) => this.mapToGraphQL(role));
  }

  /**
   * Get a single role by ID
   */
  @RequireTenantPermission('roles:view')
  @Query(() => TenantRole, { nullable: true })
  async tenantRole(
    @Args('roleId', { type: () => ID }) roleId: string,
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantRole | null> {
    // Validate UUID formats
    const validRoleId = validateUUID(roleId, 'roleId');
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const role = await this.tenantRoleService.getRoleById(validTenantId, validRoleId);
    return role ? this.mapToGraphQL(role) : null;
  }

  /**
   * Get the default role for new users
   */
  @RequireTenantPermission('roles:view')
  @Query(() => TenantRole, { nullable: true })
  async defaultTenantRole(
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<TenantRole | null> {
    // Validate tenant ID format
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const role = await this.tenantRoleService.getDefaultRole(validTenantId);
    return role ? this.mapToGraphQL(role) : null;
  }

  /**
   * Get permission categories for UI
   */
  @RequireTenantPermission('roles:view')
  @Query(() => [PermissionCategory])
  async permissionCategories(): Promise<PermissionCategory[]> {
    const categories = this.tenantRoleService.getPermissionCategories();

    return Object.entries(categories).map(([key, category]) => ({
      categoryKey: key,
      name: category.name,
      resources: Object.entries(category.resources).map(([resourceKey, resource]) => ({
        name: resource.name,
        actions: resource.actions,
      })),
    }));
  }

  // ============================================================================
  // Mutations
  // ============================================================================

  /**
   * Create a new role
   * SECURITY: Only TENANT_ADMIN can create roles
   */
  @RequireTenantPermission('roles:create')
  @Mutation(() => TenantRole)
  async createTenantRole(
    @Args('input') input: CreateTenantRoleInput,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<TenantRole> {
    // Validate UUID formats
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');

    // Sanitize string inputs to prevent XSS
    const sanitizedName = sanitizeString(input.name);
    const sanitizedDescription = sanitizeString(input.description);
    const sanitizedColor = sanitizeString(input.color);
    const sanitizedIcon = sanitizeString(input.icon);

    if (!sanitizedName) {
      throw new BadRequestException('Role name is required');
    }

    const role = await this.tenantRoleService.createRole(
      validTenantId,
      {
        name: sanitizedName,
        description: sanitizedDescription,
        color: sanitizedColor || '#6366F1',
        icon: sanitizedIcon || 'shield',
        level: input.level,
        isDefault: input.isDefault,
        panelPermissions: input.panelPermissions,
      },
      validUserId,
    );
    return this.mapToGraphQL(role);
  }

  /**
   * Update an existing role
   * SECURITY: Only TENANT_ADMIN can update roles
   */
  @RequireTenantPermission('roles:edit')
  @Mutation(() => TenantRole)
  async updateTenantRole(
    @Args('roleId', { type: () => ID }) roleId: string,
    @Args('input') input: UpdateTenantRoleInput,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<TenantRole> {
    // Validate UUID formats
    const validRoleId = validateUUID(roleId, 'roleId');
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');

    // Sanitize string inputs to prevent XSS
    const sanitizedName = sanitizeString(input.name);
    const sanitizedDescription = sanitizeString(input.description);
    const sanitizedColor = sanitizeString(input.color);
    const sanitizedIcon = sanitizeString(input.icon);

    const role = await this.tenantRoleService.updateRole(
      validTenantId,
      validRoleId,
      {
        name: sanitizedName,
        description: sanitizedDescription,
        color: sanitizedColor,
        icon: sanitizedIcon,
        level: input.level,
        isDefault: input.isDefault,
        panelPermissions: input.panelPermissions,
      },
      validUserId,
    );
    return this.mapToGraphQL(role);
  }

  /**
   * Delete a role
   * SECURITY: Only TENANT_ADMIN can delete roles
   */
  @RequireTenantPermission('roles:delete')
  @Mutation(() => Boolean)
  async deleteTenantRole(
    @Args('roleId', { type: () => ID }) roleId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<boolean> {
    // Validate UUID formats
    const validRoleId = validateUUID(roleId, 'roleId');
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');

    return this.tenantRoleService.deleteRole(validTenantId, validRoleId, validUserId);
  }

  /**
   * Seed default roles (for initial setup or reset)
   * SECURITY: Only TENANT_ADMIN can seed roles
   */
  @RequireTenantPermission('roles:create')
  @Mutation(() => [TenantRole])
  async seedTenantRoles(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<TenantRole[]> {
    // Validate UUID formats
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');

    const roles = await this.tenantRoleService.seedDefaultRoles(validTenantId, validUserId);
    return roles.map((role) => this.mapToGraphQL(role));
  }

  // ============================================================================
  // User Role Management Mutations
  // ============================================================================

  /**
   * Create a new user within the tenant and assign initial role
   * SECURITY: Only TENANT_ADMIN can create users
   */
  @RequireTenantPermission('users:invite')
  @Mutation(() => CreatedTenantUserResult)
  async createTenantUser(
    @Args('input') input: CreateTenantUserInput,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<CreatedTenantUserResult> {
    // Validate UUID formats
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');
    const validRoleId = validateUUID(input.roleId, 'roleId');

    // Sanitize string inputs to prevent XSS
    const sanitizedFirstName = sanitizeString(input.firstName);
    const sanitizedLastName = sanitizeString(input.lastName);
    const sanitizedEmail = input.email?.toLowerCase().trim();

    if (!sanitizedFirstName || !sanitizedLastName || !sanitizedEmail) {
      throw new BadRequestException('First name, last name, and email are required');
    }

    // WHY: Pass accessType through to the service layer so UserLifecycleService
    // can set the correct platform access level and auto-provision mobile settings.
    const result = await this.tenantUserManagementService.createTenantUser(
      validTenantId,
      {
        firstName: sanitizedFirstName,
        lastName: sanitizedLastName,
        email: sanitizedEmail,
        password: input.password,
        roleId: validRoleId,
        permissionOverrides: input.permissionOverrides,
        accessType: input.accessType,
      },
      validUserId,
      input.sendInvitation !== false, // Default to true
    );

    return {
      userId: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName || null,
      lastName: result.user.lastName || null,
      roleAssignment: this.mapRoleAssignmentToGraphQL(result.roleAssignment),
      invitationSent: result.invitationSent,
      createdAt: result.user.createdAt,
    };
  }

  /**
   * Update a tenant user's profile (firstName, lastName) and/or role assignment
   * SECURITY: Only TENANT_ADMIN can update users
   */
  @RequireTenantPermission('users:edit_permissions')
  @Mutation(() => User)
  async updateTenantUser(
    @Args('userId', { type: () => ID }) targetUserId: string,
    @Args('input') input: UpdateTenantUserInput,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<User> {
    // Validate UUID formats
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');
    const validTargetUserId = validateUUID(targetUserId, 'userId');
    const validRoleId = input.roleId ? validateUUID(input.roleId, 'roleId') : undefined;

    // Sanitize string inputs to prevent XSS
    const sanitizedFirstName = sanitizeString(input.firstName);
    const sanitizedLastName = sanitizeString(input.lastName);

    // WHY: Pass accessType so tenant admin can change platform access level on edit.
    // Service layer handles mobile settings provisioning/deactivation accordingly.
    return this.tenantUserManagementService.updateTenantUser(
      validTenantId,
      validTargetUserId,
      {
        firstName: sanitizedFirstName,
        lastName: sanitizedLastName,
        roleId: validRoleId,
        accessType: input.accessType,
      },
      validUserId,
    );
  }

  /**
   * Delete (soft-delete) a tenant user
   * Deactivates the user, revokes role assignments and refresh tokens.
   * SECURITY: Only TENANT_ADMIN can delete users
   */
  @RequireTenantPermission('users:deactivate')
  @Mutation(() => Boolean)
  async deleteTenantUser(
    @Args('userId', { type: () => ID }) targetUserId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<boolean> {
    // Validate UUID formats
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');
    const validTargetUserId = validateUUID(targetUserId, 'userId');

    return this.tenantUserManagementService.deleteTenantUser(
      validTenantId,
      validTargetUserId,
      validUserId,
    );
  }

  /**
   * Assign a role to an existing user
   * SECURITY: Only TENANT_ADMIN can assign roles
   */
  @RequireTenantPermission('users:edit_permissions')
  @Mutation(() => UserRoleAssignment)
  async assignUserRole(
    @Args('userId', { type: () => ID }) targetUserId: string,
    @Args('input') input: AssignUserRoleInput,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<UserRoleAssignment> {
    // Validate UUID formats
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');
    const validTargetUserId = validateUUID(targetUserId, 'userId');
    const validRoleId = validateUUID(input.roleId, 'roleId');

    const result = await this.tenantUserManagementService.assignUserRole(
      validTenantId,
      validTargetUserId,
      {
        roleId: validRoleId,
        permissionOverrides: input.permissionOverrides,
        expiresAt: input.expiresAt,
      },
      validUserId,
    );

    return this.mapRoleAssignmentToGraphQL(result);
  }

  /**
   * Update a user's role assignment
   * SECURITY: Only TENANT_ADMIN can update role assignments
   */
  @RequireTenantPermission('users:edit_permissions')
  @Mutation(() => UserRoleAssignment)
  async updateUserRole(
    @Args('userId', { type: () => ID }) targetUserId: string,
    @Args('input') input: UpdateUserRoleInput,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<UserRoleAssignment> {
    // Validate UUID formats
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');
    const validTargetUserId = validateUUID(targetUserId, 'userId');
    const validRoleId = input.roleId ? validateUUID(input.roleId, 'roleId') : undefined;

    const result = await this.tenantUserManagementService.updateUserRole(
      validTenantId,
      validTargetUserId,
      {
        roleId: validRoleId,
        permissionOverrides: input.permissionOverrides,
        expiresAt: input.expiresAt,
        isActive: input.isActive,
      },
      validUserId,
    );

    return this.mapRoleAssignmentToGraphQL(result);
  }

  /**
   * Revoke a user's role (soft delete or hard delete)
   * SECURITY: Only TENANT_ADMIN can revoke roles
   */
  @RequireTenantPermission('users:edit_permissions')
  @Mutation(() => Boolean)
  async revokeUserRole(
    @Args('input') input: RevokeUserRoleInput,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<boolean> {
    // Validate UUID formats
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');
    const validTargetUserId = validateUUID(input.userId, 'userId');

    return this.tenantUserManagementService.revokeUserRole(
      validTenantId,
      validTargetUserId,
      input.hardDelete ?? false,
      validUserId,
    );
  }

  /**
   * Bulk assign a role to multiple users
   * SECURITY: Only TENANT_ADMIN can bulk assign roles
   */
  @RequireTenantPermission('users:edit_permissions')
  @Mutation(() => BulkAssignResult)
  async bulkAssignUserRole(
    @Args('input') input: BulkAssignRoleInput,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<BulkAssignResult> {
    // Validate UUID formats
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validUserId = validateUUID(userId, 'userId');
    const validRoleId = validateUUID(input.roleId, 'roleId');
    const validUserIds = input.userIds.map((id) => validateUUID(id, 'userId'));

    const result = await this.tenantUserManagementService.bulkAssignRole(
      validTenantId,
      validUserIds,
      validRoleId,
      validUserId,
    );

    return {
      success: result.success,
      failed: result.failed.map((f) => ({
        userId: f.userId,
        error: f.error,
      })),
    };
  }

  /**
   * Get a user's effective permissions (role + overrides)
   */
  @RequireTenantPermission('users:view')
  @Query(() => EffectivePermissions)
  async getUserEffectivePermissions(
    @Args('userId', { type: () => ID }) targetUserId: string,
    @CurrentUser('tenantId') tenantId: string,
  ): Promise<EffectivePermissions> {
    // Validate UUID formats
    const validTenantId = validateUUID(tenantId, 'tenantId');
    const validTargetUserId = validateUUID(targetUserId, 'userId');

    const result = await this.tenantUserManagementService.getUserEffectivePermissions(
      validTenantId,
      validTargetUserId,
    );

    return {
      roleId: result.roleId,
      roleName: result.roleName,
      panelPermissions: result.panelPermissions,
      resourcePermissions: result.resourcePermissions,
      overrides: result.overrides,
    };
  }

  /**
   * Map service result to GraphQL type
   */
  private mapToGraphQL(role: {
    id: string;
    name: string;
    description: string | null;
    color: string;
    icon: string;
    level: number;
    isSystem: boolean;
    isDefault: boolean;
    userCount: number;
    permissions: {
      id: string;
      roleId: string;
      panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
      resourcePermissions: string[];
    } | null;
    createdAt: Date;
    updatedAt: Date;
  }): TenantRole {
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      color: role.color,
      icon: role.icon,
      level: role.level,
      isSystem: role.isSystem,
      isDefault: role.isDefault,
      userCount: role.userCount,
      permissions: role.permissions
        ? {
            id: role.permissions.id,
            roleId: role.permissions.roleId,
            panelPermissions: role.permissions.panelPermissions,
            resourcePermissions: role.permissions.resourcePermissions,
          }
        : null,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }

  /**
   * Map UserRoleAssignmentResult to GraphQL UserRoleAssignment type
   */
  private mapRoleAssignmentToGraphQL(assignment: UserRoleAssignmentResult): UserRoleAssignment {
    return {
      id: assignment.id,
      userId: assignment.userId,
      roleId: assignment.roleId,
      roleName: assignment.roleName,
      roleColor: assignment.roleColor,
      roleIcon: assignment.roleIcon,
      roleLevel: assignment.roleLevel,
      permissionOverrides: {
        grants: assignment.permissionOverrides.grants,
        revokes: assignment.permissionOverrides.revokes,
      },
      panelPermissions: assignment.panelPermissions,
      resourcePermissions: assignment.resourcePermissions,
      effectivePermissions: assignment.effectivePermissions,
      isActive: assignment.isActive,
      expiresAt: assignment.expiresAt,
      assignedAt: assignment.assignedAt,
      assignedBy: assignment.assignedBy,
    };
  }
}
