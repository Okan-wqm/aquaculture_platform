import { Injectable, Logger, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  AUTH_ADMIN_COMMAND_SUBJECTS,
  type AdminCreateTenantRoleCommand,
  type AdminDeleteTenantRoleCommand,
  type AdminSeedTenantRolesCommand,
  type AdminTenantRoleMutationResult,
  type AdminUpdateTenantRoleCommand,
} from '@platform/event-contracts';
import { DataSource, EntityManager } from 'typeorm';
import { AuthCommandClientService } from '../../auth/auth-command-client.service';

import {
  TenantRolePermissions,
  PanelPermissions,
  DEFAULT_ROLE_PERMISSIONS,
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
    private readonly authCommandClient: AuthCommandClientService,
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

    const result = await this.authCommandClient.request<
      AdminCreateTenantRoleCommand,
      AdminTenantRoleMutationResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_TENANT_ROLE, {
      tenantId,
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? null,
      icon: input.icon ?? null,
      level: input.level,
      isDefault: input.isDefault,
      panelPermissions: input.panelPermissions as Record<string, unknown>,
      createdBy,
    });
    this.authCommandClient.assertSuccess(result, `Could not create role ${input.name}`);
    const roleId = result.roleId!;

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

    const result = await this.authCommandClient.request<
      AdminUpdateTenantRoleCommand,
      AdminTenantRoleMutationResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_TENANT_ROLE, {
      tenantId,
      roleId,
      name: input.name,
      description: input.description,
      color: input.color,
      icon: input.icon,
      level: input.level,
      isDefault: input.isDefault,
      panelPermissions: input.panelPermissions as Record<string, unknown> | undefined,
      updatedBy,
    });
    this.authCommandClient.assertSuccess(result, `Could not update role ${roleId}`);

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

    const result = await this.authCommandClient.request<
      AdminDeleteTenantRoleCommand,
      AdminTenantRoleMutationResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.DELETE_TENANT_ROLE, { tenantId, roleId, deletedBy });
    this.authCommandClient.assertSuccess(result, `Could not delete role ${roleId}`);

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

    const result = await this.authCommandClient.request<
      AdminSeedTenantRolesCommand,
      AdminTenantRoleMutationResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.SEED_TENANT_ROLES, {
      tenantId,
      createdBy,
      roles: DEFAULT_TENANT_ROLES.map((roleTemplate) => ({
        ...roleTemplate,
        panelPermissions: DEFAULT_ROLE_PERMISSIONS[roleTemplate.name] || {},
      })),
    });
    this.authCommandClient.assertSuccess(result, `Could not seed roles for tenant ${tenantId}`);

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
