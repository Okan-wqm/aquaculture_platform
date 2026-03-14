import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { REQUIRED_TENANT_PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import { IS_PUBLIC_KEY, Role } from '../decorators/roles.decorator';

/**
 * User payload shape expected on request.user (subset of CurrentUserPayload / JWT)
 */
interface UserWithPermissions {
  sub?: string;
  userId?: string;
  role?: string | Role;
  roles?: (string | Role)[];
  tenantId?: string | null;
  resourcePermissions?: string[];
}

/**
 * TenantPermissionGuard
 *
 * Enforces fine-grained, resource-level permissions for tenant users.
 * Works with the @RequireTenantPermission() decorator.
 *
 * Design decisions:
 * - Opt-in: If no @RequireTenantPermission() decorator is present on the handler,
 *   the guard passes (returns true). This means existing routes are unaffected.
 * - SUPER_ADMIN and TENANT_ADMIN always bypass (they have full access).
 * - For MODULE_MANAGER and MODULE_USER, every required permission must be present
 *   in the user's `resourcePermissions` JWT claim.
 * - @Public() endpoints are also bypassed.
 *
 * Guard ordering recommendation:
 *   JwtAuthGuard -> RolesGuard -> TenantGuard -> TenantPermissionGuard
 *
 * Register per-controller or per-route with @UseGuards(TenantPermissionGuard).
 * Do NOT register as APP_GUARD -- this is opt-in via decorator.
 */
@Injectable()
export class TenantPermissionGuard implements CanActivate {
  private readonly logger = new Logger(TenantPermissionGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Skip if endpoint is public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Get required permissions from decorator (handler-level takes precedence, then class-level)
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_TENANT_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Opt-in: No decorator means no permission check needed
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const user = this.getUser(context);

    if (!user) {
      throw new ForbiddenException('Access denied');
    }

    // Normalize user roles to uppercase for comparison
    const userRoles = this.normalizeRoles(user);

    // SUPER_ADMIN and TENANT_ADMIN bypass -- full access
    if (userRoles.includes(Role.SUPER_ADMIN) || userRoles.includes(Role.TENANT_ADMIN)) {
      return true;
    }

    // For MODULE_MANAGER and MODULE_USER, check resource permissions
    const userPermissions = user.resourcePermissions || [];

    const hasAllPermissions = requiredPermissions.every((required) =>
      userPermissions.includes(required),
    );

    if (!hasAllPermissions) {
      const userId = user.sub || user.userId || 'unknown';
      const missing = requiredPermissions.filter((p) => !userPermissions.includes(p));
      this.logger.debug(
        `Permission denied for user ${userId}: missing [${missing.join(', ')}]`,
      );
      throw new ForbiddenException('Access denied');
    }

    return true;
  }

  /**
   * Extract and normalize user roles to Role enum values
   */
  private normalizeRoles(user: UserWithPermissions): Role[] {
    const roles: Role[] = [];
    const roleValues = Object.values(Role) as string[];

    // Handle roles array
    if (Array.isArray(user.roles)) {
      for (const r of user.roles) {
        const upper = String(r).toUpperCase();
        if (roleValues.includes(upper)) {
          roles.push(upper as Role);
        }
      }
    }

    // Handle single role (backward compatibility)
    if (user.role) {
      const upper = String(user.role).toUpperCase();
      if (roleValues.includes(upper) && !roles.includes(upper as Role)) {
        roles.push(upper as Role);
      }
    }

    return roles;
  }

  /**
   * Get user from request context (HTTP or GraphQL)
   */
  private getUser(context: ExecutionContext): UserWithPermissions | undefined {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      return gqlCtx.getContext().req?.user as UserWithPermissions | undefined;
    }

    return context.switchToHttp().getRequest()?.user as UserWithPermissions | undefined;
  }
}
