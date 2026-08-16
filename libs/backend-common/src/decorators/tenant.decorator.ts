import { createParamDecorator, ExecutionContext, BadRequestException } from '@nestjs/common';

import { getRequestFromArgumentsHost } from '../context/execution-context-request';
import { TenantRequest } from '../types/tenant-request.interface';

/**
 * Tenant Context Decorator — extracts the authenticated tenant ID from the request.
 *
 * SECURITY (C-03): This decorator ONLY reads from two trusted sources:
 *   1. `req.user.tenantId` — set by JwtAuthGuard from the verified JWT claim.
 *   2. `req.tenantId` — set by TenantGuard after validation.
 *
 * Headers (X-Tenant-Id), query parameters, and request body are NEVER consulted.
 * Those sources are attacker-controlled and were previously exploitable when
 * combined with @SkipTenantGuard() to inject arbitrary tenant IDs.
 */
export const Tenant = createParamDecorator((data: unknown, ctx: ExecutionContext): string => {
  const request = getRequestFromArgumentsHost<TenantRequest>(ctx);
  if (!request) {
    throw new BadRequestException('Request context is unavailable');
  }
  return extractTenantId(request);
});

/**
 * Extract tenant ID exclusively from trusted, server-set sources.
 *
 * SECURITY: Only two sources are trusted:
 *   - `req.user.tenantId`: Decoded from a cryptographically verified JWT by JwtAuthGuard.
 *   - `req.tenantId`: Explicitly set by TenantGuard after validating the user's
 *     JWT tenantId claim (or SUPER_ADMIN's X-Act-As-Tenant header).
 *
 * All other sources (headers, query params, body) are untrusted and intentionally
 * excluded to prevent tenant spoofing attacks.
 */
function extractTenantId(request: TenantRequest): string {
  // 1. Prefer JWT claim — cryptographically verified by JwtAuthGuard
  if (request.user?.tenantId) {
    return request.user.tenantId;
  }

  // 2. Fall back to TenantGuard-validated value
  if (request.tenantId) {
    return request.tenantId;
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
      const request = getRequestFromArgumentsHost<TenantRequest>(ctx);
      return request ? extractTenantIdSafe(request) : undefined;
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
  return request.user?.tenantId || request.tenantId || undefined;
}

/**
 * @deprecated Use `Tenant` instead.
 * `CurrentTenant` is an alias kept only for backward compatibility with existing
 * callers. Migrate usages to `Tenant` and this alias will be removed in a future
 * major release.
 */
export { Tenant as CurrentTenant };
