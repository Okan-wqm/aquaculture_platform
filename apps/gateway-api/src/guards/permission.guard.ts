/**
 * Permission Guard
 *
 * Enforces permission-based access control on routes.
 * Supports multiple permission check strategies: AND, OR, role-based.
 * Integrates with the authentication system for permission validation.
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';

import { JwtPayload, AuthenticatedRequest } from './auth.guard';

/**
 * Permission check mode
 */
export enum PermissionMode {
  ALL = 'all', // User must have ALL specified permissions (AND)
  ANY = 'any', // User must have ANY of the specified permissions (OR)
}

/**
 * Permission metadata key
 */
export const PERMISSIONS_KEY = 'permissions';
export const PERMISSION_MODE_KEY = 'permissionMode';
export const ROLES_KEY = 'roles';

/**
 * Decorator to require specific permissions (AND logic)
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Decorator to require any of the permissions (OR logic)
 */
export const RequireAnyPermission = (...permissions: string[]) => {
  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    SetMetadata(PERMISSIONS_KEY, permissions)(target, key as string | symbol, descriptor as PropertyDescriptor);
    SetMetadata(PERMISSION_MODE_KEY, PermissionMode.ANY)(target, key as string | symbol, descriptor as PropertyDescriptor);
    return descriptor;
  };
};

/**
 * Decorator to require specific roles
 */
export const RequireRoles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Resource-based permission check
 */
export interface ResourcePermission {
  resource: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'manage' | '*';
  condition?: (user: JwtPayload, resourceId?: string) => boolean;
}

/**
 * Resource permission metadata key
 */
export const RESOURCE_PERMISSION_KEY = 'resourcePermission';

/**
 * Decorator for resource-based permissions
 */
export const RequireResourcePermission = (permission: ResourcePermission) =>
  SetMetadata(RESOURCE_PERMISSION_KEY, permission);

/**
 * Role hierarchy definition
 */
const ROLE_HIERARCHY: Record<string, string[]> = {
  system_admin: ['tenant_admin', 'manager', 'operator', 'viewer'],
  tenant_admin: ['manager', 'operator', 'viewer'],
  manager: ['operator', 'viewer'],
  operator: ['viewer'],
  viewer: [],
};

/**
 * Default role permissions
 */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  system_admin: ['*'],
  tenant_admin: [
    'users:manage',
    'farms:manage',
    'sensors:manage',
    'alerts:manage',
    'reports:view',
    'settings:manage',
  ],
  manager: [
    'users:view',
    'farms:read',
    'farms:update',
    'sensors:read',
    'sensors:update',
    'alerts:read',
    'alerts:acknowledge',
    'reports:view',
  ],
  operator: [
    'farms:read',
    'sensors:read',
    'sensors:update',
    'alerts:read',
    'alerts:acknowledge',
  ],
  viewer: ['farms:read', 'sensors:read', 'alerts:read', 'reports:view'],
};

