import { Injectable, Logger, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { SchemaManagerService } from '@platform/backend-common';
import { DataSource } from 'typeorm';

import {
  TenantRolePermissions,
  PanelPermissions,
  DEFAULT_ROLE_PERMISSIONS,
  panelPermissionsToResourceArray,
  PERMISSION_CATEGORIES,
} from '../entities/tenant-role-permissions.entity';
import {
  TenantRole,
  DEFAULT_TENANT_ROLES,
} from '../entities/tenant-role.entity';

/**
 * Input for creating a tenant role
 */
export interface CreateTenantRoleInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  level?: number;
  isDefault?: boolean;
  panelPermissions: PanelPermissions;
}

/**
 * Input for updating a tenant role
 */
export interface UpdateTenantRoleInput {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  level?: number;
  isDefault?: boolean;
  panelPermissions?: PanelPermissions;
}

/**
 * Tenant Role with permissions and user count
 */
export interface TenantRoleWithDetails extends TenantRole {
  permissions: TenantRolePermissions;
  userCount: number;
}

/**
 * Tenant Role Service
 * Manages tenant-specific roles stored in tenant schemas
 */
@Injectable()
export class TenantRoleService {
  private readonly logger = new Logger(TenantRoleService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly schemaManager: SchemaManagerService,
  ) {}

  /**
   * Get all roles for a tenant
   */
  async getTenantRoles(tenantId: string): Promise<TenantRoleWithDetails[]> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // Check if schema exists and has the roles table
    const tableExists = await this.schemaManager.tableExists(schemaName, 'tenant_roles');
    if (!tableExists) {
      this.logger.warn(`tenant_roles table does not exist in schema ${schemaName}`);
      return [];
    }

    const roles = await this.dataSource.query(
      `
      SELECT
        r.*,
        p.id as permission_id,
        p.panel_permissions,
        p.resource_permissions,
        COALESCE(uc.user_count, 0)::int as user_count
      FROM "${schemaName}"."tenant_roles" r
      LEFT JOIN "${schemaName}"."tenant_role_permissions" p ON r.id = p.role_id
      LEFT JOIN (
        SELECT role_id, COUNT(*)::int as user_count
        FROM "${schemaName}"."user_role_assignments"
        WHERE is_active = true
        GROUP BY role_id
      ) uc ON r.id = uc.role_id
      ORDER BY r.level DESC, r.name ASC
      `,
    );

