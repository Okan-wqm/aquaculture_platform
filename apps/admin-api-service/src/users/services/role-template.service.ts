import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Permission definition
 */
export interface Permission {
  code: string;
  name: string;
  description: string;
  category: string;
}

/**
 * Role template definition
 */
export interface RoleTemplate {
  code: string;
  name: string;
  description: string;
  level: number; // Higher = more permissions
  permissions: string[];
  isSystem: boolean; // System roles cannot be modified
  color: string;
  icon: string;
}

/**
 * Custom role for a tenant
 */
export interface TenantCustomRole {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  baseRole: string;
  permissions: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Role Template Service
 * Manages role templates and custom tenant roles
 */
@Injectable()
export class RoleTemplateService {
  private readonly logger = new Logger(RoleTemplateService.name);

  // System-wide permissions
  private readonly permissions: Permission[] = [
    // Dashboard
    { code: 'dashboard:view', name: 'View Dashboard', description: 'Access to main dashboard', category: 'Dashboard' },
    { code: 'dashboard:analytics', name: 'View Analytics', description: 'Access to analytics and reports', category: 'Dashboard' },

    // User Management
    { code: 'users:view', name: 'View Users', description: 'View user list', category: 'Users' },
    { code: 'users:create', name: 'Create Users', description: 'Create new users', category: 'Users' },
    { code: 'users:edit', name: 'Edit Users', description: 'Edit user details', category: 'Users' },
    { code: 'users:delete', name: 'Delete Users', description: 'Delete users', category: 'Users' },
    { code: 'users:invite', name: 'Invite Users', description: 'Send user invitations', category: 'Users' },
    { code: 'users:roles', name: 'Manage Roles', description: 'Assign roles to users', category: 'Users' },

    // Farm Management
    { code: 'farms:view', name: 'View Farms', description: 'View farm list and details', category: 'Farms' },
    { code: 'farms:create', name: 'Create Farms', description: 'Create new farms', category: 'Farms' },
    { code: 'farms:edit', name: 'Edit Farms', description: 'Edit farm details', category: 'Farms' },
    { code: 'farms:delete', name: 'Delete Farms', description: 'Delete farms', category: 'Farms' },
    { code: 'farms:manage', name: 'Manage Farms', description: 'Full farm management', category: 'Farms' },

    // Pond Management
    { code: 'ponds:view', name: 'View Ponds', description: 'View pond list and details', category: 'Ponds' },
    { code: 'ponds:create', name: 'Create Ponds', description: 'Create new ponds', category: 'Ponds' },
    { code: 'ponds:edit', name: 'Edit Ponds', description: 'Edit pond details', category: 'Ponds' },
    { code: 'ponds:delete', name: 'Delete Ponds', description: 'Delete ponds', category: 'Ponds' },

    // Sensor Management
    { code: 'sensors:view', name: 'View Sensors', description: 'View sensor list and data', category: 'Sensors' },
    { code: 'sensors:create', name: 'Create Sensors', description: 'Add new sensors', category: 'Sensors' },
    { code: 'sensors:edit', name: 'Edit Sensors', description: 'Edit sensor configuration', category: 'Sensors' },
    { code: 'sensors:delete', name: 'Delete Sensors', description: 'Remove sensors', category: 'Sensors' },
    { code: 'sensors:calibrate', name: 'Calibrate Sensors', description: 'Calibrate sensor readings', category: 'Sensors' },

    // Alert Management
    { code: 'alerts:view', name: 'View Alerts', description: 'View alerts and notifications', category: 'Alerts' },
    { code: 'alerts:create', name: 'Create Alert Rules', description: 'Create alert rules', category: 'Alerts' },
    { code: 'alerts:edit', name: 'Edit Alert Rules', description: 'Edit alert rules', category: 'Alerts' },
    { code: 'alerts:delete', name: 'Delete Alert Rules', description: 'Delete alert rules', category: 'Alerts' },
    { code: 'alerts:acknowledge', name: 'Acknowledge Alerts', description: 'Mark alerts as acknowledged', category: 'Alerts' },

    // Feed Management
    { code: 'feed:view', name: 'View Feed', description: 'View feed inventory and schedules', category: 'Feed' },
    { code: 'feed:create', name: 'Create Feed Records', description: 'Add feed records', category: 'Feed' },
    { code: 'feed:edit', name: 'Edit Feed Records', description: 'Edit feed records', category: 'Feed' },
    { code: 'feed:schedule', name: 'Manage Feed Schedules', description: 'Create and manage feeding schedules', category: 'Feed' },

    // Reports
    { code: 'reports:view', name: 'View Reports', description: 'Access to reports', category: 'Reports' },
    { code: 'reports:create', name: 'Create Reports', description: 'Generate custom reports', category: 'Reports' },
    { code: 'reports:export', name: 'Export Reports', description: 'Export reports to files', category: 'Reports' },

    // Settings
    { code: 'settings:view', name: 'View Settings', description: 'View system settings', category: 'Settings' },
    { code: 'settings:edit', name: 'Edit Settings', description: 'Modify system settings', category: 'Settings' },

    // Billing (Tenant Admin only)
    { code: 'billing:view', name: 'View Billing', description: 'View billing information', category: 'Billing' },
    { code: 'billing:manage', name: 'Manage Billing', description: 'Manage billing and subscriptions', category: 'Billing' },

    // Audit
    { code: 'audit:view', name: 'View Audit Logs', description: 'Access audit log history', category: 'Audit' },

    // API
    { code: 'api:manage', name: 'Manage API Keys', description: 'Create and manage API keys', category: 'API' },
  ];

