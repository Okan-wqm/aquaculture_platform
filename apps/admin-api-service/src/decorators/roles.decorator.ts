/**
 * Roles Decorator
 * Role-based access control için decorator'lar
 */

import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * Endpoint'e erişebilecek rolleri belirler
 * @param roles - İzin verilen roller
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * TENANT_ADMIN, SUPER_ADMIN ve PLATFORM_ADMIN rollerine izin verir
 * Tenant-facing endpoint'ler için kullanılır
 */
export const AllowTenantAdmin = () =>
  Roles('TENANT_ADMIN', 'SUPER_ADMIN', 'PLATFORM_ADMIN');

/**
 * Sadece SUPER_ADMIN ve PLATFORM_ADMIN rollerine izin verir
 * Admin-only endpoint'ler için kullanılır
 */
export const PlatformAdminOnly = () => Roles('SUPER_ADMIN', 'PLATFORM_ADMIN');

/**
 * Tüm authenticated kullanıcılara izin verir
 * MODULE_USER dahil tüm roller erişebilir
 */
export const AllowAuthenticated = () =>
  Roles('SUPER_ADMIN', 'PLATFORM_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER', 'MODULE_USER');
