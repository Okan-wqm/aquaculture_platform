import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { getRequestFromArgumentsHost } from '../context/execution-context-request';
import { ROLES_KEY, Role, IS_PUBLIC_KEY, roleHasPermission } from '../decorators/roles.decorator';

/**
 * User with role(s) - supports both single role and multiple roles
 */
interface UserWithRoles {
  sub?: string;
  userId?: string;
  role?: string | Role;
  roles?: (string | Role)[];
  tenantId?: string | null;
}

/**
 * Roles Guard
 *
 * Checks if user has required role(s) to access a resource.
 * Supports role hierarchy - higher roles inherit lower role permissions.
 *
 * SECURITY:
 * - Generic error messages to prevent user enumeration
 * - Requires authentication unless @Public() decorator is used
 * - Uses role hierarchy for permission inheritance
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  // WHY: Explicit @Inject() — design:paramtypes may not survive all build/runtime environments.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Check if endpoint is public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Get required roles from decorator
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Get user from request
    const user = this.getUser(context);

    // SECURITY: Generic message to prevent information disclosure
    const accessDeniedMessage = 'Access denied';

    // SECURITY FIX: Always require authenticated user unless endpoint is public
    if (!requiredRoles || requiredRoles.length === 0) {
      // Require at least an authenticated user when no specific roles are defined
      if (!user) {
        throw new ForbiddenException(accessDeniedMessage);
      }
      return true;
    }

    if (!user) {
      throw new ForbiddenException(accessDeniedMessage);
    }

    // Get user roles - support both single role and roles array
    const userRoles = this.extractUserRoles(user);

    if (userRoles.length === 0) {
      this.logger.debug(`User ${user.sub || user.userId} has no roles assigned`);
      throw new ForbiddenException(accessDeniedMessage);
    }

    // Check if user has any of the required roles (with hierarchy support)
    const hasRequiredRole = this.checkRoleAccess(userRoles, requiredRoles);

    if (!hasRequiredRole) {
      this.logger.debug(
        `Access denied for user ${user.sub || user.userId}: ` +
          `has [${userRoles.join(', ')}], needs one of [${requiredRoles.join(', ')}]`,
      );
      throw new ForbiddenException(accessDeniedMessage);
    }

    return true;
  }

  /**
   * Extract user roles from various formats
   * Handles both single role and roles array
   */
  private extractUserRoles(user: UserWithRoles): Role[] {
    const roles: Role[] = [];

    // Handle roles array
    if (Array.isArray(user.roles)) {
      for (const role of user.roles) {
        if (this.isValidRole(role)) {
          // Normalize to uppercase to match Role enum
          const normalized = String(role).toUpperCase() as Role;
          if (!roles.includes(normalized)) {
            roles.push(normalized);
          }
        }
      }
    }

    // Handle single role (backward compatibility)
    if (user.role && this.isValidRole(user.role)) {
      const normalized = String(user.role).toUpperCase() as Role;
      if (!roles.includes(normalized)) {
        roles.push(normalized);
      }
    }

    return roles;
  }

  /**
   * Check if a role string is a valid Role enum value.
   * Performs case-insensitive comparison and warns on case mismatch.
   */
  private isValidRole(role: string | Role): boolean {
    if (Object.values(Role).includes(role as Role)) {
      return true;
    }
    // Case-insensitive fallback: check if the role matches when uppercased
    const upperRole = String(role).toUpperCase();
    if (Object.values(Role).includes(upperRole as Role)) {
      this.logger.warn(
        `Role "${role}" matched after case normalization to "${upperRole}". ` +
          `JWT should emit Role enum values in uppercase (e.g., SUPER_ADMIN).`,
      );
      return true;
    }
    return false;
  }

  /**
   * Check if user has access based on role hierarchy
   */
  private checkRoleAccess(userRoles: Role[], requiredRoles: Role[]): boolean {
    for (const userRole of userRoles) {
      // Super admin has access to everything
      if (userRole === Role.SUPER_ADMIN) {
        return true;
      }

      // Direct role match or hierarchy match
      for (const requiredRole of requiredRoles) {
        if (roleHasPermission(userRole, requiredRole)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get user from request context
   */
  private getUser(context: ExecutionContext): UserWithRoles | undefined {
    return getRequestFromArgumentsHost<{ user?: UserWithRoles }>(context)?.user;
  }
}
