import 'reflect-metadata';
import { ROLES_KEY, Role } from '@aquaculture/backend-common/decorators';

import { TenantAdminResolver } from '../resolvers/tenant-admin.resolver';

/**
 * Verify that TenantAdminResolver methods have proper auth guards.
 *
 * NestJS SetMetadata stores metadata on the method function itself (not on
 * target + propertyKey). We retrieve the descriptor value to read it type-safely.
 */
describe('TenantAdminResolver — Guard Decorators', () => {
  function getMethodRoles(prototype: object, methodName: string): Role[] | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
    if (!descriptor?.value) return undefined;
    return Reflect.getMetadata(ROLES_KEY, descriptor.value as object) as Role[] | undefined;
  }

  it('myModules should require at least MODULE_USER role', () => {
    const roles = getMethodRoles(TenantAdminResolver.prototype, 'myModules');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.MODULE_USER);
    expect(roles).toContain(Role.MODULE_MANAGER);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).toContain(Role.SUPER_ADMIN);
  });

  it('moduleUsers should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(TenantAdminResolver.prototype, 'moduleUsers');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  // SEC-HIGH-051: the new site-assignment write-path must carry the SAME
  // TenantAdminOrHigher gate as the module-assignment management precedent.
  it('assignUserToSite should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(TenantAdminResolver.prototype, 'assignUserToSite');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_MANAGER);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  it('unassignUserFromSite should require TenantAdminOrHigher', () => {
    const roles = getMethodRoles(TenantAdminResolver.prototype, 'unassignUserFromSite');
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_USER);
  });

  // ADR-042: the tenant auth-security policy + localization surfaces are
  // TENANT_ADMIN-gated writes/reads on the caller's OWN tenant.
  it.each([
    'tenantSecurityPolicy',
    'updateTenantSecurityPolicy',
    'tenantLocalizationPreferences',
    'updateTenantLocalizationPreferences',
  ])('%s should require TenantAdminOrHigher', (method) => {
    const roles = getMethodRoles(TenantAdminResolver.prototype, method);
    expect(roles).toBeDefined();
    expect(roles).toContain(Role.SUPER_ADMIN);
    expect(roles).toContain(Role.TENANT_ADMIN);
    expect(roles).not.toContain(Role.MODULE_MANAGER);
    expect(roles).not.toContain(Role.MODULE_USER);
  });
});
