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
 * Admin API platform-admin boundary'dir. Auth domain'de bu platform rolu
 * SUPER_ADMIN olarak saklanir; tenant-facing yetki genisletmesi burada yoktur.
 */
export const AllowTenantAdmin = (): CustomDecorator<string> =>
  Roles('SUPER_ADMIN');

/**
 * Sadece platform admin operatorune izin verir (auth role: SUPER_ADMIN)
 * Admin-only endpoint'ler için kullanılır
 */
export const PlatformAdminOnly = (): CustomDecorator<string> => Roles('SUPER_ADMIN');

/**
 * Admin API'de authenticated genisletmesi kullanilmaz; bu boundary platform
 * admin ile sabitlenir.
 */
export const AllowAuthenticated = (): CustomDecorator<string> =>
  Roles('SUPER_ADMIN');
