import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { SKIP_TENANT_GUARD_KEY, IS_PUBLIC_KEY } from '../decorators/roles.decorator';
import { TenantRequest } from '../types/tenant-request.interface';

/**
 * Tenant Guard
 * Ensures requests have valid tenant context and user belongs to tenant.
 *
 * Skip behaviour:
 * - `@SkipTenantGuard()` – explicitly skips tenant validation for a single route
 *   that still requires authentication.
 * - `@Public()` – marks the endpoint as publicly accessible; TenantGuard checks
 *   both the `skipTenantGuard` AND the `isPublic` metadata keys so that applying
 *   either decorator (or the combined `@Public()`) is sufficient to bypass tenant
 *   validation. Developers do NOT need to apply `@SkipTenantGuard()` separately
 *   when using `@Public()`.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Skip if endpoint is marked public
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    // Skip if explicitly annotated with @SkipTenantGuard()
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

    // Validate tenant ID is a valid UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(tenantId)) {
      throw new BadRequestException('Tenant ID must be a valid UUID');
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
