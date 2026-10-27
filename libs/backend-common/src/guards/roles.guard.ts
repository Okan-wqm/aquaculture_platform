import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ROLES_KEY, Role, IS_PUBLIC_KEY, roleHasPermission } from '../decorators/roles.decorator';
import { CurrentUserPayload } from '../decorators/current-user.decorator';
import { resolveHandlerAccess } from '../security/access-caller';
import type { AccessEnrolledService, AccessEnrolmentMode } from '../security/access-enrolment';
import { readHandlerAccess } from '../security/handler-access';

/**
 * The enrolment a RolesGuard decides under (ADR-051 §3). `accessGuardProviders` constructs the
 * guard with its service's entry of MODULE_ACCESS_ENROLMENT; nothing provides this token to
 * dependency injection, so a guard Nest builds for `@UseGuards(RolesGuard)` has none and decides
 * as an `account-role` guard, exactly as before ADR-051. The adoption invariant forbids that
 * per-handler use in a `module-access` service.
 */
export const ROLES_GUARD_ENROLMENT = Symbol('ROLES_GUARD_ENROLMENT');

export interface RolesGuardEnrolment {
  readonly service: AccessEnrolledService;
  readonly mode: AccessEnrolmentMode;
}

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
 * Two modes, chosen by the service's MODULE_ACCESS_ENROLMENT entry (ADR-051 §3):
 * - `account-role` (every service in R1, and any guard built without an enrolment): `@Roles`
 *   against the token's `role`/`roles` through the one hierarchy, unchanged.
 * - `module-access` (RBAC-HIGH-031): the handler's `@Access` spec is decided by `decideAccess`
 *   with `@Roles` checked by kind — MODULE_MANAGER and MODULE_USER by the caller's role in the
 *   spec's module, TENANT_ADMIN and SUPER_ADMIN by the account role — so the global
 *   `users.role` never grants module access. The decision is recomputed by `@AccessCaller()` and
 *   never stored on `req`, which sibling root fields share.
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
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional()
    @Inject(ROLES_GUARD_ENROLMENT)
    private readonly enrolment?: RolesGuardEnrolment,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.enrolment !== undefined && this.enrolment.mode === 'module-access') {
      return this.canActivateByModuleAccess(context, this.enrolment.service);
    }
    return this.canActivateByAccountRole(context);
  }

  /**
   * ADR-051 §3 step 2: a handler whose most specific declaration is `@Public()` passes (a
   * handler's own `@Access` beats a class-level `@Public()`, handler-access.ts); every other
   * handler is decided from its own metadata and the verified user (403 on deny or no `@Access`,
   * 400 on a malformed claim).
   */
  private canActivateByModuleAccess(
    context: ExecutionContext,
    service: AccessEnrolledService,
  ): boolean {
    if (readHandlerAccess(this.reflector, context).isPublic) return true;
    resolveHandlerAccess(this.reflector, context, service);
    return true;
  }

  /** The decision of every service before ADR-051 enrols it, unchanged. */
  private canActivateByAccountRole(context: ExecutionContext): boolean {
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
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      return gqlCtx.getContext().req?.user as UserWithRoles | undefined;
    }

    return context.switchToHttp().getRequest()?.user as UserWithRoles | undefined;
  }
}
