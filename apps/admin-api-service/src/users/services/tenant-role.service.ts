import { Injectable, Logger, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

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
type QueryClient = DataSource | EntityManager;
type QueryRow = Record<string, unknown>;

export type TenantRoleWithDetails = Omit<TenantRole, 'permissions'> & {
  permissions: Omit<TenantRolePermissions, 'role'>;
  userCount: number;
};

async function queryRows<T extends QueryRow>(
  client: QueryClient,
  sql: string,
  parameters?: unknown[],
): Promise<T[]> {
  const result: unknown = await client.query(sql, parameters);
  return Array.isArray(result) ? (result as T[]) : [];
}

function parsePanelPermissions(value: unknown): PanelPermissions {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  }
  return value && typeof value === 'object' ? value : {};
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
 * Tenant Role Service
 * Manages tenant-specific roles stored in auth.* with tenantId scoping.
 */
@Injectable()
export class TenantRoleService {
  private readonly logger = new Logger(TenantRoleService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get all roles for a tenant
   */
  async getTenantRoles(tenantId: string): Promise<TenantRoleWithDetails[]> {
    const roles = await queryRows<QueryRow>(
      this.dataSource,
      `
      SELECT
        r.*,
        p.id as permission_id,
        p.panel_permissions,
        p.resource_permissions,
        COALESCE(uc.user_count, 0)::int as user_count
      FROM "auth"."tenant_roles" r
      LEFT JOIN "auth"."tenant_role_permissions" p ON r.id = p.role_id
      LEFT JOIN (
        SELECT a.role_id, COUNT(*)::int as user_count
        FROM "auth"."user_role_assignments" a
        JOIN "auth"."tenant_roles" ar ON ar.id = a.role_id
        WHERE ar."tenantId" = $1 AND a.is_active = true
        GROUP BY a.role_id
      ) uc ON r.id = uc.role_id
      WHERE r."tenantId" = $1
      ORDER BY r.level DESC, r.name ASC
      `,
      [tenantId],
    );

    return roles.map((row: Record<string, unknown>) => this.mapRowToRole(row));
  }

  /**
   * Get a single role by ID
   */
  async getRoleById(tenantId: string, roleId: string): Promise<TenantRoleWithDetails | null> {
    const result = await queryRows<QueryRow>(
      this.dataSource,
      `
      SELECT
        r.*,
        p.id as permission_id,
        p.panel_permissions,
        p.resource_permissions,
        COALESCE(uc.user_count, 0)::int as user_count
      FROM "auth"."tenant_roles" r
      LEFT JOIN "auth"."tenant_role_permissions" p ON r.id = p.role_id
      LEFT JOIN (
        SELECT a.role_id, COUNT(*)::int as user_count
        FROM "auth"."user_role_assignments" a
        JOIN "auth"."tenant_roles" ar ON ar.id = a.role_id
        WHERE ar."tenantId" = $1 AND a.is_active = true
        GROUP BY a.role_id
      ) uc ON r.id = uc.role_id
      WHERE r."tenantId" = $1 AND r.id = $2
      `,
      [tenantId, roleId],
    );

    const [row] = result;
    if (!row) {
      return null;
    }

    return this.mapRowToRole(row);
  }

  /**
   * Get the default role for a tenant
   */
  async getDefaultRole(tenantId: string): Promise<TenantRoleWithDetails | null> {
    const result = await queryRows<QueryRow>(
      this.dataSource,
      `
      SELECT
        r.*,
        p.id as permission_id,
        p.panel_permissions,
        p.resource_permissions,
        0 as user_count
      FROM "auth"."tenant_roles" r
      LEFT JOIN "auth"."tenant_role_permissions" p ON r.id = p.role_id
      WHERE r."tenantId" = $1 AND r.is_default = true
      LIMIT 1
      `,
      [tenantId],
    );

    const [row] = result;
    if (!row) {
      return null;
    }

    return this.mapRowToRole(row);
  }

  /**
   * Create a new tenant role
   */
  async createRole(
    tenantId: string,
    input: CreateTenantRoleInput,
    createdBy: string,
  ): Promise<TenantRoleWithDetails> {
    // Check for duplicate name
    const existing = await queryRows<{ id: string }>(
      this.dataSource,
      `SELECT id FROM "auth"."tenant_roles" WHERE "tenantId" = $1 AND LOWER(name) = LOWER($2)`,
      [tenantId, input.name],
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
          `UPDATE "auth"."tenant_roles" SET is_default = false WHERE "tenantId" = $1 AND is_default = true`,
          [tenantId],
        );
      }

      // Create the role
      const roleResult = await queryRows<{ id: string }>(
        manager,
        `
        INSERT INTO "auth"."tenant_roles" (
          "tenantId", name, description, color, icon, level, is_system, is_default, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, NOW(), NOW())
        RETURNING id
        `,
        [
          tenantId,
          input.name,
          input.description || null,
          input.color || '#6366F1',
          input.icon || 'shield',
          input.level ?? 50,
          input.isDefault ?? false,
          createdBy,
        ],
      );

      const newRole = roleResult[0];
      if (!newRole) {
        throw new Error('Failed to create tenant role');
      }
      const newRoleId = newRole.id;

      // Create role permissions
      const resourcePermissions = panelPermissionsToResourceArray(input.panelPermissions);

      await manager.query(
        `
        INSERT INTO "auth"."tenant_role_permissions" (
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
      const duplicate = await queryRows<{ id: string }>(
        this.dataSource,
        `SELECT id FROM "auth"."tenant_roles" WHERE "tenantId" = $1 AND LOWER(name) = LOWER($2) AND id != $3`,
        [tenantId, input.name, roleId],
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
          `UPDATE "auth"."tenant_roles" SET is_default = false WHERE "tenantId" = $1 AND is_default = true`,
          [tenantId],
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
          `UPDATE "auth"."tenant_roles" SET ${updateFields.join(', ')} WHERE "tenantId" = $${paramIndex} AND id = $${paramIndex + 1}`,
          [...values.slice(0, -1), tenantId, roleId],
        );
      }

      // Update permissions if provided
      if (input.panelPermissions) {
        const resourcePermissions = panelPermissionsToResourceArray(input.panelPermissions);

        await manager.query(
          `
          UPDATE "auth"."tenant_role_permissions"
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
      `DELETE FROM "auth"."tenant_roles" WHERE "tenantId" = $1 AND id = $2`,
      [tenantId, roleId],
    );

    this.logger.log(`Deleted role "${existing.name}" (${roleId}) in tenant ${tenantId} by ${deletedBy}`);

    return true;
  }

  /**
   * Seed default roles for a new tenant
   * Called when a tenant schema is first created
   */
  async seedDefaultRoles(tenantId: string, createdBy: string): Promise<TenantRoleWithDetails[]> {
    // Check if roles already exist
    const existingRoles = await queryRows<{ count: number }>(
      this.dataSource,
      `SELECT COUNT(*)::int as count FROM "auth"."tenant_roles" WHERE "tenantId" = $1`,
      [tenantId],
    );

    if ((existingRoles[0]?.count ?? 0) > 0) {
      this.logger.debug(`Roles already exist in tenant ${tenantId}, skipping seed`);
      return this.getTenantRoles(tenantId);
    }

    this.logger.log(`Seeding default roles for tenant ${tenantId}`);

    // BUG-027 fix: wrap all role + permissions inserts in a single transaction
    // so either all default roles are created or none are (no orphaned roles).
    await this.dataSource.transaction(async (manager) => {
      for (const roleTemplate of DEFAULT_TENANT_ROLES) {
        const roleResult = await queryRows<{ id: string }>(
          manager,
          `
          INSERT INTO "auth"."tenant_roles" (
            "tenantId", name, description, color, icon, level, is_system, is_default, created_by, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
          RETURNING id
          `,
          [
            tenantId,
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

        const role = roleResult[0];
        if (!role) {
          throw new Error(`Failed to seed default role: ${roleTemplate.name}`);
        }
        const roleId = role.id;

        const defaultPermissions = DEFAULT_ROLE_PERMISSIONS[roleTemplate.name] || {};
        const resourcePermissions = panelPermissionsToResourceArray(defaultPermissions);

        await manager.query(
          `
          INSERT INTO "auth"."tenant_role_permissions" (
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
    const permissionKey = `${resource}:${action}`;

    const result = await queryRows<{
      resource_permissions: unknown;
      permission_overrides: unknown;
    }>(
      this.dataSource,
      `
      SELECT
        p.resource_permissions,
        a.permission_overrides
      FROM "auth"."user_role_assignments" a
      JOIN "auth"."tenant_roles" r ON r.id = a.role_id
      JOIN "auth"."tenant_role_permissions" p ON a.role_id = p.role_id
      WHERE a.user_id = $1
        AND r."tenantId" = $2
        AND a.is_active = true
        AND (a.expires_at IS NULL OR a.expires_at > NOW())
      `,
      [userId, tenantId],
    );

    if (result.length === 0) {
      return false;
    }

    const permissionsRow = result[0];
    if (!permissionsRow) {
      return false;
    }

    const resourcePermissions = parseStringArray(permissionsRow.resource_permissions);
    const overrides = parsePermissionOverrides(permissionsRow.permission_overrides);

    // Check if explicitly revoked
    if (overrides.revokes?.includes(permissionKey)) {
      return false;
    }

    // Check if explicitly granted
    if (overrides.grants?.includes(permissionKey)) {
      return true;
    }

    // Check role permissions
    return resourcePermissions.includes(permissionKey);
  }

  /**
   * Map database row to TenantRoleWithDetails
   */
  private mapRowToRole(row: Record<string, unknown>): TenantRoleWithDetails {
    return {
      id: rowString(row.id),
      name: rowString(row.name),
      description: typeof row.description === 'string' ? row.description : undefined,
      color: rowString(row.color),
      icon: rowString(row.icon),
      level: rowNumber(row.level),
      isSystem: rowBoolean(row.is_system),
      isDefault: rowBoolean(row.is_default),
      createdBy: rowString(row.created_by),
      createdAt: rowDate(row.created_at),
      updatedAt: rowDate(row.updated_at),
      userCount: rowNumber(row.user_count),
      permissions: {
        id: rowString(row.permission_id),
        roleId: rowString(row.id),
        panelPermissions: parsePanelPermissions(row.panel_permissions),
        resourcePermissions: parseStringArray(row.resource_permissions),
        createdAt: rowDate(row.created_at),
        updatedAt: rowDate(row.updated_at),
      },
    };
  }
}

function parsePermissionOverrides(value: unknown): { grants: string[]; revokes: string[] } {
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
