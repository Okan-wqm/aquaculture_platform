import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { SYSTEM_TENANT_ID } from './configuration.constants';

/**
 * The verified JWT principal as the GraphQL context carries it.
 *
 * WHY one module: `ConfigurationResolver` and `MarineProviderCredentialResolver`
 * gate on the same three facts — platform-admin role, tenantless SUPER_ADMIN,
 * verified user id. Deriving them here, once, is what keeps the generic
 * key/value surface and the provider-credential surface from drifting apart on
 * who may touch a company credential (the resolver docblock's "the two checks
 * can never drift apart" promise, now structural).
 */
export interface GraphQLPrincipalContext {
  req: {
    user?: {
      sub: string;
      /**
       * Absent/null for SUPER_ADMIN: it is the platform's only tenantless
       * principal by design (auth-service token-mint C1 invariant).
       */
      tenantId?: string | null;
      roles?: string[];
    };
  };
}

/**
 * Roles allowed to administer configuration. The same vocabulary gates both
 * the setConfiguration mutation and the tenantless system-scope resolution.
 */
export const PLATFORM_ADMIN_ROLES: readonly string[] = ['admin', 'platform_admin', 'SUPER_ADMIN'];

export function hasPlatformAdminRole(context: GraphQLPrincipalContext): boolean {
  const roles = context.req.user?.roles ?? [];
  return PLATFORM_ADMIN_ROLES.some((role) => roles.includes(role));
}

/**
 * Provider credential metadata and writes are an operations-only surface. A
 * tenant principal must not learn whether a company or legacy tenant
 * credential exists, which source won, or when it rotated. The only public
 * GraphQL exception is the tenantless SUPER_ADMIN system scope.
 */
export function isTenantlessSuperAdmin(context: GraphQLPrincipalContext): boolean {
  const user = context.req.user;
  return (
    user !== undefined &&
    (user.tenantId === undefined || user.tenantId === null) &&
    (user.roles ?? []).includes('SUPER_ADMIN')
  );
}

export function assertTenantlessSuperAdmin(context: GraphQLPrincipalContext): void {
  if (!isTenantlessSuperAdmin(context)) {
    throw new ForbiddenException(
      'Provider credentials are managed only by tenantless SUPER_ADMIN operations',
    );
  }
}

/**
 * Resolve the tenant scope exclusively from the verified JWT payload.
 * SECURITY: Never fall back to headers - JWT is the only trusted source.
 *
 * WHY the SYSTEM_TENANT_ID resolution for tenantless platform admins:
 * SUPER_ADMIN is the platform's only tenantless principal (auth-service
 * refuses to mint any other token without a tenant), and TenantGuard already
 * admits it in system scope. Platform-scope configuration rows are stored
 * under SYSTEM_TENANT_ID, so a tenantless platform admin reads and writes the
 * system rows — a tenant-scoped user still resolves ONLY from its verified
 * JWT tenant claim, and an authenticated non-admin without a tenant stays
 * rejected fail-closed.
 */
export function resolveTenantId(context: GraphQLPrincipalContext): string {
  const tenantId = context.req.user?.tenantId;
  if (tenantId) {
    return tenantId;
  }
  if (context.req.user && hasPlatformAdminRole(context)) {
    return SYSTEM_TENANT_ID;
  }
  throw new UnauthorizedException('Authentication required - tenant ID must come from JWT');
}

/**
 * Extract user ID exclusively from verified JWT payload.
 * SECURITY: Never fall back to headers or 'system' literal.
 */
export function requireUserId(context: GraphQLPrincipalContext): string {
  const userId = context.req.user?.sub;
  if (!userId) {
    throw new UnauthorizedException('Authentication required - user ID must come from JWT');
  }
  return userId;
}
