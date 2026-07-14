/**
 * Roles Decorator
 * Role-based access control için decorator'lar
 */

import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * Endpoint'e erişebilecek rolleri belirler
 * @param roles - İzin verilen roller
 */
export const Roles = (...roles: string[]): CustomDecorator<string> => SetMetadata(ROLES_KEY, roles);

/**
 * Sadece platform admin operatorune izin verir (auth role: SUPER_ADMIN).
 * Admin-only endpoint'ler için kullanılır.
 *
 * RBAC-LOW-001: this replaced the misnamed `AllowTenantAdmin` alias. That name
 * suggested tenant-admin access but resolved to SUPER_ADMIN — a latent trap: a
 * maintainer "fixing" the name toward real TENANT_ADMIN access, combined with
 * the tenant-scoped `req.user.tenantId` reads on some admin endpoints, could
 * open cross-tenant writes. The admin-api boundary is platform-admin only; there
 * is no tenant-facing authorization here, and the name now says so.
 */
export const PlatformAdminOnly = (): CustomDecorator<string> => Roles('SUPER_ADMIN');

/**
 * Admin API'de authenticated genisletmesi kullanilmaz; bu boundary platform
 * admin ile sabitlenir.
 */
export const AllowAuthenticated = (): CustomDecorator<string> =>
  Roles('SUPER_ADMIN');
