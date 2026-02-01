import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ROLES_KEY, Role, IS_PUBLIC_KEY } from '../decorators/roles.decorator';
import { CurrentUserPayload } from '../decorators/current-user.decorator';

/**
 * Roles Guard
 * Checks if user has required role(s) to access a resource
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

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

    // SECURITY FIX: Always require authenticated user unless endpoint is public
    // Previously, empty roles allowed unauthenticated access which was a security gap
    if (!requiredRoles || requiredRoles.length === 0) {
      // Require at least an authenticated user when no specific roles are defined
      if (!user) {
        throw new ForbiddenException('Authentication required');
      }
      return true;
    }

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Super admin has access to everything
    if (user.roles.includes(Role.SUPER_ADMIN)) {
      return true;
    }

    // Check if user has at least one required role
    const hasRole = requiredRoles.some((role) => user.roles.includes(role));

    if (!hasRole) {
      throw new ForbiddenException(
        `Access denied. Required roles: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }

  private getUser(context: ExecutionContext): CurrentUserPayload | undefined {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      return gqlCtx.getContext().req?.user;
    }

    return context.switchToHttp().getRequest()?.user;
  }
}
