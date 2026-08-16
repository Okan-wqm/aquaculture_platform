import { Injectable } from '@nestjs/common';
import {
  PLATFORM_ROLE_CODES,
  PLATFORM_ROLE_DEFINITIONS,
  Role,
  isPlatformRole,
  type PlatformPermissionMode,
  type PlatformRoleDefinition,
} from '@platform/identity';
import {
  TENANT_PERMISSION_CATEGORIES,
  TENANT_PERMISSION_CODES,
  type TenantPermissionCode,
} from '@platform/tenant-permissions';

export interface Permission {
  readonly code: TenantPermissionCode;
  readonly name: string;
  readonly description: string;
  readonly category: string;
}

export interface RoleTemplate extends PlatformRoleDefinition {
  readonly permissions: readonly TenantPermissionCode[];
  readonly isSystem: true;
}

export interface RoleHierarchyItem extends PlatformRoleDefinition {
  readonly isSystem: true;
  readonly permissionCount: number;
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/u)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function permissionCatalogue(): readonly Permission[] {
  const permissions: Permission[] = [];
  for (const [categoryCode, category] of Object.entries(TENANT_PERMISSION_CATEGORIES)) {
    for (const [resourceCode, resource] of Object.entries(category.resources)) {
      for (const action of resource.actions) {
        const code = `${resourceCode}:${action}`;
        const canonical = TENANT_PERMISSION_CODES.find((permission) => permission === code);
        if (canonical === undefined) {
          throw new TypeError(`permission catalogue did not derive ${code}`);
        }
        permissions.push(
          Object.freeze({
            code: canonical,
            name: `${titleCase(action)} ${resource.name}`,
            description: `${titleCase(action)} access for ${resource.name}`,
            category: category.name || categoryCode,
          }),
        );
      }
    }
  }
  return Object.freeze(permissions.sort((left, right) => left.code.localeCompare(right.code)));
}

const PERMISSIONS = permissionCatalogue();

function permissionsForMode(mode: PlatformPermissionMode): readonly TenantPermissionCode[] {
  return mode === 'all' ? TENANT_PERMISSION_CODES : Object.freeze([]);
}

function roleTemplate(definition: PlatformRoleDefinition): RoleTemplate {
  return Object.freeze({
    ...definition,
    permissions: permissionsForMode(definition.permissionMode),
    isSystem: true,
  });
}

const ROLE_TEMPLATES: Readonly<Record<Role, RoleTemplate>> = Object.freeze({
  [Role.SUPER_ADMIN]: roleTemplate(PLATFORM_ROLE_DEFINITIONS[Role.SUPER_ADMIN]),
  [Role.TENANT_ADMIN]: roleTemplate(PLATFORM_ROLE_DEFINITIONS[Role.TENANT_ADMIN]),
  [Role.MODULE_MANAGER]: roleTemplate(PLATFORM_ROLE_DEFINITIONS[Role.MODULE_MANAGER]),
  [Role.MODULE_USER]: roleTemplate(PLATFORM_ROLE_DEFINITIONS[Role.MODULE_USER]),
});

/**
 * Read-only projection of the canonical platform roles and tenant capability
 * catalogue. Tenant-specific grants remain owned by auth-service; this service
 * never fabricates a static grant set for MODULE_MANAGER or MODULE_USER.
 */
@Injectable()
export class RoleTemplateService {
  getAllPermissions(): readonly Permission[] {
    return PERMISSIONS;
  }

  getPermissionsByCategory(): Readonly<Record<string, readonly Permission[]>> {
    const grouped: Record<string, Permission[]> = {};
    for (const permission of PERMISSIONS) {
      const category = grouped[permission.category] ?? [];
      category.push(permission);
      grouped[permission.category] = category;
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(grouped).map(([category, permissions]) => [
          category,
          Object.freeze(permissions),
        ]),
      ),
    );
  }

  getAllRoleTemplates(): readonly RoleTemplate[] {
    return Object.freeze(PLATFORM_ROLE_CODES.map((role) => ROLE_TEMPLATES[role]));
  }

  getRoleTemplate(code: string): RoleTemplate | undefined {
    return isPlatformRole(code) ? ROLE_TEMPLATES[code] : undefined;
  }

  getAssignableRoles(userRoleCode: string): readonly RoleTemplate[] {
    const userRole = this.getRoleTemplate(userRoleCode);
    if (userRole === undefined) return Object.freeze([]);
    if (userRole.code === Role.SUPER_ADMIN) return this.getAllRoleTemplates();
    return Object.freeze(this.getAllRoleTemplates().filter((role) => role.level < userRole.level));
  }

  getRolePermissions(roleCode: string): readonly TenantPermissionCode[] {
    return this.getRoleTemplate(roleCode)?.permissions ?? Object.freeze([]);
  }

  getRoleHierarchy(): readonly RoleHierarchyItem[] {
    return Object.freeze(
      this.getAllRoleTemplates()
        .map((role) =>
          Object.freeze({
            code: role.code,
            name: role.name,
            description: role.description,
            level: role.level,
            permissionMode: role.permissionMode,
            color: role.color,
            icon: role.icon,
            isSystem: true as const,
            permissionCount: role.permissions.length,
          }),
        )
        .sort((left, right) => right.level - left.level),
    );
  }

  canAssignRole(
    assignerRole: string,
    targetRole: string,
  ): { readonly allowed: boolean; readonly reason?: string } {
    const assigner = this.getRoleTemplate(assignerRole);
    if (assigner === undefined) return { allowed: false, reason: 'Invalid assigner role' };
    const target = this.getRoleTemplate(targetRole);
    if (target === undefined) return { allowed: false, reason: 'Invalid target role' };
    if (assigner.code === Role.SUPER_ADMIN) return { allowed: true };
    if (target.level >= assigner.level) {
      return {
        allowed: false,
        reason: `Cannot assign ${target.name} from ${assigner.name}`,
      };
    }
    return { allowed: true };
  }
}