  // System role templates
  private readonly roleTemplates: RoleTemplate[] = [
    {
      code: 'SUPER_ADMIN',
      name: 'Super Admin',
      description: 'Platform-wide administrator with full system access',
      level: 100,
      permissions: ['*'], // All permissions
      isSystem: true,
      color: '#FF0000',
      icon: 'shield-check',
    },
    {
      code: 'TENANT_ADMIN',
      name: 'Tenant Admin',
      description: 'Tenant administrator with full tenant access',
      level: 90,
      permissions: [
        'dashboard:view',
        'dashboard:analytics',
        'users:view',
        'users:create',
        'users:edit',
        'users:delete',
        'users:invite',
        'users:roles',
        'farms:view',
        'farms:create',
        'farms:edit',
        'farms:delete',
        'farms:manage',
        'ponds:view',
        'ponds:create',
        'ponds:edit',
        'ponds:delete',
        'sensors:view',
        'sensors:create',
        'sensors:edit',
        'sensors:delete',
        'sensors:calibrate',
        'alerts:view',
        'alerts:create',
        'alerts:edit',
        'alerts:delete',
        'alerts:acknowledge',
        'feed:view',
        'feed:create',
        'feed:edit',
        'feed:schedule',
        'reports:view',
        'reports:create',
        'reports:export',
        'settings:view',
        'settings:edit',
        'billing:view',
        'billing:manage',
        'audit:view',
        'api:manage',
      ],
      isSystem: true,
      color: '#6366F1',
      icon: 'user-cog',
    },
    {
      code: 'MODULE_MANAGER',
      name: 'Module Manager',
      description: 'Manager with access to assigned modules',
      level: 70,
      permissions: [
        'dashboard:view',
        'dashboard:analytics',
        'users:view',
        'users:invite',
        'farms:view',
        'farms:create',
        'farms:edit',
        'ponds:view',
        'ponds:create',
        'ponds:edit',
        'sensors:view',
        'sensors:create',
        'sensors:edit',
        'sensors:calibrate',
        'alerts:view',
        'alerts:create',
        'alerts:edit',
        'alerts:acknowledge',
        'feed:view',
        'feed:create',
        'feed:edit',
        'feed:schedule',
        'reports:view',
        'reports:create',
        'reports:export',
        'settings:view',
      ],
      isSystem: true,
      color: '#10B981',
      icon: 'briefcase',
    },
    {
      code: 'SUPERVISOR',
      name: 'Supervisor',
      description: 'Supervisor with limited management capabilities',
      level: 50,
      permissions: [
        'dashboard:view',
        'users:view',
        'farms:view',
        'ponds:view',
        'ponds:edit',
        'sensors:view',
        'sensors:calibrate',
        'alerts:view',
        'alerts:acknowledge',
        'feed:view',
        'feed:create',
        'feed:edit',
        'reports:view',
        'reports:create',
      ],
      isSystem: false,
      color: '#F59E0B',
      icon: 'clipboard-check',
    },
    {
      code: 'OPERATOR',
      name: 'Operator',
      description: 'Field operator with basic operational access',
      level: 30,
      permissions: [
        'dashboard:view',
        'farms:view',
        'ponds:view',
        'sensors:view',
        'alerts:view',
        'alerts:acknowledge',
        'feed:view',
        'feed:create',
      ],
      isSystem: false,
      color: '#3B82F6',
      icon: 'wrench',
    },
    {
      code: 'MODULE_USER',
      name: 'Viewer',
      description: 'Read-only access to assigned modules',
      level: 10,
      permissions: [
        'dashboard:view',
        'farms:view',
        'ponds:view',
        'sensors:view',
        'alerts:view',
        'feed:view',
        'reports:view',
      ],
      isSystem: true,
      color: '#6B7280',
      icon: 'eye',
    },
  ];

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get all system permissions
   */
  getAllPermissions(): Permission[] {
    return this.permissions;
  }

