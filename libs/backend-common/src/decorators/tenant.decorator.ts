import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * Tenant Context Decorator
 * Extracts tenant ID from request context (headers, JWT, or query params)
 */
export const Tenant = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string => {
    const contextType = ctx.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(ctx);
      const request = gqlCtx.getContext().req;
      return extractTenantId(request);
    }

    const request = ctx.switchToHttp().getRequest();
    return extractTenantId(request);
  },
);

/**
 * Extract tenant ID from various sources
 */
function extractTenantId(request: any): string {
  // 1. Try from JWT payload (user object set by auth guard)
  if (request.user?.tenantId) {
    return request.user.tenantId;
  }

  // 2. Try from header
  const headerTenant = request.headers['x-tenant-id'];
  if (headerTenant) {
    return headerTenant;
  }

  // 3. Try from query parameter
  if (request.query?.tenantId) {
    return request.query.tenantId;
  }

  // 4. Try from body
  if (request.body?.tenantId) {
    return request.body.tenantId;
  }

  throw new Error('Tenant ID not found in request context');
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
        const request = gqlCtx.getContext().req;
        return extractTenantIdSafe(request);
      }

      const request = ctx.switchToHttp().getRequest();
      return extractTenantIdSafe(request);
    } catch {
      return undefined;
    }
  },
);

function extractTenantIdSafe(request: any): string | undefined {
  return (
    request.user?.tenantId ||
    request.headers['x-tenant-id'] ||
    request.query?.tenantId ||
    request.body?.tenantId ||
    undefined
  );
}
