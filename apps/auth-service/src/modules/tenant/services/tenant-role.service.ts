import { Injectable, Logger, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { SchemaManagerService } from '@aquaculture/backend-common/database';

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
    private readonly schemaManager: SchemaManagerService,
  ) {}

  /**
   * Get all roles for a tenant
   */
  async getTenantRoles(tenantId: string): Promise<TenantRoleWithDetails[]> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

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
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Check for duplicate name with FOR UPDATE to prevent race conditions
      // This locks any matching rows and prevents concurrent inserts with same name
      const existing = await queryRunner.query(
        `SELECT id FROM "${schemaName}"."tenant_roles" WHERE LOWER(name) = LOWER($1) FOR UPDATE`,
        [input.name],
      );

      if (existing.length > 0) {
        throw new ConflictException(`Role with name "${input.name}" already exists`);
      }

      // If this is set as default, unset other defaults (with locking)
      if (input.isDefault) {
        await queryRunner.query(
          `UPDATE "${schemaName}"."tenant_roles" SET is_default = false, updated_at = NOW() WHERE is_default = true`,
        );
      }

      // Create the role
      const roleResult = await queryRunner.query(
        `
        INSERT INTO "${schemaName}"."tenant_roles" (
          name, description, color, icon, level, is_system, is_default, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, false, $6, $7, NOW(), NOW())
        RETURNING *
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

      const roleId = roleResult[0].id;

      // Create role permissions within the same transaction
      const resourcePermissions = panelPermissionsToResourceArray(input.panelPermissions);

      await queryRunner.query(
        `
        INSERT INTO "${schemaName}"."tenant_role_permissions" (
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
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the role row for update to prevent concurrent modifications
      const existingResult = await queryRunner.query(
        `
        SELECT r.*, p.id as permission_id, p.panel_permissions, p.resource_permissions
        FROM "${schemaName}"."tenant_roles" r
        LEFT JOIN "${schemaName}"."tenant_role_permissions" p ON r.id = p.role_id
        WHERE r.id = $1
        FOR UPDATE OF r
        `,
        [roleId],
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

      // Check for duplicate name with locking to prevent race conditions
      if (input.name && input.name !== existing.name) {
        const duplicate = await queryRunner.query(
          `SELECT id FROM "${schemaName}"."tenant_roles" WHERE LOWER(name) = LOWER($1) AND id != $2 FOR UPDATE`,
          [input.name, roleId],
        );
        if (duplicate.length > 0) {
          throw new ConflictException(`Role with name "${input.name}" already exists`);
        }
      }

      // If setting as default, unset other defaults within transaction
      if (input.isDefault && !existing.isDefault) {
        await queryRunner.query(
          `UPDATE "${schemaName}"."tenant_roles" SET is_default = false, updated_at = NOW() WHERE is_default = true AND id != $1`,
          [roleId],
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
      values.push(roleId);

      if (updateFields.length > 1) {
        await queryRunner.query(
          `UPDATE "${schemaName}"."tenant_roles" SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
          values,
        );
      }

      // Update permissions within the same transaction
      if (input.panelPermissions) {
        const resourcePermissions = panelPermissionsToResourceArray(input.panelPermissions);

        await queryRunner.query(
          `
          UPDATE "${schemaName}"."tenant_role_permissions"
          SET panel_permissions = $1, resource_permissions = $2, updated_at = NOW()
          WHERE role_id = $3
          `,
          [JSON.stringify(input.panelPermissions), resourcePermissions, roleId],
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
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the role and get accurate user count within transaction
      const roleResult = await queryRunner.query(
        `
        SELECT
          r.*,
          COALESCE(uc.user_count, 0)::int as user_count
        FROM "${schemaName}"."tenant_roles" r
        LEFT JOIN (
          SELECT role_id, COUNT(*)::int as user_count
          FROM "${schemaName}"."user_role_assignments"
          WHERE is_active = true
          GROUP BY role_id
        ) uc ON r.id = uc.role_id
        WHERE r.id = $1
        FOR UPDATE OF r
        `,
        [roleId],
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

      // Delete role permissions first (if not using CASCADE)
      await queryRunner.query(
        `DELETE FROM "${schemaName}"."tenant_role_permissions" WHERE role_id = $1`,
        [roleId],
      );

      // Delete the role
      await queryRunner.query(
        `DELETE FROM "${schemaName}"."tenant_roles" WHERE id = $1`,
        [roleId],
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
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Check if roles already exist (with lock to prevent race condition)
      const existingRoles = await queryRunner.query(
        `SELECT COUNT(*)::int as count FROM "${schemaName}"."tenant_roles" FOR UPDATE`,
      );

      if (existingRoles[0].count > 0) {
        await queryRunner.commitTransaction();
        this.logger.debug(`Roles already exist in tenant ${tenantId}, skipping seed`);
        return this.getTenantRoles(tenantId);
      }

      this.logger.log(`Seeding default roles for tenant ${tenantId}`);

      for (const roleTemplate of DEFAULT_TENANT_ROLES) {
        const roleResult = await queryRunner.query(
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
        const resourcePermissions = panelPermissionsToResourceArray(defaultPermissions);

        await queryRunner.query(
          `
          INSERT INTO "${schemaName}"."tenant_role_permissions" (
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
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the role to ensure it exists and is not being deleted
      const roleResult = await queryRunner.query(
        `SELECT id, name, is_system FROM "${schemaName}"."tenant_roles" WHERE id = $1 FOR UPDATE`,
        [roleId],
      );

      if (roleResult.length === 0) {
        throw new NotFoundException(`Role with ID "${roleId}" not found`);
      }

      // Check for existing active assignment (with lock to prevent duplicates)
      const existingAssignment = await queryRunner.query(
        `
        SELECT id, is_active
        FROM "${schemaName}"."user_role_assignments"
        WHERE user_id = $1 AND role_id = $2
        FOR UPDATE
        `,
        [userId, roleId],
      );

      let assignmentId: string;

      if (existingAssignment.length > 0) {
        // Reactivate existing assignment if inactive
        if (!existingAssignment[0].is_active) {
          await queryRunner.query(
            `
            UPDATE "${schemaName}"."user_role_assignments"
            SET is_active = true, assigned_by = $1, assigned_at = NOW(), updated_at = NOW()
            WHERE id = $2
            `,
            [assignedBy, existingAssignment[0].id],
          );
        }
        assignmentId = existingAssignment[0].id;
      } else {
        // Create new assignment
        const insertResult = await queryRunner.query(
          `
          INSERT INTO "${schemaName}"."user_role_assignments" (
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
    removedBy: string,
  ): Promise<boolean> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the assignment row
      const assignment = await queryRunner.query(
        `
        SELECT id, is_active
        FROM "${schemaName}"."user_role_assignments"
        WHERE user_id = $1 AND role_id = $2 AND is_active = true
        FOR UPDATE
        `,
        [userId, roleId],
      );

      if (assignment.length === 0) {
        throw new NotFoundException(`Active role assignment not found for user ${userId} and role ${roleId}`);
      }

      // Soft delete the assignment
      await queryRunner.query(
        `
        UPDATE "${schemaName}"."user_role_assignments"
        SET is_active = false, removed_by = $1, removed_at = NOW(), updated_at = NOW()
        WHERE id = $2
        `,
        [removedBy, assignment[0].id],
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
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the target role
      const roleResult = await queryRunner.query(
        `SELECT * FROM "${schemaName}"."tenant_roles" WHERE id = $1 FOR UPDATE`,
        [roleId],
      );

      if (roleResult.length === 0) {
        throw new NotFoundException(`Role with ID "${roleId}" not found`);
      }

      // Lock and unset any current default roles
      await queryRunner.query(
        `
        UPDATE "${schemaName}"."tenant_roles"
        SET is_default = false, updated_at = NOW()
        WHERE is_default = true AND id != $1
        `,
        [roleId],
      );

      // Set the new default role
      await queryRunner.query(
        `
        UPDATE "${schemaName}"."tenant_roles"
        SET is_default = true, updated_at = NOW()
        WHERE id = $1
        `,
        [roleId],
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
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | null,
      color: row.color as string,
      icon: row.icon as string,
      level: row.level as number,
      isSystem: row.is_system as boolean,
      isDefault: row.is_default as boolean,
      userCount: (row.user_count as number) || 0,
      permissions: row.permission_id
        ? {
            id: row.permission_id as string,
            roleId: row.id as string,
            panelPermissions:
              typeof row.panel_permissions === 'string'
                ? JSON.parse(row.panel_permissions)
                : (row.panel_permissions as Record<string, Record<string, Record<string, boolean>>>) || {},
            resourcePermissions: (row.resource_permissions as string[]) || [],
          }
        : null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