  /**
   * Get permissions grouped by category
   */
  getPermissionsByCategory(): Record<string, Permission[]> {
    return this.permissions.reduce(
      (acc, perm) => {
        if (!acc[perm.category]) {
          acc[perm.category] = [];
        }
        const categoryPerms = acc[perm.category];
        if (categoryPerms) {
          categoryPerms.push(perm);
        }
        return acc;
      },
      {} as Record<string, Permission[]>,
    );
  }

  /**
   * Get all role templates
   */
  getAllRoleTemplates(): RoleTemplate[] {
    return this.roleTemplates;
  }

  /**
   * Get role template by code
   */
  getRoleTemplate(code: string): RoleTemplate | undefined {
    return this.roleTemplates.find((r) => r.code === code);
  }

  /**
   * Get available roles for a user level
   * Users can only assign roles at their level or below
   */
  getAssignableRoles(userRoleCode: string): RoleTemplate[] {
    const userRole = this.roleTemplates.find((r) => r.code === userRoleCode);
    if (!userRole) {
      return [];
    }

    return this.roleTemplates.filter((r) => r.level <= userRole.level);
  }

  /**
   * Check if user has a specific permission
   */
  hasPermission(roleCode: string, permissionCode: string): boolean {
    const role = this.roleTemplates.find((r) => r.code === roleCode);
    if (!role) {
      return false;
    }

    // Wildcard means all permissions
    if (role.permissions.includes('*')) {
      return true;
    }

    return role.permissions.includes(permissionCode);
  }

  /**
   * Get permissions for a role
   */
  getRolePermissions(roleCode: string): string[] {
    const role = this.roleTemplates.find((r) => r.code === roleCode);
    if (!role) {
      return [];
    }

    // Wildcard means all permissions
    if (role.permissions.includes('*')) {
      return this.permissions.map((p) => p.code);
    }

    return role.permissions;
  }

