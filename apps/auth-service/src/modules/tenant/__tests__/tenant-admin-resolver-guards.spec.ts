import 'reflect-metadata';
import { ROLES_KEY, Role } from '@platform/backend-common';

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
});
