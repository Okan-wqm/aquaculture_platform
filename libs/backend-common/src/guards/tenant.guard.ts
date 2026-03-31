import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { SKIP_TENANT_GUARD_KEY, IS_PUBLIC_KEY, Role } from '../decorators/roles.decorator';
import { TenantRequest } from '../types/tenant-request.interface';

/** UUID v4 format validator. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenant Guard — enforces tenant isolation for every authenticated request.
 *
 * SECURITY (C-04): Tenant ID sources have been reduced to the minimum trusted set:
 *
 *   **Regular users** — The ONLY accepted source is `req.user.tenantId`, decoded
 *   from a cryptographically verified JWT by JwtAuthGuard. Query parameters,
 *   request body, and ALL headers (including X-Tenant-Id) are intentionally
 *   excluded. An authenticated user can trivially set any of those values, so
 *   accepting them would allow tenant context spoofing.
 *
 *   **SUPER_ADMIN** — May impersonate a specific tenant via the dedicated
 *   `X-Act-As-Tenant` header. This header is validated for UUID format and
 *   audit-logged with userId, source tenant, target tenant, endpoint, and
 *   timestamp. The generic X-Tenant-Id header is NOT accepted even for super
 *   admins to maintain a single, auditable impersonation vector.
 *
 * Skip behaviour:
 * - `@SkipTenantGuard()` skips tenant validation for a single route that
 *   still requires authentication.
 * - `@Public()` marks the endpoint as publicly accessible; TenantGuard
 *   checks both `skipTenantGuard` and `isPublic` metadata so either
 *   decorator is sufficient to bypass tenant validation.
 *
 * SECURITY (H-13): SUPER_ADMIN cross-tenant access is audit-logged with
 * userId, sourceTenantId, targetTenantId, endpoint, and timestamp.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

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

    const user = request.user;

    // ---------------------------------------------------------------
    // SUPER_ADMIN: operates in system scope, no tenant enforcement.
    // May impersonate a tenant via the dedicated X-Act-As-Tenant header.
    //
    // SECURITY (H-13): Cross-tenant access is mandatory audit-logged.
    // ---------------------------------------------------------------
    if (this.isSuperAdmin(user)) {
      const actAsTenant = this.extractActAsTenantHeader(request);
      if (actAsTenant) {
        if (!UUID_REGEX.test(actAsTenant)) {
          throw new BadRequestException(
            'X-Act-As-Tenant header must be a valid UUID',
          );
        }
        request.tenantId = actAsTenant;

        // Audit log when SUPER_ADMIN accesses a different tenant's data
        const sourceTenantId = user?.tenantId ?? 'system';
        if (actAsTenant !== sourceTenantId) {
          this.logger.warn('SUPER_ADMIN cross-tenant access', {
            userId: user?.sub,
            sourceTenantId,
            targetTenantId: actAsTenant,
            endpoint: `${request.method} ${request.url}`,
            timestamp: new Date().toISOString(),
          });
        }
      }
      return true;
    }

    // ---------------------------------------------------------------
    // Regular users: tenant ID comes EXCLUSIVELY from the JWT claim.
    // Headers, query params, and body are never consulted.
    // ---------------------------------------------------------------
    const tenantId = user?.tenantId;

    if (!tenantId) {
      throw new BadRequestException(
        'Tenant ID is required. The JWT must contain a valid tenantId claim.',
      );
    }

    if (!UUID_REGEX.test(tenantId)) {
      throw new BadRequestException('Tenant ID must be a valid UUID');
    }

    // Store validated tenant ID in request for downstream consumers
    request.tenantId = tenantId;

    return true;
  }

  /**
   * Check if the user has SUPER_ADMIN role.
   * Supports both the `roles` array and the deprecated `role` string field.
   */
  private isSuperAdmin(user?: TenantRequest['user']): boolean {
    if (!user) return false;
    if (user.roles?.includes(Role.SUPER_ADMIN)) return true;
    if (user.role === Role.SUPER_ADMIN) return true;
    return false;
  }

  /**
   * Extract the X-Act-As-Tenant header for SUPER_ADMIN tenant impersonation.
   *
   * SECURITY (C-04): This is the ONLY mechanism for super admins to specify a
   * target tenant. The generic X-Tenant-Id header, query params, and request
   * body are intentionally excluded to maintain a single auditable impersonation
   * vector and eliminate confusion with attacker-controlled inputs.
   */
  private extractActAsTenantHeader(request: TenantRequest): string | undefined {
    const header = request.headers['x-act-as-tenant'];
    return typeof header === 'string' ? header : undefined;
  }
}