  /**
   * Create a custom role for a tenant
   */
  async createCustomRole(
    tenantId: string,
    name: string,
    description: string,
    baseRole: string,
    permissions: string[],
    createdBy: string,
  ): Promise<TenantCustomRole> {
    // Validate base role
    const baseTemplate = this.getRoleTemplate(baseRole);
    if (!baseTemplate) {
      throw new Error(`Invalid base role: ${baseRole}`);
    }

    // Custom roles can only have permissions from base role or less
    const basePermissions = this.getRolePermissions(baseRole);
    const validPermissions = permissions.filter((p) =>
      basePermissions.includes(p),
    );

    // Insert custom role
    const result = await this.dataSource.query(
      `
      INSERT INTO tenant_custom_roles (
        id, tenant_id, name, description, base_role, permissions,
        created_by, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, NOW(), NOW()
      )
      RETURNING *
    `,
      [
        tenantId,
        name,
        description,
        baseRole,
        JSON.stringify(validPermissions),
        createdBy,
      ],
    );

    this.logger.log(
      `Created custom role '${name}' for tenant ${tenantId} based on ${baseRole}`,
    );

    return {
      id: result[0].id,
      tenantId: result[0].tenant_id,
      name: result[0].name,
      description: result[0].description,
      baseRole: result[0].base_role,
      permissions: JSON.parse(result[0].permissions),
      createdBy: result[0].created_by,
      createdAt: result[0].created_at,
      updatedAt: result[0].updated_at,
    };
  }

  /**
   * Get custom roles for a tenant
   */
  async getTenantCustomRoles(tenantId: string): Promise<TenantCustomRole[]> {
    try {
      const result = await this.dataSource.query(
        `SELECT * FROM tenant_custom_roles WHERE tenant_id = $1 ORDER BY name`,
        [tenantId],
      );

      return result.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        tenantId: row.tenant_id as string,
        name: row.name as string,
        description: row.description as string,
        baseRole: row.base_role as string,
        permissions: JSON.parse(row.permissions as string),
        createdBy: row.created_by as string,
        createdAt: row.created_at as Date,
        updatedAt: row.updated_at as Date,
      }));
    } catch (error) {
      // Table might not exist yet
      this.logger.warn(`Could not fetch custom roles: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Get role hierarchy for display
   */
  getRoleHierarchy(): Array<{
    code: string;
    name: string;
    level: number;
    description: string;
    color: string;
    icon: string;
    isSystem: boolean;
    permissionCount: number;
  }> {
    return this.roleTemplates
      .map((r) => ({
        code: r.code,
        name: r.name,
        level: r.level,
        description: r.description,
        color: r.color,
        icon: r.icon,
        isSystem: r.isSystem,
        permissionCount:
          r.permissions.includes('*')
            ? this.permissions.length
            : r.permissions.length,
      }))
      .sort((a, b) => b.level - a.level);
  }

  /**
   * Validate role assignment
   */
  canAssignRole(
    assignerRole: string,
    targetRole: string,
  ): { allowed: boolean; reason?: string } {
    const assignerTemplate = this.getRoleTemplate(assignerRole);
    const targetTemplate = this.getRoleTemplate(targetRole);

    if (!assignerTemplate) {
      return { allowed: false, reason: 'Invalid assigner role' };
    }

    if (!targetTemplate) {
      return { allowed: false, reason: 'Invalid target role' };
    }

    // SUPER_ADMIN can assign any role
    if (assignerRole === 'SUPER_ADMIN') {
      return { allowed: true };
    }

    // Cannot assign roles higher than your own
    if (targetTemplate.level > assignerTemplate.level) {
      return {
        allowed: false,
        reason: `Cannot assign ${targetTemplate.name} role (level ${targetTemplate.level}) as your role level is ${assignerTemplate.level}`,
      };
    }

    // Cannot assign same level (except for SUPER_ADMIN)
    if (targetTemplate.level === assignerTemplate.level) {
      return {
        allowed: false,
        reason: `Cannot assign role at your own level`,
      };
    }

    return { allowed: true };
  }
}