/**
 * Permission Guard
 * Enforces permission-based access control
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);
  private readonly permissionCache = new Map<
    string,
    { permissions: string[]; expiry: number }
  >();
  private readonly cacheTtl: number;
  private readonly enableAuditLog: boolean;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    this.cacheTtl = this.configService.get<number>('PERMISSION_CACHE_TTL', 300000);
    this.enableAuditLog = this.configService.get<boolean>('PERMISSION_AUDIT_LOG', true);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = this.getRequest(context);
    const user = (request as AuthenticatedRequest).user;

    if (!user) {
      throw new ForbiddenException({
        code: 'NOT_AUTHENTICATED',
        message: 'User is not authenticated',
      });
    }

    // Get required permissions from decorator
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Get required roles from decorator
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Get resource permission from decorator
    const resourcePermission = this.reflector.getAllAndOverride<ResourcePermission>(
      RESOURCE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Get permission mode
    const permissionMode =
      this.reflector.getAllAndOverride<PermissionMode>(PERMISSION_MODE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) || PermissionMode.ALL;

    // If no permission requirements, allow access
    if (!requiredPermissions && !requiredRoles && !resourcePermission) {
      return true;
    }

    // Get effective permissions for user
    const effectivePermissions = await this.getEffectivePermissions(user);

    // Check for wildcard permission (system admin)
    if (effectivePermissions.includes('*')) {
      this.auditAccess(user, 'wildcard', true, context);
      return true;
    }

    // Check roles
    if (requiredRoles && requiredRoles.length > 0) {
      const hasRole = this.checkRoles(user.roles, requiredRoles);
      if (!hasRole) {
        this.auditAccess(user, `roles:${requiredRoles.join(',')}`, false, context);
        throw new ForbiddenException({
          code: 'INSUFFICIENT_ROLE',
          message: 'User does not have required role',
          requiredRoles,
          userRoles: user.roles,
        });
      }
    }

    // Check permissions
    if (requiredPermissions && requiredPermissions.length > 0) {
      const hasPermissions = this.checkPermissions(
        effectivePermissions,
        requiredPermissions,
        permissionMode,
      );

      if (!hasPermissions) {
        this.auditAccess(
          user,
          `permissions:${requiredPermissions.join(',')}`,
          false,
          context,
        );
        throw new ForbiddenException({
          code: 'INSUFFICIENT_PERMISSION',
          message: 'User does not have required permissions',
          requiredPermissions,
          mode: permissionMode,
        });
      }
    }

    // Check resource-based permission
    if (resourcePermission) {
      const hasResourcePermission = this.checkResourcePermission(
        effectivePermissions,
        resourcePermission,
        user,
        request,
      );

      if (!hasResourcePermission) {
        this.auditAccess(
          user,
          `resource:${resourcePermission.resource}:${resourcePermission.action}`,
          false,
          context,
        );
        throw new ForbiddenException({
          code: 'INSUFFICIENT_RESOURCE_PERMISSION',
          message: 'User does not have permission for this resource action',
          resource: resourcePermission.resource,
          action: resourcePermission.action,
        });
      }
    }

    this.auditAccess(user, 'granted', true, context);
    return true;
  }

  /**
   * Get effective permissions for a user (including role-based)
   */
  private async getEffectivePermissions(user: JwtPayload): Promise<string[]> {
    const cacheKey = `${user.sub}:${user.tenantId}`;
    const cached = this.permissionCache.get(cacheKey);

    if (cached && cached.expiry > Date.now()) {
      return cached.permissions;
    }

    // Start with explicit user permissions
    const permissions = new Set<string>(user.permissions || []);

    // Add role-based permissions
    for (const role of user.roles) {
      const rolePerms = ROLE_PERMISSIONS[role] || [];
      for (const perm of rolePerms) {
        permissions.add(perm);
      }

      // Add inherited role permissions
      const inheritedRoles = ROLE_HIERARCHY[role] || [];
      for (const inheritedRole of inheritedRoles) {
        const inheritedPerms = ROLE_PERMISSIONS[inheritedRole] || [];
        for (const perm of inheritedPerms) {
          permissions.add(perm);
        }
      }
    }

    const effectivePermissions = Array.from(permissions);

    // Cache the result
    this.permissionCache.set(cacheKey, {
      permissions: effectivePermissions,
      expiry: Date.now() + this.cacheTtl,
    });

    return effectivePermissions;
  }

  /**
   * Check if user has required roles
   */
  private checkRoles(userRoles: string[], requiredRoles: string[]): boolean {
    // Check direct role match
    for (const required of requiredRoles) {
      if (userRoles.includes(required)) {
        return true;
      }

      // Check role hierarchy
      for (const userRole of userRoles) {
        const inheritedRoles = ROLE_HIERARCHY[userRole] || [];
        if (inheritedRoles.includes(required)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if user has required permissions
   */
  private checkPermissions(
    userPermissions: string[],
    requiredPermissions: string[],
    mode: PermissionMode,
  ): boolean {
    if (mode === PermissionMode.ANY) {
      return requiredPermissions.some((perm) =>
        this.hasPermission(userPermissions, perm),
      );
    }

    // PermissionMode.ALL
    return requiredPermissions.every((perm) =>
      this.hasPermission(userPermissions, perm),
    );
  }

  /**
   * Check if user has a specific permission
   */
  private hasPermission(userPermissions: string[], required: string): boolean {
    // Check exact match
    if (userPermissions.includes(required)) {
      return true;
    }

    // Check wildcard match (e.g., "farms:*" matches "farms:read")
    const [resource, action] = required.split(':');

    if (userPermissions.includes(`${resource}:*`)) {
      return true;
    }

    // Check "manage" permission includes all actions
    if (userPermissions.includes(`${resource}:manage`)) {
      return true;
    }

    return false;
  }

  /**
   * Check resource-based permission
   */
  private checkResourcePermission(
    userPermissions: string[],
    resourcePermission: ResourcePermission,
    user: JwtPayload,
    request: Request,
  ): boolean {
    const permissionString = `${resourcePermission.resource}:${resourcePermission.action}`;

    // Check if user has the permission
    if (!this.hasPermission(userPermissions, permissionString)) {
      return false;
    }

    // Check custom condition if provided
    if (resourcePermission.condition) {
      const resourceId = request.params['id'] || request.params['resourceId'];
      return resourcePermission.condition(user, resourceId);
    }

    return true;
  }

  /**
   * Get request from context
   */
  private getRequest(context: ExecutionContext): Request {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      return gqlContext.getContext().req;
    }

    return context.switchToHttp().getRequest<Request>();
  }

  /**
   * Audit access attempt
   */
  private auditAccess(
    user: JwtPayload,
    check: string,
    granted: boolean,
    context: ExecutionContext,
  ): void {
    if (!this.enableAuditLog) return;

    const handler = context.getHandler().name;
    const controller = context.getClass().name;

    const auditEntry = {
      timestamp: new Date().toISOString(),
      userId: user.sub,
      tenantId: user.tenantId,
      roles: user.roles,
      check,
      granted,
      handler: `${controller}.${handler}`,
    };

    if (granted) {
      this.logger.debug('Permission granted', auditEntry);
    } else {
      this.logger.warn('Permission denied', auditEntry);
    }
  }

  /**
   * Clear permission cache for a user
   */
  clearCache(userId: string, tenantId?: string): void {
    if (tenantId) {
      this.permissionCache.delete(`${userId}:${tenantId}`);
    } else {
      // Clear all entries for this user
      for (const key of this.permissionCache.keys()) {
        if (key.startsWith(`${userId}:`)) {
          this.permissionCache.delete(key);
        }
      }
    }
  }

  /**
   * Clear entire permission cache
   */
  clearAllCache(): void {
    this.permissionCache.clear();
  }
}

/**
 * Helper to check if user has permission
 */
export function userHasPermission(user: JwtPayload, permission: string): boolean {
  const permissions = user.permissions || [];

  // Check wildcard
  if (permissions.includes('*')) {
    return true;
  }

  // Check exact match
  if (permissions.includes(permission)) {
    return true;
  }

  // Check resource wildcard
  const [resource] = permission.split(':');
  if (permissions.includes(`${resource}:*`) || permissions.includes(`${resource}:manage`)) {
    return true;
  }

  // Check role-based permissions
  for (const role of user.roles) {
    const rolePerms = ROLE_PERMISSIONS[role] || [];
    if (rolePerms.includes('*') || rolePerms.includes(permission)) {
      return true;
    }
    if (rolePerms.includes(`${resource}:*`) || rolePerms.includes(`${resource}:manage`)) {
      return true;
    }
  }

  return false;
}

/**
 * Helper to check if user has role
 */
export function userHasRole(user: JwtPayload, role: string): boolean {
  if (user.roles.includes(role)) {
    return true;
  }

  // Check role hierarchy
  for (const userRole of user.roles) {
    const inheritedRoles = ROLE_HIERARCHY[userRole] || [];
    if (inheritedRoles.includes(role)) {
      return true;
    }
  }

  return false;
}
