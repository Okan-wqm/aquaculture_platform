import { Injectable, Logger, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * Default tenant roles seed data
 */
const DEFAULT_TENANT_ROLES = [
  {
    name: 'Supervisor',
    description: 'Can manage daily operations, view reports, and oversee staff',
    color: '#8B5CF6',
    icon: 'user-check',
    level: 70,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Technician',
    description: 'Can manage sensors, equipment, and maintenance tasks',
    color: '#06B6D4',
    icon: 'wrench',
    level: 50,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Feed Manager',
    description: 'Can manage feeding schedules, inventory, and records',
    color: '#F59E0B',
    icon: 'package',
    level: 50,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Operator',
    description: 'Basic operational access for daily tasks',
    color: '#10B981',
    icon: 'activity',
    level: 30,
    isSystem: true,
    isDefault: true,
  },
  {
    name: 'Viewer',
    description: 'Read-only access to dashboards and reports',
    color: '#6B7280',
    icon: 'eye',
    level: 10,
    isSystem: true,
    isDefault: false,
  },
];

/**
 * Default role permissions
 */
const DEFAULT_ROLE_PERMISSIONS: Record<string, Record<string, Record<string, Record<string, boolean>>>> = {
  Supervisor: {
    farm: {
      sites: { view: true, create: false, edit: true, delete: false },
      departments: { view: true, create: true, edit: true, delete: false },
      systems: { view: true, create: true, edit: true, delete: false },
      tanks: { view: true, create: true, edit: true, delete: false, assign: true },
      ponds: { view: true, create: true, edit: true, delete: false },
      equipment: { view: true, create: true, edit: true, delete: false, assign: true },
    },
    batch: {
      batches: { view: true, create: true, edit: true, delete: false, transfer: true, split: true, merge: true },
      species: { view: true, create: false, edit: false, delete: false },
      mortality: { view: true, record: true },
      growth: { view: true, record: true, analyze: true },
      harvest: { view: true, plan: true, record: true },
    },
    operations: {
      feeding: { view: true, record: true, manage_schedules: true, manage_inventory: true },
      sensors: { view: true, configure: true, calibrate: false, manage_alerts: true },
      maintenance: { view: true, create_work_orders: true, complete: true, manage_schedules: true },
      water_quality: { view: true, record: true },
    },
    hr: {
      employees: { view: true, create: false, edit: false, delete: false },
      attendance: { view: true, manage: true },
      leave: { view: true, approve: true },
      shifts: { view: true, create: true, edit: true, delete: false },
    },
    reports: {
      dashboard: { view: true, analytics: true },
      reports: { view: true, export: true, create_custom: false },
    },
    admin: {
      settings: { view: true, edit: false },
      users: { view: true, invite: false, edit_permissions: false, deactivate: false },
      roles: { view: true, create: false, edit: false, delete: false },
    },
    messaging: {
      channels: { view: true, create_group: true, create_dm: true, manage: true },
      messages: { send: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_settings: { view: true, manage: true },
      ai_personas: { operator: true, manager: true, expert: true, supervisor: false },
    },
  },
  Technician: {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      equipment: { view: true, create: true, edit: true, delete: false, assign: false },
    },
    operations: {
      sensors: { view: true, configure: true, calibrate: true, manage_alerts: true },
      maintenance: { view: true, create_work_orders: true, complete: true, manage_schedules: true },
      water_quality: { view: true, record: true },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: false, create_custom: false },
    },
    messaging: {
      channels: { view: true, create_group: true, create_dm: true, manage: false },
      messages: { send: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: true, expert: false, supervisor: false },
    },
  },
  'Feed Manager': {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      tanks: { view: true, create: false, edit: false, delete: false, assign: false },
    },
    batch: {
      batches: { view: true, create: false, edit: false, delete: false },
      growth: { view: true, record: true, analyze: false },
    },
    operations: {
      feeding: { view: true, record: true, manage_schedules: true, manage_inventory: true },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: true, create_custom: false },
    },
    messaging: {
      channels: { view: true, create_group: true, create_dm: true, manage: false },
      messages: { send: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: true, expert: false, supervisor: false },
    },
  },
  Operator: {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      tanks: { view: true, create: false, edit: false, delete: false, assign: false },
    },
    batch: {
      batches: { view: true, create: false, edit: false, delete: false },
      mortality: { view: true, record: true },
      growth: { view: true, record: true, analyze: false },
    },
    operations: {
      feeding: { view: true, record: true, manage_schedules: false, manage_inventory: false },
      sensors: { view: true, configure: false, calibrate: false, manage_alerts: false },
      maintenance: { view: true, create_work_orders: true, complete: true, manage_schedules: false },
      water_quality: { view: true, record: true },
    },
    hr: {
      attendance: { view: true, manage: false },
      leave: { view: true, approve: false },
      shifts: { view: true, create: false, edit: false, delete: false },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: false, create_custom: false },
    },
    messaging: {
      channels: { view: true, create_group: true, create_dm: true, manage: false },
      messages: { send: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: false, expert: false, supervisor: false },
    },
  },
  Viewer: {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      departments: { view: true, create: false, edit: false, delete: false },
      systems: { view: true, create: false, edit: false, delete: false },
      tanks: { view: true, create: false, edit: false, delete: false, assign: false },
      ponds: { view: true, create: false, edit: false, delete: false },
      equipment: { view: true, create: false, edit: false, delete: false, assign: false },
    },
    batch: {
      batches: { view: true, create: false, edit: false, delete: false },
      species: { view: true, create: false, edit: false, delete: false },
      mortality: { view: true, record: false },
      growth: { view: true, record: false, analyze: false },
      harvest: { view: true, plan: false, record: false },
    },
    operations: {
      feeding: { view: true, record: false, manage_schedules: false, manage_inventory: false },
      sensors: { view: true, configure: false, calibrate: false, manage_alerts: false },
      maintenance: { view: true, create_work_orders: false, complete: false, manage_schedules: false },
      water_quality: { view: true, record: false },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: false, create_custom: false },
    },
    messaging: {
      // Most-restricted role: can view channels, DM, and chat — but not start
      // groups. A tenant admin can widen this per role in the role editor.
      channels: { view: true, create_group: false, create_dm: true, manage: false },
      messages: { send: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: false, expert: false, supervisor: false },
    },
  },
};

