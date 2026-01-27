import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { SKIP_TENANT_GUARD_KEY } from '../decorators/roles.decorator';

/**
 * User payload structure from JWT
 */
interface JwtUser {
  sub: string;
  tenantId?: string;
  roles?: string[];
}

/**
 * Extended request with tenant and user context
 */
interface TenantRequest extends Request {
  user?: JwtUser;
  tenantId?: string;
}

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
    let request: TenantRequest;

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      request = gqlCtx.getContext().req as TenantRequest;
    } else {
      request = context.switchToHttp().getRequest<TenantRequest>();
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

  private extractTenantId(request: TenantRequest): string | undefined {
    const tenantHeader = request.headers['x-tenant-id'];
    const queryTenantId = request.query?.['tenantId'];
    const bodyTenantId = (request.body as Record<string, unknown>)?.['tenantId'];

    return (
      request.user?.tenantId ||
      (typeof tenantHeader === 'string' ? tenantHeader : undefined) ||
      (typeof queryTenantId === 'string' ? queryTenantId : undefined) ||
      (typeof bodyTenantId === 'string' ? bodyTenantId : undefined)
    );
  }
}
