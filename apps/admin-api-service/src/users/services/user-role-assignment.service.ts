import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  AUTH_ADMIN_COMMAND_SUBJECTS,
  type AdminAssignUserRoleCommand,
  type AdminRevokeUserRoleAssignmentCommand,
  type AdminUpdateUserRoleAssignmentCommand,
  type AdminUserRoleAssignmentMutationResult,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';
import { AuthCommandClientService } from '../../auth/auth-command-client.service';

import { PanelPermissions } from '../entities/tenant-role-permissions.entity';
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
export type UserRoleAssignmentWithDetails = Omit<UserRoleAssignment, 'role'> & {
  roleName: string;
  roleColor: string;
  roleIcon: string;
  roleLevel: number;
  panelPermissions: PanelPermissions;
  resourcePermissions: string[];
};

type QueryRow = Record<string, unknown>;

async function queryRows<T extends QueryRow>(
  dataSource: DataSource,
  sql: string,
  parameters?: unknown[],
): Promise<T[]> {
  const result: unknown = await dataSource.query(sql, parameters);
  return Array.isArray(result) ? (result as T[]) : [];
}

function parsePanelPermissions(value: unknown): PanelPermissions {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  }
  return value && typeof value === 'object' ? value : {};
}

function parsePermissionOverrides(value: unknown): PermissionOverrides {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== 'object') {
    return { grants: [], revokes: [] };
  }
  const candidate = parsed as { grants?: unknown; revokes?: unknown };
  return {
    grants: parseStringArray(candidate.grants),
    revokes: parseStringArray(candidate.revokes),
  };
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function rowString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rowBoolean(value: unknown): boolean {
  return value === true;
}

function rowNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function rowDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * User Role Assignment Service
 * Manages user-role assignments in auth.* with tenantId scoping through roles.
 */
@Injectable()
export class UserRoleAssignmentService {
  private readonly logger = new Logger(UserRoleAssignmentService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tenantRoleService: TenantRoleService,
    private readonly authCommandClient: AuthCommandClientService,
  ) {}

  /**
   * Get role assignment for a user
   */
  async getUserRoleAssignment(
    tenantId: string,
    userId: string,
  ): Promise<UserRoleAssignmentWithDetails | null> {
    const result = await queryRows<QueryRow>(
      this.dataSource,
      `
      SELECT
        a.*,
        r.name as role_name,
        r.color as role_color,
        r.icon as role_icon,
        r.level as role_level,
        p.panel_permissions,
        p.resource_permissions
      FROM "auth"."user_role_assignments" a
      JOIN "auth"."tenant_roles" r ON a.role_id = r.id
      LEFT JOIN "auth"."tenant_role_permissions" p ON a.role_id = p.role_id
      WHERE r."tenantId" = $1 AND a.user_id = $2 AND a.is_active = true
      `,
      [tenantId, userId],
    );

    const [row] = result;
    if (!row) {
      return null;
    }

    return this.mapRowToAssignment(row);
  }

  /**
   * Get all role assignments for a tenant
   */
  async getAllAssignments(tenantId: string): Promise<UserRoleAssignmentWithDetails[]> {
    const result = await queryRows<QueryRow>(
      this.dataSource,
      `
      SELECT
        a.*,
        r.name as role_name,
        r.color as role_color,
        r.icon as role_icon,
        r.level as role_level,
        p.panel_permissions,
        p.resource_permissions
      FROM "auth"."user_role_assignments" a
      JOIN "auth"."tenant_roles" r ON a.role_id = r.id
      LEFT JOIN "auth"."tenant_role_permissions" p ON a.role_id = p.role_id
      WHERE r."tenantId" = $1
      ORDER BY r.level DESC, a.assigned_at DESC
      `,
      [tenantId],
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

    const result = await this.authCommandClient.request<
      AdminAssignUserRoleCommand,
      AdminUserRoleAssignmentMutationResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.ASSIGN_USER_ROLE, {
      tenantId,
      userId,
      roleId: input.roleId,
      permissionOverrides: overrides,
      expiresAt: input.expiresAt?.toISOString() ?? null,
      assignedBy,
    });
    this.authCommandClient.assertSuccess(result, `Could not assign role ${input.roleId}`);

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

    const result = await this.authCommandClient.request<
      AdminUpdateUserRoleAssignmentCommand,
      AdminUserRoleAssignmentMutationResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_USER_ROLE_ASSIGNMENT, {
      tenantId,
      userId,
      roleId: input.roleId,
      permissionOverrides: input.permissionOverrides,
      expiresAt: input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt,
      isActive: input.isActive,
      updatedBy,
    });
    this.authCommandClient.assertSuccess(result, `Could not update role assignment for ${userId}`);

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
    // Get existing assignment
    const existing = await this.getUserRoleAssignment(tenantId, userId);
    if (!existing) {
      throw new NotFoundException(`No role assignment found for user ${userId}`);
    }

    const result = await this.authCommandClient.request<
      AdminRevokeUserRoleAssignmentCommand,
      AdminUserRoleAssignmentMutationResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.REVOKE_USER_ROLE_ASSIGNMENT, {
      tenantId,
      userId,
      revokedBy,
    });
    this.authCommandClient.assertSuccess(result, `Could not revoke role assignment for ${userId}`);

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
    const panelPermissions = parsePanelPermissions(row.panel_permissions);
    const permissionOverrides = parsePermissionOverrides(row.permission_overrides);

    return {
      id: rowString(row.id),
      userId: rowString(row.user_id),
      roleId: rowString(row.role_id),
      permissionOverrides,
      assignedBy: rowString(row.assigned_by),
      assignedAt: rowDate(row.assigned_at),
      expiresAt: row.expires_at ? rowDate(row.expires_at) : undefined,
      isActive: rowBoolean(row.is_active),
      createdAt: rowDate(row.created_at),
      updatedAt: rowDate(row.updated_at),
      roleName: rowString(row.role_name),
      roleColor: rowString(row.role_color),
      roleIcon: rowString(row.role_icon),
      roleLevel: rowNumber(row.role_level),
      panelPermissions,
      resourcePermissions: parseStringArray(row.resource_permissions),
      isExpired: function(): boolean {
        if (!this.expiresAt) return false;
        return new Date() > this.expiresAt;
      },
      isValid: function(): boolean {
        return this.isActive && !this.isExpired();
      },
    };
  }
}