/**
 * Permission Categories for UI
 */
export const PERMISSION_CATEGORIES = {
  farm: {
    name: 'Farm Management',
    resources: {
      sites: { name: 'Sites', actions: ['view', 'create', 'edit', 'delete'] },
      departments: { name: 'Departments', actions: ['view', 'create', 'edit', 'delete'] },
      systems: { name: 'Systems', actions: ['view', 'create', 'edit', 'delete'] },
      tanks: { name: 'Tanks', actions: ['view', 'create', 'edit', 'delete', 'assign'] },
      ponds: { name: 'Ponds', actions: ['view', 'create', 'edit', 'delete'] },
      equipment: { name: 'Equipment', actions: ['view', 'create', 'edit', 'delete', 'assign'] },
    },
  },
  batch: {
    name: 'Batch & Production',
    resources: {
      batches: { name: 'Batches', actions: ['view', 'create', 'edit', 'delete', 'transfer', 'split', 'merge'] },
      species: { name: 'Species', actions: ['view', 'create', 'edit', 'delete'] },
      mortality: { name: 'Mortality Records', actions: ['view', 'record'] },
      growth: { name: 'Growth Measurements', actions: ['view', 'record', 'analyze'] },
      harvest: { name: 'Harvest', actions: ['view', 'plan', 'record'] },
    },
  },
  operations: {
    name: 'Operations',
    resources: {
      feeding: { name: 'Feeding', actions: ['view', 'record', 'manage_schedules', 'manage_inventory'] },
      sensors: { name: 'Sensors', actions: ['view', 'configure', 'calibrate', 'manage_alerts'] },
      maintenance: { name: 'Maintenance', actions: ['view', 'create_work_orders', 'complete', 'manage_schedules'] },
      water_quality: { name: 'Water Quality', actions: ['view', 'record'] },
    },
  },
  hr: {
    name: 'HR & Administration',
    resources: {
      employees: { name: 'Employees', actions: ['view', 'create', 'edit', 'delete'] },
      attendance: { name: 'Attendance', actions: ['view', 'manage'] },
      leave: { name: 'Leave Management', actions: ['view', 'approve'] },
      shifts: { name: 'Shifts', actions: ['view', 'create', 'edit', 'delete'] },
    },
  },
  reports: {
    name: 'Reports & Analytics',
    resources: {
      dashboard: { name: 'Dashboard', actions: ['view', 'analytics'] },
      reports: { name: 'Reports', actions: ['view', 'export', 'create_custom'] },
    },
  },
  admin: {
    name: 'Settings & User Management',
    resources: {
      settings: { name: 'Settings', actions: ['view', 'edit'] },
      users: { name: 'Users', actions: ['view', 'invite', 'edit_permissions', 'deactivate'] },
      roles: { name: 'Roles', actions: ['view', 'create', 'edit', 'delete'] },
    },
  },
  // Messaging + AI capabilities (Faz 7). Resource keys are globally unique
  // (the wire permission is `${resourceKey}:${action}`, so keys must not collide
  // with any above — e.g. AI settings is `ai_settings`, not `settings`). Adding
  // them here is the SSoT change: the tenant-admin role editor (permissionCategories
  // query, data-driven), token-mint resolution, and TenantPermissionGuard all
  // pick them up automatically — no parallel catalogue.
  messaging: {
    name: 'Messaging',
    resources: {
      channels: {
        name: 'Channels',
        // create_group is the WhatsApp-like group-creation capability
        // (MSG-MEDIUM-070); create_dm the 1:1; manage covers rename/members.
        actions: ['view', 'create_group', 'create_dm', 'manage'],
      },
      messages: { name: 'Messages', actions: ['send'] },
    },
  },
  ai: {
    name: 'AI Assistant',
    resources: {
      ai_assistant: { name: 'AI Chat', actions: ['use'] },
      // AI settings = the tenant BYOK keys / provider / model (Faz 1).
      ai_settings: { name: 'AI Settings', actions: ['view', 'manage'] },
      // Persona tiers — which AI persona a member may drive (AISAFETY-MEDIUM-013).
      ai_personas: {
        name: 'AI Personas',
        actions: ['operator', 'manager', 'expert', 'supervisor'],
      },
    },
  },
};

