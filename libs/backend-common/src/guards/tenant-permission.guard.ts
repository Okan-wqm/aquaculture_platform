import {
  Injectable,
  Inject,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { getRequestFromArgumentsHost } from '../context/execution-context-request';
import {
  REQUIRED_TENANT_PERMISSIONS_KEY,
  hasAllResourcePermissions,
} from '../decorators/require-permission.decorator';
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

  // WHY: Explicit @Inject() — design:paramtypes may not survive all build/runtime environments.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

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

    // Delegate the role-bypass + resource-permission membership to the shared
    // SSoT check (hasAllResourcePermissions) so this guard and every
    // programmatic/conditional callsite share one implementation.
    if (hasAllResourcePermissions(user, requiredPermissions)) {
      return true;
    }

    const userId = user.sub || user.userId || 'unknown';
    const granted = user.resourcePermissions || [];
    const missing = requiredPermissions.filter((p) => !granted.includes(p));
    this.logger.debug(`Permission denied for user ${userId}: missing [${missing.join(', ')}]`);
    throw new ForbiddenException('Access denied');
  }

  /**
   * Get user from request context (HTTP or GraphQL)
   */
  private getUser(context: ExecutionContext): UserWithPermissions | undefined {
    return getRequestFromArgumentsHost<{ user?: UserWithPermissions }>(context)?.user;
  }
}
