import { createParamDecorator, ExecutionContext, BadRequestException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { TenantRequest } from '../types/tenant-request.interface';

/**
 * Tenant Context Decorator — extracts the authenticated tenant ID from the request.
 *
 * SECURITY (C-03): This decorator ONLY reads from trusted server-set sources:
 *   1. `req.farmVerifiedIdentity.effectiveTenantId` — gateway-signed farm identity.
 *   2. `req.tenantId` — set by tenant middleware or TenantGuard.
 *   3. `req.user.tenantId` — set from verified JWT/assertion context.
 *
 * Headers (X-Tenant-Id), query parameters, and request body are NEVER consulted.
 * Those sources are attacker-controlled and were previously exploitable when
 * combined with @SkipTenantGuard() to inject arbitrary tenant IDs.
 */
export const Tenant = createParamDecorator((data: unknown, ctx: ExecutionContext): string => {
  const contextType = ctx.getType<string>();

  if (contextType === 'graphql') {
    const gqlCtx = GqlExecutionContext.create(ctx);
    const request = gqlCtx.getContext().req as TenantRequest;
    return extractTenantId(request);
  }

  const request = ctx.switchToHttp().getRequest<TenantRequest>();
  return extractTenantId(request);
});

/**
 * Extract tenant ID exclusively from trusted, server-set sources.
 *
 * SECURITY: Only server-set sources are trusted:
 *   - `req.farmVerifiedIdentity.effectiveTenantId`: Signed gateway assertion.
 *   - `req.tenantId`: Explicitly set by tenant middleware or TenantGuard.
 *   - `req.user.tenantId`: Decoded from verified JWT/assertion context.
 *
 * All other sources (headers, query params, body) are untrusted and intentionally
 * excluded to prevent tenant spoofing attacks.
 */
function extractTenantId(request: TenantRequest): string {
  // Prefer the effective tenant set by TenantGuard/FarmVerifiedIdentity.
  // This preserves audited X-Act-As-Tenant behavior for SUPER_ADMIN.
  if (request.farmVerifiedIdentity?.effectiveTenantId) {
    return request.farmVerifiedIdentity.effectiveTenantId;
  }

  if (request.tenantId) {
    return request.tenantId;
  }

  if (request.user?.tenantId) {
    return request.user.tenantId;
  }

  throw new BadRequestException(
    'Tenant ID not found in request context. Ensure the request is authenticated and the tenant guard has executed.',
  );
}

/**
 * Optional Tenant Decorator — returns the authenticated tenant ID or undefined.
 *
 * SECURITY (C-03): Same trusted-source-only policy as @Tenant(). Never reads
 * from headers, query params, or request body. Returns undefined instead of
 * throwing when no tenant context is available.
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

/**
 * Safe tenant ID extraction from trusted sources only.
 * Returns undefined when no tenant context is available.
 */
function extractTenantIdSafe(request: TenantRequest): string | undefined {
  return (
    request.farmVerifiedIdentity?.effectiveTenantId ||
    request.tenantId ||
    request.user?.tenantId ||
    undefined
  );
}

/**
 * @deprecated Use `Tenant` instead.
 * `CurrentTenant` is an alias kept only for backward compatibility with existing
 * callers. Migrate usages to `Tenant` and this alias will be removed in a future
 * major release.
 */
export { Tenant as CurrentTenant };