/**
 * Helper to convert panel permissions to resource:action array
 */
function panelPermissionsToResourceArray(panel: Record<string, Record<string, Record<string, boolean>>>): string[] {
  const result: string[] = [];
  for (const resources of Object.values(panel)) {
    for (const [resource, actions] of Object.entries(resources)) {
      for (const [action, enabled] of Object.entries(actions)) {
        if (enabled) {
          result.push(`${resource}:${action}`);
        }
      }
    }
  }
  return result;
}

export interface TenantRoleWithDetails {
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
}

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
    // Repointed to auth.* (ORPHAN-CRITICAL-100): tenant_roles is the only table
    // carrying "tenantId"; the user_count subquery launders tenant ownership
    // through an inner join on tenant_roles so foreign-tenant assignments cannot
    // inflate the count. tenant_role_permissions has no tenantId column.
    const roles = await this.dataSource.query(
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
        SELECT ura.role_id, COUNT(*)::int as user_count
        FROM "auth"."user_role_assignments" ura
        JOIN "auth"."tenant_roles" trc ON trc.id = ura.role_id AND trc."tenantId" = $1
        WHERE ura.is_active = true
        GROUP BY ura.role_id
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
    // Repointed to auth.* (ORPHAN-CRITICAL-100, FINDING #3): this is the
    // in-tenant validator other methods (createRole/updateRole/setDefaultRole)
    // re-read through, so it MUST scope to "tenantId" — previously it filtered
    // by id alone, returning a foreign-tenant role to its callers.
    const result = await this.dataSource.query(
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
        SELECT ura.role_id, COUNT(*)::int as user_count
        FROM "auth"."user_role_assignments" ura
        JOIN "auth"."tenant_roles" trc ON trc.id = ura.role_id AND trc."tenantId" = $2
        WHERE ura.is_active = true
        GROUP BY ura.role_id
      ) uc ON r.id = uc.role_id
      WHERE r.id = $1 AND r."tenantId" = $2
      `,
      [roleId, tenantId],
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
    // Repointed to auth.* (ORPHAN-CRITICAL-100, FINDING #3 CRITICAL site):
    // without the tenantId predicate this returned ANY tenant's default role.
    // Equality on "tenantId" intentionally skips NULL-tenant (platform-global)
    // rows — see NULL-tenant decision in the blueprint.
    const result = await this.dataSource.query(
      `
      SELECT
        r.*,
        p.id as permission_id,
        p.panel_permissions,
        p.resource_permissions,
        0 as user_count
      FROM "auth"."tenant_roles" r
      LEFT JOIN "auth"."tenant_role_permissions" p ON r.id = p.role_id
      WHERE r.is_default = true AND r."tenantId" = $1
      LIMIT 1
      `,
      [tenantId],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToRole(result[0]);
  }

  /**
   * Create a new tenant role
   *
   * Uses SERIALIZABLE transaction with pessimistic locking to prevent:
   * - Duplicate role name race conditions
   * - Inconsistent state between role and permissions tables
   */
  async createRole(
    tenantId: string,
    input: {
      name: string;
      description?: string;
      color?: string;
      icon?: string;
      level?: number;
      isDefault?: boolean;
      panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
    },
    createdBy: string,
  ): Promise<TenantRoleWithDetails> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Check for duplicate name with FOR UPDATE to prevent race conditions
      // This locks any matching rows and prevents concurrent inserts with same name.
      // Repointed to auth.* (ORPHAN-CRITICAL-100): the dup check is scoped to
      // this tenant so a same name in another tenant is not a conflict.
      const existing = await queryRunner.query(
        `SELECT id FROM "auth"."tenant_roles" WHERE LOWER(name) = LOWER($1) AND "tenantId" = $2 FOR UPDATE`,
        [input.name, tenantId],
      );

      if (existing.length > 0) {
        throw new ConflictException(`Role with name "${input.name}" already exists`);
      }

      // If this is set as default, unset other defaults (with locking).
      // CRITICAL (FINDING #3): the AND "tenantId" = $1 guard prevents
      // platform-wide default-role corruption across every other tenant.
      if (input.isDefault) {
        await queryRunner.query(
          `UPDATE "auth"."tenant_roles" SET is_default = false, updated_at = NOW() WHERE is_default = true AND "tenantId" = $1`,
          [tenantId],
        );
      }

      // Create the role. "tenantId" is the leading bound param ($1); every
      // subsequent positional param shifted +1 from the pre-repoint shape.
      const roleResult = await queryRunner.query(
        `
        INSERT INTO "auth"."tenant_roles" (
          "tenantId", name, description, color, icon, level, is_system, is_default, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, NOW(), NOW())
        RETURNING *
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

      const roleId = roleResult[0].id;

      // Create role permissions within the same transaction. tenant_role_permissions
      // has no tenantId column; ownership is transitive via the role_id of the
      // tenant-owned role inserted above in the same SERIALIZABLE tx.
      const resourcePermissions = panelPermissionsToResourceArray(input.panelPermissions);

      await queryRunner.query(
        `
        INSERT INTO "auth"."tenant_role_permissions" (
          role_id, panel_permissions, resource_permissions, created_at, updated_at
        ) VALUES ($1, $2, $3, NOW(), NOW())
        `,
        [roleId, JSON.stringify(input.panelPermissions), resourcePermissions],
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Created role "${input.name}" in tenant ${tenantId}`);

      const createdRole = await this.getRoleById(tenantId, roleId);
      if (!createdRole) {
        throw new Error('Failed to retrieve created role');
      }
      return createdRole;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to create role "${input.name}" in tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Update a tenant role
   *
   * Uses SERIALIZABLE transaction with pessimistic locking to ensure:
   * - Atomic update of role and permissions
   * - Prevention of duplicate name race conditions
   * - Consistent default role state
   */
  async updateRole(
    tenantId: string,
    roleId: string,
    input: {
      name?: string;
      description?: string;
      color?: string;
      icon?: string;
      level?: number;
      isDefault?: boolean;
      panelPermissions?: Record<string, Record<string, Record<string, boolean>>>;
    },
    _updatedBy: string,
  ): Promise<TenantRoleWithDetails> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the role row for update to prevent concurrent modifications.
      // Repointed to auth.* (ORPHAN-CRITICAL-100): the tenantId predicate makes
      // a foreign roleId return 0 rows → NotFoundException (no cross-tenant peek).
      const existingResult = await queryRunner.query(
        `
        SELECT r.*, p.id as permission_id, p.panel_permissions, p.resource_permissions
        FROM "auth"."tenant_roles" r
        LEFT JOIN "auth"."tenant_role_permissions" p ON r.id = p.role_id
        WHERE r.id = $1 AND r."tenantId" = $2
        FOR UPDATE OF r
        `,
        [roleId, tenantId],
      );

      if (existingResult.length === 0) {
        throw new NotFoundException(`Role with ID "${roleId}" not found`);
      }

      const existing = this.mapRowToRole(existingResult[0]);

      if (existing.isSystem) {
        if (input.name || input.level !== undefined) {
          throw new ForbiddenException('Cannot modify name or level of system roles');
        }
      }

      // Check for duplicate name with locking to prevent race conditions.
      // Repointed to auth.* (ORPHAN-CRITICAL-100): scoped to this tenant.
      if (input.name && input.name !== existing.name) {
        const duplicate = await queryRunner.query(
          `SELECT id FROM "auth"."tenant_roles" WHERE LOWER(name) = LOWER($1) AND id != $2 AND "tenantId" = $3 FOR UPDATE`,
          [input.name, roleId, tenantId],
        );
        if (duplicate.length > 0) {
          throw new ConflictException(`Role with name "${input.name}" already exists`);
        }
      }

      // If setting as default, unset other defaults within transaction.
      // CRITICAL (FINDING #3): AND "tenantId" = $2 scopes the unset to this
      // tenant; without it the write would clear defaults in every tenant.
      if (input.isDefault && !existing.isDefault) {
        await queryRunner.query(
          `UPDATE "auth"."tenant_roles" SET is_default = false, updated_at = NOW() WHERE is_default = true AND id != $1 AND "tenantId" = $2`,
          [roleId, tenantId],
        );
      }

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
      // Param-index discipline (ORPHAN-CRITICAL-100): roleId occupies
      // $${paramIndex}; tenantId is pushed immediately after at $${paramIndex + 1}.
      // The WHERE carries its own tenant guard so the write is fail-closed
      // independent of the lock-load above. An off-by-one here would silently
      // drop the tenant guard, so the two pushes mirror the two positional refs.
      values.push(roleId);
      values.push(tenantId);
      const roleIdParam = paramIndex;
      const tenantIdParam = paramIndex + 1;

      if (updateFields.length > 1) {
        await queryRunner.query(
          `UPDATE "auth"."tenant_roles" SET ${updateFields.join(', ')} WHERE id = $${roleIdParam} AND "tenantId" = $${tenantIdParam}`,
          values,
        );
      }

      // Update permissions within the same transaction. tenant_role_permissions
      // has no tenantId column, so ownership is laundered through a write-side
      // join on tenant_roles (ORPHAN-CRITICAL-100).
      if (input.panelPermissions) {
        const resourcePermissions = panelPermissionsToResourceArray(input.panelPermissions);

        await queryRunner.query(
          `
          UPDATE "auth"."tenant_role_permissions" trp
          SET panel_permissions = $1, resource_permissions = $2, updated_at = NOW()
          FROM "auth"."tenant_roles" tr
          WHERE trp.role_id = tr.id AND trp.role_id = $3 AND tr."tenantId" = $4
          `,
          [JSON.stringify(input.panelPermissions), resourcePermissions, roleId, tenantId],
        );
      }

      await queryRunner.commitTransaction();

      this.logger.log(`Updated role "${existing.name}" (${roleId}) in tenant ${tenantId}`);

      const updatedRole = await this.getRoleById(tenantId, roleId);
      if (!updatedRole) {
        throw new Error('Failed to retrieve updated role');
      }
      return updatedRole;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to update role ${roleId} in tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Delete a tenant role
   *
   * Uses SERIALIZABLE transaction with pessimistic locking to ensure:
   * - Atomic deletion of role and associated permissions (cascade)
   * - Accurate user count check (prevents race with role assignment)
   * - Prevents deletion while users are being assigned
   */
  async deleteRole(tenantId: string, roleId: string, _deletedBy: string): Promise<boolean> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the role and get accurate user count within transaction.
      // Repointed to auth.* (ORPHAN-CRITICAL-100): outer filter on r."tenantId"
      // and the user_count subquery join on trc."tenantId" both scope to tenant.
      const roleResult = await queryRunner.query(
        `
        SELECT
          r.*,
          COALESCE(uc.user_count, 0)::int as user_count
        FROM "auth"."tenant_roles" r
        LEFT JOIN (
          SELECT ura.role_id, COUNT(*)::int as user_count
          FROM "auth"."user_role_assignments" ura
          JOIN "auth"."tenant_roles" trc ON trc.id = ura.role_id AND trc."tenantId" = $2
          WHERE ura.is_active = true
          GROUP BY ura.role_id
        ) uc ON r.id = uc.role_id
        WHERE r.id = $1 AND r."tenantId" = $2
        FOR UPDATE OF r
        `,
        [roleId, tenantId],
      );

      if (roleResult.length === 0) {
        throw new NotFoundException(`Role with ID "${roleId}" not found`);
      }

      const existing = roleResult[0];

      if (existing.is_system) {
        throw new ForbiddenException('Cannot delete system roles');
      }

      if (existing.user_count > 0) {
        throw new ForbiddenException(
          `Cannot delete role "${existing.name}" - ${existing.user_count} users are still assigned`,
        );
      }

      // Delete role permissions first (if not using CASCADE). tenant_role_permissions
      // has no tenantId column, so the delete is laundered through a write-side
      // join on tenant_roles (ORPHAN-CRITICAL-100).
      await queryRunner.query(
        `DELETE FROM "auth"."tenant_role_permissions" trp USING "auth"."tenant_roles" tr WHERE trp.role_id = tr.id AND trp.role_id = $1 AND tr."tenantId" = $2`,
        [roleId, tenantId],
      );

      // Delete the role. Carries its own tenant guard (ORPHAN-CRITICAL-100).
      await queryRunner.query(
        `DELETE FROM "auth"."tenant_roles" WHERE id = $1 AND "tenantId" = $2`,
        [roleId, tenantId],
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Deleted role "${existing.name}" (${roleId}) in tenant ${tenantId}`);

      return true;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to delete role ${roleId} in tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Seed default roles for a new tenant
   *
   * Uses SERIALIZABLE transaction to ensure:
   * - All default roles are created atomically
   * - Prevents partial seeding if an error occurs
   * - Prevents race conditions if called multiple times
   */
  async seedDefaultRoles(tenantId: string, createdBy: string): Promise<TenantRoleWithDetails[]> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Check if roles already exist (with lock to prevent race condition).
      // Repointed to auth.* (ORPHAN-CRITICAL-100): WHERE "tenantId" = $1 is
      // load-bearing — without it a brand-new tenant is told roles already
      // exist (skipping its seed) and takes a cross-tenant lock.
      const existingRoles = await queryRunner.query(
        `SELECT COUNT(*)::int as count FROM "auth"."tenant_roles" WHERE "tenantId" = $1 FOR UPDATE`,
        [tenantId],
      );

      if (existingRoles[0].count > 0) {
        await queryRunner.commitTransaction();
        this.logger.debug(`Roles already exist in tenant ${tenantId}, skipping seed`);
        return this.getTenantRoles(tenantId);
      }

      this.logger.log(`Seeding default roles for tenant ${tenantId}`);

      for (const roleTemplate of DEFAULT_TENANT_ROLES) {
        // "tenantId" prepended as $1 (ORPHAN-CRITICAL-100); template params shift +1.
        const roleResult = await queryRunner.query(
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

        const roleId = roleResult[0].id;
        const defaultPermissions = DEFAULT_ROLE_PERMISSIONS[roleTemplate.name] || {};
        const resourcePermissions = panelPermissionsToResourceArray(defaultPermissions);

        // Tenant-safe transitively via the role_id inserted above in this tx.
        await queryRunner.query(
          `
          INSERT INTO "auth"."tenant_role_permissions" (
            role_id, panel_permissions, resource_permissions, created_at, updated_at
          ) VALUES ($1, $2, $3, NOW(), NOW())
          `,
          [roleId, JSON.stringify(defaultPermissions), resourcePermissions],
        );

        this.logger.debug(`Created default role: ${roleTemplate.name}`);
      }

      await queryRunner.commitTransaction();

      this.logger.log(`Seeded ${DEFAULT_TENANT_ROLES.length} default roles for tenant ${tenantId}`);

      return this.getTenantRoles(tenantId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to seed default roles for tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get permission categories structure for UI
   */
  getPermissionCategories(): typeof PERMISSION_CATEGORIES {
    return PERMISSION_CATEGORIES;
  }

  /**
   * Assign a role to a user with pessimistic locking
   *
   * Uses SERIALIZABLE transaction to prevent:
   * - Race conditions when multiple requests try to assign the same role
   * - Orphaned assignments if role is deleted during assignment
   * - Duplicate active assignments for the same user-role pair
   */
  async assignRoleToUser(
    tenantId: string,
    userId: string,
    roleId: string,
    assignedBy: string,
  ): Promise<{ id: string; userId: string; roleId: string; isActive: boolean }> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Tenant-scoped user pre-validation (ORPHAN-CRITICAL-100, FINDING #1).
      // Load-bearing: without it a T2 caller could attach a foreign-tenant T1
      // user to a T2-owned role. auth.users carries "tenantId"; user_role_assignments
      // does not, so this is the only place the user's tenant can be checked.
      const userResult = await queryRunner.query(
        `SELECT 1 FROM "auth"."users" WHERE id = $1 AND "tenantId" = $2`,
        [userId, tenantId],
      );

      if (userResult.length === 0) {
        throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
      }

      // Lock the role to ensure it exists, is in this tenant, and is not being deleted.
      const roleResult = await queryRunner.query(
        `SELECT id, name, is_system FROM "auth"."tenant_roles" WHERE id = $1 AND "tenantId" = $2 FOR UPDATE`,
        [roleId, tenantId],
      );

      if (roleResult.length === 0) {
        throw new NotFoundException(`Role with ID "${roleId}" not found`);
      }

      // Check for existing assignment, RE-KEYED to user_id ONLY (FINDING #2):
      // auth.user_role_assignments has a UNIQUE index on user_id alone, so each
      // user holds at most one row. The JOIN to tenant_roles launders ownership —
      // the row is only returned if the user's current role belongs to THIS
      // tenant, so a foreign-tenant row falls through to the no-row (INSERT)
      // branch and is never silently hijacked. FOR UPDATE OF ura locks the
      // assignment row only.
      const existingAssignment = await queryRunner.query(
        `
        SELECT ura.id, ura.is_active, ura.role_id
        FROM "auth"."user_role_assignments" ura
        JOIN "auth"."tenant_roles" tr ON tr.id = ura.role_id AND tr."tenantId" = $2
        WHERE ura.user_id = $1
        FOR UPDATE OF ura
        `,
        [userId, tenantId],
      );

      let assignmentId: string;

      if (existingAssignment.length > 0) {
        // One-row-per-user reconciliation: re-point the single existing row to
        // the (newly validated) target role and (re)activate it. UPDATE — never
        // a 2nd INSERT — so UNIQUE(user_id) is satisfied. The write-side join
        // guards on the PRE-IMAGE current role's tenantId (you must own the row
        // you mutate); the new role was already validated by the role lock above.
        await queryRunner.query(
          `
          UPDATE "auth"."user_role_assignments" ura
          SET is_active = true, role_id = $4, assigned_by = $1, assigned_at = NOW(), updated_at = NOW()
          FROM "auth"."tenant_roles" tr
          WHERE ura.id = $2 AND tr.id = ura.role_id AND tr."tenantId" = $3
          `,
          [assignedBy, existingAssignment[0].id, tenantId, roleId],
        );
        assignmentId = existingAssignment[0].id;
      } else {
        // Create new assignment. Tenant-safe: role validated by the role lock,
        // user validated by the pre-check above (ORPHAN-CRITICAL-100).
        const insertResult = await queryRunner.query(
          `
          INSERT INTO "auth"."user_role_assignments" (
            user_id, role_id, is_active, assigned_by, assigned_at, created_at, updated_at
          ) VALUES ($1, $2, true, $3, NOW(), NOW(), NOW())
          RETURNING id
          `,
          [userId, roleId, assignedBy],
        );
        assignmentId = insertResult[0].id;
      }

      await queryRunner.commitTransaction();

      this.logger.log(
        `Assigned role ${roleResult[0].name} (${roleId}) to user ${userId} in tenant ${tenantId}`,
      );

      return {
        id: assignmentId,
        userId,
        roleId,
        isActive: true,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to assign role ${roleId} to user ${userId} in tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Remove a role from a user with pessimistic locking
   *
   * Soft-deletes the assignment by setting is_active = false
   */
  async removeRoleFromUser(
    tenantId: string,
    userId: string,
    roleId: string,
    _removedBy: string,
  ): Promise<boolean> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Tenant-scoped user pre-validation for symmetry with assignRoleToUser
      // (ORPHAN-CRITICAL-100, FINDING #1): a foreign-tenant userId cannot reach
      // the assignment write at all.
      const userResult = await queryRunner.query(
        `SELECT 1 FROM "auth"."users" WHERE id = $1 AND "tenantId" = $2`,
        [userId, tenantId],
      );

      if (userResult.length === 0) {
        throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
      }

      // Lock the active assignment row. Repointed to auth.* (ORPHAN-CRITICAL-100):
      // user_role_assignments has no tenantId column, so ownership is laundered
      // through a JOIN on tenant_roles. FOR UPDATE OF ura locks the assignment only.
      const assignment = await queryRunner.query(
        `
        SELECT ura.id, ura.is_active
        FROM "auth"."user_role_assignments" ura
        JOIN "auth"."tenant_roles" tr ON tr.id = ura.role_id AND tr."tenantId" = $3
        WHERE ura.user_id = $1 AND ura.role_id = $2 AND ura.is_active = true
        FOR UPDATE OF ura
        `,
        [userId, roleId, tenantId],
      );

      if (assignment.length === 0) {
        throw new NotFoundException(`Active role assignment not found for user ${userId} and role ${roleId}`);
      }

      // Soft delete the assignment via a write-side join on tenant_roles so the
      // mutation carries its own tenant guard (ORPHAN-CRITICAL-100).
      //
      // WHAT: SET only is_active=false and updated_at=NOW(). WHY: auth.user_role_assignments
      // has NO removed_by / removed_at / updated_by columns (GROUND TRUTH, migration
      // 1800200000000) — writing them fails at runtime. The actor (_removedBy) is not
      // persisted on this table; soft-delete provenance is carried by the audit trail,
      // not by columns that do not exist. Param indices re-counted after dropping the
      // removed_by bind: ura.id=$1, tr."tenantId"=$2.
      await queryRunner.query(
        `
        UPDATE "auth"."user_role_assignments" ura
        SET is_active = false, updated_at = NOW()
        FROM "auth"."tenant_roles" tr
        WHERE ura.id = $1 AND tr.id = ura.role_id AND tr."tenantId" = $2
        `,
        [assignment[0].id, tenantId],
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Removed role ${roleId} from user ${userId} in tenant ${tenantId}`);

      return true;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to remove role ${roleId} from user ${userId} in tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Set a role as the default role for new users
   *
   * Uses pessimistic locking to ensure only one role is default at a time
   */
  async setDefaultRole(
    tenantId: string,
    roleId: string,
    updatedBy: string,
  ): Promise<TenantRoleWithDetails> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the target role. Repointed to auth.* (ORPHAN-CRITICAL-100):
      // tenantId predicate makes a foreign roleId return 0 rows → NotFoundException.
      const roleResult = await queryRunner.query(
        `SELECT * FROM "auth"."tenant_roles" WHERE id = $1 AND "tenantId" = $2 FOR UPDATE`,
        [roleId, tenantId],
      );

      if (roleResult.length === 0) {
        throw new NotFoundException(`Role with ID "${roleId}" not found`);
      }

      // Lock and unset any current default roles.
      // CRITICAL (FINDING #3): AND "tenantId" = $2 scopes the unset to this
      // tenant; otherwise it would clear defaults platform-wide.
      await queryRunner.query(
        `
        UPDATE "auth"."tenant_roles"
        SET is_default = false, updated_at = NOW()
        WHERE is_default = true AND id != $1 AND "tenantId" = $2
        `,
        [roleId, tenantId],
      );

      // Set the new default role. Carries its own tenant guard (ORPHAN-CRITICAL-100).
      await queryRunner.query(
        `
        UPDATE "auth"."tenant_roles"
        SET is_default = true, updated_at = NOW()
        WHERE id = $1 AND "tenantId" = $2
        `,
        [roleId, tenantId],
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Set role ${roleResult[0].name} (${roleId}) as default in tenant ${tenantId}`);

      const updatedRole = await this.getRoleById(tenantId, roleId);
      if (!updatedRole) {
        throw new Error('Failed to retrieve updated role');
      }
      return updatedRole;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to set default role ${roleId} in tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private mapRowToRole(row: Record<string, unknown>): TenantRoleWithDetails {
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      description: row['description'] as string | null,
      color: row['color'] as string,
      icon: row['icon'] as string,
      level: row['level'] as number,
      isSystem: row['is_system'] as boolean,
      isDefault: row['is_default'] as boolean,
      userCount: (row['user_count'] as number) || 0,
      permissions: row['permission_id']
        ? {
            id: row['permission_id'] as string,
            roleId: row['id'] as string,
            panelPermissions:
              typeof row['panel_permissions'] === 'string'
                ? JSON.parse(row['panel_permissions'])
                : (row['panel_permissions'] as Record<string, Record<string, Record<string, boolean>>>) || {},
            resourcePermissions: (row['resource_permissions'] as string[]) || [],
          }
        : null,
      createdAt: row['created_at'] as Date,
      updatedAt: row['updated_at'] as Date,
    };
  }
}
