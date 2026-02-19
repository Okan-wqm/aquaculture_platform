import { createParamDecorator, ExecutionContext, BadRequestException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { TenantRequest } from '../types/tenant-request.interface';

/**
 * Tenant Context Decorator
 * Extracts tenant ID from request context (headers, JWT, or query params)
 */
export const Tenant = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string => {
    const contextType = ctx.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(ctx);
      const request = gqlCtx.getContext().req as TenantRequest;
      return extractTenantId(request);
    }

    const request = ctx.switchToHttp().getRequest<TenantRequest>();
    return extractTenantId(request);
  },
);

/**
 * Extract tenant ID from various sources
 */
function extractTenantId(request: TenantRequest): string {
  // 1. Try from JWT payload (user object set by auth guard)
  if (request.user?.tenantId) {
    return request.user.tenantId;
  }

  // 2. Try from header
  const headerTenant = request.headers['x-tenant-id'];
  if (typeof headerTenant === 'string') {
    return headerTenant;
  }

  // 3. Try from query parameter
  const queryTenantId = request.query?.['tenantId'];
  if (typeof queryTenantId === 'string') {
    return queryTenantId;
  }

  // 4. Try from body
  const bodyTenantId = (request.body as Record<string, unknown>)?.['tenantId'];
  if (typeof bodyTenantId === 'string') {
    return bodyTenantId;
  }

  throw new BadRequestException('Tenant ID not found in request context');
}

/**
 * Optional Tenant Decorator - Returns undefined if not found
 */
export const OptionalTenant = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    try {
      const contextType = ctx.getType<string>();

      if (contextType === 'graphql') {
        const gqlCtx = GqlExecutionContext.create(ctx);
        const request = gqlCtx.getContext().req as TenantRequest;
        return extractTenantIdSafe(request);
      }

      const request = ctx.switchToHttp().getRequest<TenantRequest>();
      return extractTenantIdSafe(request);
    } catch {
      return undefined;
    }
  },
);

function extractTenantIdSafe(request: TenantRequest): string | undefined {
  const headerTenant = request.headers['x-tenant-id'];
  const queryTenantId = request.query?.['tenantId'];
  const bodyTenantId = (request.body as Record<string, unknown>)?.['tenantId'];

  return (
    request.user?.tenantId ||
    (typeof headerTenant === 'string' ? headerTenant : undefined) ||
    (typeof queryTenantId === 'string' ? queryTenantId : undefined) ||
    (typeof bodyTenantId === 'string' ? bodyTenantId : undefined)
  );
}

/**
 * @deprecated Use `Tenant` instead.
 * `CurrentTenant` is an alias kept only for backward compatibility with existing
 * callers. Migrate usages to `Tenant` and this alias will be removed in a future
 * major release.
 */
export { Tenant as CurrentTenant };
