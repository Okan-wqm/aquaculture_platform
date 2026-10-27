import { Role } from '@aquaculture/backend-common/decorators';
import {
  TENANT_CAPABILITY_CATALOGUE,
  colors,
  isTenantCapability,
  type TenantCapability,
} from '@aquaculture/shared-contracts';
import { Injectable } from '@nestjs/common';

/**
 * Permission definition
 */
export interface Permission {
  code: TenantCapability;
  name: string;
  description: string;
  category: string;
}

/** A template's "every tenant capability" — the account roles' holding (ADR-051 §1). */
export const ALL_TENANT_CAPABILITIES = '*';

/**
 * Role template definition
 */
export interface RoleTemplate {
  /**
   * The platform role this template describes.
   *
   * Typed `Role`, not `string`: the catalogue published a template with code
   * `OPERATOR` — a role the platform does not define and no guard, hierarchy
   * or DTO recognises — and the admin-panel's invite form rendered it as a
   * choice (ADMIN-CRITICAL-133). A `string` here let that sit for as long as
   * nobody picked it.
   */
  code: Role;
  name: string;
  description: string;
  level: number; // Higher = more permissions
  /**
   * The tenant capabilities the role holds by itself: a catalogue capability or
   * `ALL_TENANT_CAPABILITIES`. Typed so a template cannot name a key the catalogue does not
   * offer (RBAC-HIGH-025: this list once held `farms:view`, `users:create`, `billing:manage`,
   * … that no catalogue, guard or role editor knew).
   */
  permissions: ReadonlyArray<TenantCapability | typeof ALL_TENANT_CAPABILITIES>;
  isSystem: boolean; // System roles cannot be modified
  color: string;
  icon: string;
}

/**
 * Every tenant capability as the one catalogue declares it (`TENANT_CAPABILITY_CATALOGUE`,
 * @aquaculture/shared-contracts). This service publishes no capability list of its own: the
 * second list it kept drifted into keys nothing enforced (RBAC-HIGH-025).
 */
function cataloguePermissions(): Permission[] {
  return Object.values(TENANT_CAPABILITY_CATALOGUE).flatMap((category) =>
    Object.entries(category.resources).flatMap(([resource, definition]) =>
      definition.actions.flatMap((action) => {
        const code = `${resource}:${action}`;
        return isTenantCapability(code)
          ? [
              {
                code,
                name: `${definition.name}: ${action.replace(/_/g, ' ')}`,
                description: `${category.name} — ${definition.name}`,
                category: category.name,
              },
            ]
          : [];
      }),
    ),
  );
}

/**
 * Role Template Service
 * Manages role templates and custom tenant roles
 */
@Injectable()
export class RoleTemplateService {
  // Tenant capabilities, read from the one catalogue.
  private readonly permissions: Permission[] = cataloguePermissions();

  /**
   * The role templates the platform publishes — one per `Role`, no more.
   *
   * Two extra templates lived here, `SUPERVISOR` and `OPERATOR`, the only two
   * marked `isSystem: false`. Neither names a `Role`, so no guard ranked them,
   * no hierarchy inherited from them and every DTO rejected them — yet the
   * admin-panel's invite form listed both as choices, because it renders
   * whatever this catalogue returns. Picking either produced a 400 the operator
   * had no way to predict (ADMIN-CRITICAL-133). `code: Role` now makes a
   * template for a role the platform does not define a compile error.
   *
   * What each holds follows ADR-051 §1: an account role (SUPER_ADMIN,
   * TENANT_ADMIN) holds every tenant capability; a module role holds none by
   * itself — a member holds exactly the capabilities of the tenant role an
   * administrator assigns them.
   */
  private readonly roleTemplates: RoleTemplate[] = [
    {
      code: Role.SUPER_ADMIN,
      name: 'Super Admin',
      description: 'Platform-wide administrator with full system access',
      level: 100,
      permissions: [ALL_TENANT_CAPABILITIES],
      isSystem: true,
      color: colors.error[500],
      icon: 'shield-check',
    },
    {
      code: Role.TENANT_ADMIN,
      name: 'Tenant Admin',
      description: 'Tenant administrator with full tenant access',
      level: 90,
      permissions: [ALL_TENANT_CAPABILITIES],
      isSystem: true,
      color: colors.primary[500],
      icon: 'user-cog',
    },
    {
      code: Role.MODULE_MANAGER,
      name: 'Module Manager',
      description:
        'Manager with access to assigned modules; holds the capabilities of their tenant role',
      level: 70,
      permissions: [],
      isSystem: true,
      color: colors.success[400],
      icon: 'briefcase',
    },
    {
      code: Role.MODULE_USER,
      name: 'Viewer',
      description:
        'Read-only access to assigned modules; holds the capabilities of their tenant role',
      level: 10,
      permissions: [],
      isSystem: true,
      color: colors.gray[400],
      icon: 'eye',
    },
  ];

  // RBAC-MEDIUM-011: this is a pure in-memory role/permission CATALOGUE
  // reference (getAllPermissions/getPermissionsByCategory/getRoleTemplates/…),
  // consumed read-only by the SUPER_ADMIN role-reference endpoints. It has no
  // DataSource: the former createCustomRole/getTenantCustomRoles wrote/read an
  // unqualified `tenant_custom_roles` table that NO migration creates (every
  // call threw "relation does not exist" or swallowed it and returned []) and
  // had zero callers — dead code, removed. Tenant-configurable roles are owned
  // by the auth-service tenant-RBAC system (auth.tenant_roles /
  // tenant_role_permissions), NOT this catalogue.

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

    return role.permissions.some(
      (held) => held === ALL_TENANT_CAPABILITIES || held === permissionCode,
    );
  }

  /**
   * Get permissions for a role
   */
  getRolePermissions(roleCode: string): string[] {
    const role = this.roleTemplates.find((r) => r.code === roleCode);
    if (!role) {
      return [];
    }

    if (role.permissions.includes(ALL_TENANT_CAPABILITIES)) {
      return this.permissions.map((p) => p.code);
    }

    return [...role.permissions];
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
        permissionCount: r.permissions.includes(ALL_TENANT_CAPABILITIES)
          ? this.permissions.length
          : r.permissions.length,
      }))
      .sort((a, b) => b.level - a.level);
  }

  /**
   * Validate role assignment
   */
  canAssignRole(assignerRole: string, targetRole: string): { allowed: boolean; reason?: string } {
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
