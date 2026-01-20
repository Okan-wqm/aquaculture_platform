import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { SKIP_TENANT_GUARD_KEY } from '../decorators/roles.decorator';

/**
 * Tenant Guard
 * Ensures requests have valid tenant context and user belongs to tenant
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Check if guard should be skipped
    const skipGuard = this.reflector.getAllAndOverride<boolean>(
      SKIP_TENANT_GUARD_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (skipGuard) {
      return true;
    }

    const contextType = context.getType<string>();
    let request: any;

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      request = gqlCtx.getContext().req;
    } else {
      request = context.switchToHttp().getRequest();
    }

    const tenantId = this.extractTenantId(request);
    const user = request.user;

    // If no tenant ID in request, deny access
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    // If user is authenticated, verify tenant membership
    if (user) {
      if (user.tenantId !== tenantId) {
        throw new ForbiddenException('User does not belong to this tenant');
      }
    }

    // Store tenant ID in request for later use
    request.tenantId = tenantId;

    return true;
  }

  private extractTenantId(request: any): string | undefined {
    return (
      request.user?.tenantId ||
      request.headers['x-tenant-id'] ||
      request.query?.tenantId ||
      request.body?.tenantId
    );
  }
}