    return roles.map((row: Record<string, unknown>) => this.mapRowToRole(row));
  }

  /**
   * Get a single role by ID
   */
  async getRoleById(tenantId: string, roleId: string): Promise<TenantRoleWithDetails | null> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    const result = await this.dataSource.query(
      `
      SELECT
        r.*,
        p.id as permission_id,
        p.panel_permissions,
        p.resource_permissions,
        COALESCE(uc.user_count, 0)::int as user_count
      FROM "${schemaName}"."tenant_roles" r
      LEFT JOIN "${schemaName}"."tenant_role_permissions" p ON r.id = p.role_id
      LEFT JOIN (
        SELECT role_id, COUNT(*)::int as user_count
        FROM "${schemaName}"."user_role_assignments"
        WHERE is_active = true
        GROUP BY role_id
      ) uc ON r.id = uc.role_id
      WHERE r.id = $1
      `,
      [roleId],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToRole(result[0]);
  }

  /**
   * Get the default role for a tenant
   */
  async getDefaultRole(tenantId: string): Promise<TenantRoleWithDetails | null> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    const result = await this.dataSource.query(
      `
      SELECT
        r.*,
        p.id as permission_id,
        p.panel_permissions,
        p.resource_permissions,
        0 as user_count
      FROM "${schemaName}"."tenant_roles" r
      LEFT JOIN "${schemaName}"."tenant_role_permissions" p ON r.id = p.role_id
      WHERE r.is_default = true
      LIMIT 1
      `,
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToRole(result[0]);
  }

  /**
   * Create a new tenant role
   */
  async createRole(
    tenantId: string,
    input: CreateTenantRoleInput,
    createdBy: string,
  ): Promise<TenantRoleWithDetails> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // Check for duplicate name
    const existing = await this.dataSource.query(
      `SELECT id FROM "${schemaName}"."tenant_roles" WHERE LOWER(name) = LOWER($1)`,
      [input.name],
    );

    if (existing.length > 0) {
      throw new ConflictException(`Role with name "${input.name}" already exists`);
    }

    // BUG-027 fix: wrap role + permissions insert in a transaction so an orphaned
    // role record cannot be left without permissions if the second INSERT fails.
    const roleId = await this.dataSource.transaction(async (manager) => {
      // If this is set as default, unset other defaults
      if (input.isDefault) {
        await manager.query(
          `UPDATE "${schemaName}"."tenant_roles" SET is_default = false WHERE is_default = true`,
        );
      }

      // Create the role
      const roleResult = await manager.query(
        `
        INSERT INTO "${schemaName}"."tenant_roles" (
          name, description, color, icon, level, is_system, is_default, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, false, $6, $7, NOW(), NOW())
        RETURNING id
        `,
        [
          input.name,
          input.description || null,
          input.color || '#6366F1',
          input.icon || 'shield',
          input.level ?? 50,
          input.isDefault ?? false,
          createdBy,
        ],
      );

      const newRoleId = roleResult[0].id;

      // Create role permissions
      const resourcePermissions = panelPermissionsToResourceArray(input.panelPermissions);

      await manager.query(
        `
        INSERT INTO "${schemaName}"."tenant_role_permissions" (
          role_id, panel_permissions, resource_permissions, created_at, updated_at
        ) VALUES ($1, $2, $3, NOW(), NOW())
        `,
        [newRoleId, JSON.stringify(input.panelPermissions), resourcePermissions],
      );

      return newRoleId;
    });

    this.logger.log(`Created role "${input.name}" in tenant ${tenantId}`);

    const createdRole = await this.getRoleById(tenantId, roleId);
    if (!createdRole) {
      throw new Error('Failed to retrieve created role');
    }
    return createdRole;
  }

  /**
   * Update a tenant role
   */
  async updateRole(
    tenantId: string,
    roleId: string,
    input: UpdateTenantRoleInput,
    updatedBy: string,
  ): Promise<TenantRoleWithDetails> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // Get existing role
    const existing = await this.getRoleById(tenantId, roleId);
    if (!existing) {
      throw new NotFoundException(`Role with ID "${roleId}" not found`);
    }

    // System roles can only have limited updates
    if (existing.isSystem) {
      if (input.name || input.level !== undefined) {
        throw new ForbiddenException('Cannot modify name or level of system roles');
      }
    }

    // Check for duplicate name if changing name
    if (input.name && input.name !== existing.name) {
      const duplicate = await this.dataSource.query(
        `SELECT id FROM "${schemaName}"."tenant_roles" WHERE LOWER(name) = LOWER($1) AND id != $2`,
        [input.name, roleId],
      );
      if (duplicate.length > 0) {
        throw new ConflictException(`Role with name "${input.name}" already exists`);
      }
    }

    // BUG-027 fix: wrap role + permissions update in a transaction so both succeed or
    // both fail atomically — preventing a role from being updated while its permissions
    // remain stale (or vice versa) if one of the queries fails mid-way.
    await this.dataSource.transaction(async (manager) => {
      // If this is set as default, unset other defaults
      if (input.isDefault && !existing.isDefault) {
        await manager.query(
          `UPDATE "${schemaName}"."tenant_roles" SET is_default = false WHERE is_default = true`,
        );
      }

      // Update the role
      const updateFields: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (input.name !== undefined) {
        updateFields.push(`name = $${paramIndex++}`);
        values.push(input.name);
      }
      if (input.description !== undefined) {
        updateFields.push(`description = $${paramIndex++}`);
        values.push(input.description);
      }
      if (input.color !== undefined) {
        updateFields.push(`color = $${paramIndex++}`);
        values.push(input.color);
      }
      if (input.icon !== undefined) {
        updateFields.push(`icon = $${paramIndex++}`);
        values.push(input.icon);
      }
      if (input.level !== undefined) {
        updateFields.push(`level = $${paramIndex++}`);
        values.push(input.level);
      }
      if (input.isDefault !== undefined) {
        updateFields.push(`is_default = $${paramIndex++}`);
        values.push(input.isDefault);
      }

      updateFields.push(`updated_at = NOW()`);
      values.push(roleId);

      if (updateFields.length > 1) {
        await manager.query(
          `UPDATE "${schemaName}"."tenant_roles" SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
          values,
        );
      }

      // Update permissions if provided
      if (input.panelPermissions) {
        const resourcePermissions = panelPermissionsToResourceArray(input.panelPermissions);

        await manager.query(
          `
          UPDATE "${schemaName}"."tenant_role_permissions"
          SET panel_permissions = $1, resource_permissions = $2, updated_at = NOW()
          WHERE role_id = $3
          `,
          [JSON.stringify(input.panelPermissions), resourcePermissions, roleId],
        );
      }
    });

    this.logger.log(`Updated role "${existing.name}" (${roleId}) in tenant ${tenantId} by ${updatedBy}`);

    const updatedRole = await this.getRoleById(tenantId, roleId);
    if (!updatedRole) {
      throw new Error('Failed to retrieve updated role');
    }
    return updatedRole;
  }

  /**
   * Delete a tenant role
   */
  async deleteRole(tenantId: string, roleId: string, deletedBy: string): Promise<boolean> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // Get existing role
    const existing = await this.getRoleById(tenantId, roleId);
    if (!existing) {
      throw new NotFoundException(`Role with ID "${roleId}" not found`);
    }

    // Cannot delete system roles
    if (existing.isSystem) {
      throw new ForbiddenException('Cannot delete system roles');
    }

    // Cannot delete role if users are assigned
    if (existing.userCount > 0) {
      throw new ForbiddenException(
        `Cannot delete role "${existing.name}" - ${existing.userCount} users are still assigned`,
      );
    }

    // Delete the role (cascade will delete permissions)
    await this.dataSource.query(
      `DELETE FROM "${schemaName}"."tenant_roles" WHERE id = $1`,
      [roleId],
    );

    this.logger.log(`Deleted role "${existing.name}" (${roleId}) in tenant ${tenantId} by ${deletedBy}`);

    return true;
  }

  /**
   * Seed default roles for a new tenant
   * Called when a tenant schema is first created
   */
  async seedDefaultRoles(tenantId: string, createdBy: string): Promise<TenantRoleWithDetails[]> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // Check if roles already exist
    const existingRoles = await this.dataSource.query(
      `SELECT COUNT(*)::int as count FROM "${schemaName}"."tenant_roles"`,
    );

    if (existingRoles[0].count > 0) {
      this.logger.debug(`Roles already exist in tenant ${tenantId}, skipping seed`);
      return this.getTenantRoles(tenantId);
    }

    this.logger.log(`Seeding default roles for tenant ${tenantId}`);

    // BUG-027 fix: wrap all role + permissions inserts in a single transaction
    // so either all default roles are created or none are (no orphaned roles).
    await this.dataSource.transaction(async (manager) => {
      for (const roleTemplate of DEFAULT_TENANT_ROLES) {
        const roleResult = await manager.query(
          `
          INSERT INTO "${schemaName}"."tenant_roles" (
            name, description, color, icon, level, is_system, is_default, created_by, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
          RETURNING id
          `,
          [
            roleTemplate.name,
            roleTemplate.description,
            roleTemplate.color,
            roleTemplate.icon,
            roleTemplate.level,
            roleTemplate.isSystem,
            roleTemplate.isDefault,
            createdBy,
          ],
        );

        const roleId = roleResult[0].id;

        const defaultPermissions = DEFAULT_ROLE_PERMISSIONS[roleTemplate.name] || {};
        const resourcePermissions = panelPermissionsToResourceArray(defaultPermissions as PanelPermissions);

        await manager.query(
          `
          INSERT INTO "${schemaName}"."tenant_role_permissions" (
            role_id, panel_permissions, resource_permissions, created_at, updated_at
          ) VALUES ($1, $2, $3, NOW(), NOW())
          `,
          [roleId, JSON.stringify(defaultPermissions), resourcePermissions],
        );

        this.logger.debug(`Created default role: ${roleTemplate.name}`);
      }
    });

    this.logger.log(`Seeded ${DEFAULT_TENANT_ROLES.length} default roles for tenant ${tenantId}`);

    return this.getTenantRoles(tenantId);
  }

  /**
   * Get permission categories structure for UI
   */
  getPermissionCategories(): typeof PERMISSION_CATEGORIES {
    return PERMISSION_CATEGORIES;
  }

  /**
   * Check if a user has a specific permission
   */
  async userHasPermission(
    tenantId: string,
    userId: string,
    resource: string,
    action: string,
  ): Promise<boolean> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    const permissionKey = `${resource}:${action}`;

    const result = await this.dataSource.query(
      `
      SELECT
        p.resource_permissions,
        a.permission_overrides
      FROM "${schemaName}"."user_role_assignments" a
      JOIN "${schemaName}"."tenant_role_permissions" p ON a.role_id = p.role_id
      WHERE a.user_id = $1
        AND a.is_active = true
        AND (a.expires_at IS NULL OR a.expires_at > NOW())
      `,
      [userId],
    );

    if (result.length === 0) {
      return false;
    }

    const { resource_permissions, permission_overrides } = result[0];
    const overrides = permission_overrides || { grants: [], revokes: [] };

    // Check if explicitly revoked
    if (overrides.revokes?.includes(permissionKey)) {
      return false;
    }

    // Check if explicitly granted
    if (overrides.grants?.includes(permissionKey)) {
      return true;
    }

    // Check role permissions
    return resource_permissions?.includes(permissionKey) || false;
  }

  /**
   * Map database row to TenantRoleWithDetails
   */
  private mapRowToRole(row: Record<string, unknown>): TenantRoleWithDetails {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | undefined,
      color: row.color as string,
      icon: row.icon as string,
      level: row.level as number,
      isSystem: row.is_system as boolean,
      isDefault: row.is_default as boolean,
      createdBy: row.created_by as string,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
      userCount: (row.user_count as number) || 0,
      permissions: {
        id: row.permission_id as string,
        roleId: row.id as string,
        panelPermissions: typeof row.panel_permissions === 'string'
          ? JSON.parse(row.panel_permissions)
          : (row.panel_permissions as PanelPermissions) || {},
        resourcePermissions: (row.resource_permissions as string[]) || [],
        createdAt: row.created_at as Date,
        updatedAt: row.updated_at as Date,
        role: undefined as unknown as TenantRole,
      },
    };
  }
}
