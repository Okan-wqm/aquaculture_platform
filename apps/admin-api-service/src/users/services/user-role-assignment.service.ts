import { Injectable, Logger, NotFoundException, ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { SchemaManagerService } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';

import { PanelPermissions, panelPermissionsToResourceArray } from '../entities/tenant-role-permissions.entity';
import {
  UserRoleAssignment,
  PermissionOverrides,
  EffectivePermissions,
  computeEffectivePermissions,
} from '../entities/user-role-assignment.entity';

import { TenantRoleService } from './tenant-role.service';

/**
 * Input for assigning a role to a user
 */
export interface AssignUserRoleInput {
  roleId: string;
  permissionOverrides?: PermissionOverrides;
  expiresAt?: Date;
}

/**
 * Input for updating a user's role assignment
 */
export interface UpdateUserRoleInput {
  roleId?: string;
  permissionOverrides?: PermissionOverrides;
  expiresAt?: Date | null; // null to remove expiration
  isActive?: boolean;
}

/**
 * User Role Assignment with role details
 */
export interface UserRoleAssignmentWithDetails extends UserRoleAssignment {
  roleName: string;
  roleColor: string;
  roleIcon: string;
  roleLevel: number;
  panelPermissions: PanelPermissions;
  resourcePermissions: string[];
}

/**
 * User Role Assignment Service
 * Manages user-role assignments in tenant schemas
 */
@Injectable()
export class UserRoleAssignmentService {
  private readonly logger = new Logger(UserRoleAssignmentService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly schemaManager: SchemaManagerService,
    private readonly tenantRoleService: TenantRoleService,
  ) {}

  /**
   * HIGH-002 fix: Assert that a schema name matches the safe pattern
   * before it is interpolated into any SQL query.
   * getTenantSchemaName() already validates UUID format; this is a
   * defence-in-depth check at the SQL usage site.
   */
  private assertSafeSchemaName(schemaName: string): void {
    if (!/^tenant_[0-9a-f]{16}$/.test(schemaName)) {
      throw new BadRequestException(
        `SECURITY: Unexpected schema name format: "${schemaName}". Aborting SQL execution.`,
      );
    }
  }

  /**
   * Get role assignment for a user
   */
  async getUserRoleAssignment(
    tenantId: string,
    userId: string,
  ): Promise<UserRoleAssignmentWithDetails | null> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    this.assertSafeSchemaName(schemaName);

    const result = await this.dataSource.query(
      `
      SELECT
        a.*,
        r.name as role_name,
        r.color as role_color,
        r.icon as role_icon,
        r.level as role_level,
        p.panel_permissions,
        p.resource_permissions
      FROM "${schemaName}"."user_role_assignments" a
      JOIN "${schemaName}"."tenant_roles" r ON a.role_id = r.id
      LEFT JOIN "${schemaName}"."tenant_role_permissions" p ON a.role_id = p.role_id
      WHERE a.user_id = $1 AND a.is_active = true
      `,
      [userId],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToAssignment(result[0]);
  }

  /**
   * Get all role assignments for a tenant
   */
  async getAllAssignments(tenantId: string): Promise<UserRoleAssignmentWithDetails[]> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    this.assertSafeSchemaName(schemaName);

    // Check if table exists
    const tableExists = await this.schemaManager.tableExists(schemaName, 'user_role_assignments');
    if (!tableExists) {
      return [];
    }

    const result = await this.dataSource.query(
      `
      SELECT
        a.*,
        r.name as role_name,
        r.color as role_color,
        r.icon as role_icon,
        r.level as role_level,
        p.panel_permissions,
        p.resource_permissions
      FROM "${schemaName}"."user_role_assignments" a
      JOIN "${schemaName}"."tenant_roles" r ON a.role_id = r.id
      LEFT JOIN "${schemaName}"."tenant_role_permissions" p ON a.role_id = p.role_id
      ORDER BY r.level DESC, a.assigned_at DESC
      `,
    );

    return result.map((row: Record<string, unknown>) => this.mapRowToAssignment(row));
  }

  /**
   * Assign a role to a user
   */
  async assignRole(
    tenantId: string,
    userId: string,
    input: AssignUserRoleInput,
    assignedBy: string,
  ): Promise<UserRoleAssignmentWithDetails> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    this.assertSafeSchemaName(schemaName);

    // Verify role exists
    const role = await this.tenantRoleService.getRoleById(tenantId, input.roleId);
    if (!role) {
      throw new NotFoundException(`Role with ID "${input.roleId}" not found`);
    }

    // Check if user already has an assignment
    const existing = await this.getUserRoleAssignment(tenantId, userId);
    if (existing) {
      throw new ConflictException(
        `User already has role "${existing.roleName}" assigned. Use updateAssignment to change it.`,
      );
    }

    // Validate permission overrides
    const overrides = input.permissionOverrides || { grants: [], revokes: [] };
    this.validatePermissionOverrides(overrides);

    // Create assignment
    await this.dataSource.query(
      `
      INSERT INTO "${schemaName}"."user_role_assignments" (
        user_id, role_id, permission_overrides, assigned_by, assigned_at, expires_at, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, NOW(), $5, true, NOW(), NOW())
      `,
      [userId, input.roleId, JSON.stringify(overrides), assignedBy, input.expiresAt || null],
    );

    this.logger.log(
      `Assigned role "${role.name}" to user ${userId} in tenant ${tenantId} by ${assignedBy}`,
    );

    const assignment = await this.getUserRoleAssignment(tenantId, userId);
    if (!assignment) {
      throw new Error('Failed to retrieve created assignment');
    }
    return assignment;
  }

  /**
   * Update a user's role assignment
   */
  async updateAssignment(
    tenantId: string,
    userId: string,
    input: UpdateUserRoleInput,
    updatedBy: string,
  ): Promise<UserRoleAssignmentWithDetails> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    this.assertSafeSchemaName(schemaName);

    // Get existing assignment
    const existing = await this.getUserRoleAssignment(tenantId, userId);
    if (!existing) {
      throw new NotFoundException(`No role assignment found for user ${userId}`);
    }

    // If changing role, verify new role exists
    if (input.roleId && input.roleId !== existing.roleId) {
      const newRole = await this.tenantRoleService.getRoleById(tenantId, input.roleId);
      if (!newRole) {
        throw new NotFoundException(`Role with ID "${input.roleId}" not found`);
      }
    }

    // Validate permission overrides if provided
    if (input.permissionOverrides) {
      this.validatePermissionOverrides(input.permissionOverrides);
    }

    // Build update query
    const updateFields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.roleId !== undefined) {
      updateFields.push(`role_id = $${paramIndex++}`);
      values.push(input.roleId);
    }
    if (input.permissionOverrides !== undefined) {
      updateFields.push(`permission_overrides = $${paramIndex++}`);
      values.push(JSON.stringify(input.permissionOverrides));
    }
    if (input.expiresAt !== undefined) {
      updateFields.push(`expires_at = $${paramIndex++}`);
      values.push(input.expiresAt);
    }
    if (input.isActive !== undefined) {
      updateFields.push(`is_active = $${paramIndex++}`);
      values.push(input.isActive);
    }

    updateFields.push(`updated_at = NOW()`);
    values.push(userId);

    await this.dataSource.query(
      `UPDATE "${schemaName}"."user_role_assignments" SET ${updateFields.join(', ')} WHERE user_id = $${paramIndex}`,
      values,
    );

    this.logger.log(
      `Updated role assignment for user ${userId} in tenant ${tenantId} by ${updatedBy}`,
    );

    const updated = await this.getUserRoleAssignment(tenantId, userId);
    if (!updated) {
      throw new Error('Failed to retrieve updated assignment');
    }
    return updated;
  }

  /**
   * Revoke a user's role assignment
   */
  async revokeAssignment(
    tenantId: string,
    userId: string,
    revokedBy: string,
  ): Promise<boolean> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    this.assertSafeSchemaName(schemaName);

    // Get existing assignment
    const existing = await this.getUserRoleAssignment(tenantId, userId);
    if (!existing) {
      throw new NotFoundException(`No role assignment found for user ${userId}`);
    }

    // Delete the assignment
    await this.dataSource.query(
      `DELETE FROM "${schemaName}"."user_role_assignments" WHERE user_id = $1`,
      [userId],
    );

    this.logger.log(
      `Revoked role "${existing.roleName}" from user ${userId} in tenant ${tenantId} by ${revokedBy}`,
    );

    return true;
  }

  /**
   * Get effective permissions for a user
   * Merges role permissions with individual overrides
   */
  async getEffectivePermissions(
    tenantId: string,
    userId: string,
  ): Promise<EffectivePermissions | null> {
    const assignment = await this.getUserRoleAssignment(tenantId, userId);
    if (!assignment) {
      return null;
    }

    // Check if assignment is valid
    if (!assignment.isActive) {
      return null;
    }
    if (assignment.expiresAt && new Date() > assignment.expiresAt) {
      return null;
    }

    // Compute effective permissions
    const effectiveResourcePermissions = computeEffectivePermissions(
      assignment.resourcePermissions,
      assignment.permissionOverrides,
    );

    return {
      roleId: assignment.roleId,
      roleName: assignment.roleName,
      panelPermissions: { [assignment.roleName]: assignment.panelPermissions } as EffectivePermissions['panelPermissions'],
      resourcePermissions: effectiveResourcePermissions,
      overrides: assignment.permissionOverrides,
    };
  }

  /**
   * Assign default role to a new user
   */
  async assignDefaultRole(
    tenantId: string,
    userId: string,
    assignedBy: string,
  ): Promise<UserRoleAssignmentWithDetails | null> {
    // Get the default role
    const defaultRole = await this.tenantRoleService.getDefaultRole(tenantId);
    if (!defaultRole) {
      this.logger.warn(`No default role found for tenant ${tenantId}`);
      return null;
    }

    return this.assignRole(tenantId, userId, { roleId: defaultRole.id }, assignedBy);
  }

  /**
   * Bulk assign role to multiple users
   */
  async bulkAssignRole(
    tenantId: string,
    userIds: string[],
    roleId: string,
    assignedBy: string,
  ): Promise<{ success: string[]; failed: { userId: string; error: string }[] }> {
    const success: string[] = [];
    const failed: { userId: string; error: string }[] = [];

    for (const userId of userIds) {
      try {
        // Check if user already has assignment
        const existing = await this.getUserRoleAssignment(tenantId, userId);
        if (existing) {
          // Update existing assignment
          await this.updateAssignment(tenantId, userId, { roleId }, assignedBy);
        } else {
          // Create new assignment
          await this.assignRole(tenantId, userId, { roleId }, assignedBy);
        }
        success.push(userId);
      } catch (error) {
        failed.push({ userId, error: (error as Error).message });
      }
    }

    this.logger.log(
      `Bulk role assignment: ${success.length} successful, ${failed.length} failed`,
    );

    return { success, failed };
  }

  /**
   * Check if user has a specific permission
   */
  async hasPermission(
    tenantId: string,
    userId: string,
    resource: string,
    action: string,
  ): Promise<boolean> {
    return this.tenantRoleService.userHasPermission(tenantId, userId, resource, action);
  }

  /**
   * Validate permission overrides format
   */
  private validatePermissionOverrides(overrides: PermissionOverrides): void {
    if (!Array.isArray(overrides.grants)) {
      throw new Error('Permission overrides grants must be an array');
    }
    if (!Array.isArray(overrides.revokes)) {
      throw new Error('Permission overrides revokes must be an array');
    }

    // Validate format of permission strings (resource:action)
    const permissionRegex = /^[a-z_]+:[a-z_]+$/;
    for (const grant of overrides.grants) {
      if (!permissionRegex.test(grant)) {
        throw new Error(`Invalid permission format: ${grant}. Expected format: resource:action`);
      }
    }
    for (const revoke of overrides.revokes) {
      if (!permissionRegex.test(revoke)) {
        throw new Error(`Invalid permission format: ${revoke}. Expected format: resource:action`);
      }
    }
  }

  /**
   * Map database row to UserRoleAssignmentWithDetails
   */
  private mapRowToAssignment(row: Record<string, unknown>): UserRoleAssignmentWithDetails {
    const panelPermissions = typeof row.panel_permissions === 'string'
      ? JSON.parse(row.panel_permissions)
      : (row.panel_permissions as PanelPermissions) || {};

    const permissionOverrides = typeof row.permission_overrides === 'string'
      ? JSON.parse(row.permission_overrides)
      : (row.permission_overrides as PermissionOverrides) || { grants: [], revokes: [] };

    return {
      id: row.id as string,
      userId: row.user_id as string,
      roleId: row.role_id as string,
      permissionOverrides,
      assignedBy: row.assigned_by as string,
      assignedAt: row.assigned_at as Date,
      expiresAt: row.expires_at as Date | undefined,
      isActive: row.is_active as boolean,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
      role: null!,
      roleName: row.role_name as string,
      roleColor: row.role_color as string,
      roleIcon: row.role_icon as string,
      roleLevel: row.role_level as number,
      panelPermissions,
      resourcePermissions: (row.resource_permissions as string[]) || [],
      isExpired: function() {
        if (!this.expiresAt) return false;
        return new Date() > this.expiresAt;
      },
      isValid: function() {
        return this.isActive && !this.isExpired();
      },
    };
  }
}
